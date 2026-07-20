#!/usr/bin/env node
// index.js —— 程序入口与交互界面（REPL）。
// 负责：启动横幅、初始化 MCP、斜杠命令、像 Claude Code 那样的权限确认、
//       流式输出渲染、把一切接到 agent loop 上。

import OpenAI from "openai";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runAgentTurn, DEFAULT_SYSTEM } from "./agent.js";
import { tools as builtinTools, handlers, needsConfirm, setWorkspace, getWorkspace } from "./tools.js";
import { McpManager } from "./mcp.js";
import { compact, estimateTokens } from "./context.js";
import { makeSubagentTool } from "./subagent.js";
import { loadSkills, skillsSection, makeSkillTool } from "./skills.js";
import { newSessionId, saveSession, loadSession, listSessions } from "./session.js";
import { buildAgentContext } from "./setup.js";
import { ToolRegistry } from "./core/registry.js";
import * as ui from "./ui.js";

const { c, paint } = ui;
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

// 工作目录沙箱根：默认当前目录，可用环境变量覆盖。所有文件操作被限制在此目录内。
const WORKSPACE = process.env.MINICODE_WORKSPACE || process.cwd();
setWorkspace(WORKSPACE);

// ── 鉴权 ─────────────────────────────────────────────────────────────
if (!process.env.DEEPSEEK_API_KEY) {
  console.error(paint(c.red, "✗ 未检测到环境变量 DEEPSEEK_API_KEY。"));
  console.error(paint(c.dim, '  PowerShell：  $env:DEEPSEEK_API_KEY = "sk-..."  然后 npm start'));
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
  maxRetries: 3,      // 429 / 5xx / 网络错误自动退避重试
  timeout: 120_000,   // 单次请求最长 2 分钟
});

// 超过这个上下文 token 数就自动压缩历史（可用环境变量覆盖）
const COMPACT_AT = Number(process.env.MINICODE_COMPACT_AT) || 40000;

const rl = readline.createInterface({ input: stdin, output: stdout });

// 输入队列：始终监听 line 事件并缓存，question 从队列取。
// 这样即使输入（管道/快速粘贴）在我们还没开始读时就到达，也不会丢；
// 也让"确认提示"在管道场景下能正常读到 y/n。
const lineQueue = [];
const waiters = [];
let stdinClosed = false;
rl.on("line", (l) => {
  if (waiters.length) waiters.shift()(l);
  else lineQueue.push(l);
});
rl.on("close", () => {
  stdinClosed = true;
  while (waiters.length) waiters.shift()(null);
});
// 读取一行（带提示）。stdin 结束时返回 null。
function ask(prompt = "") {
  if (prompt) stdout.write(prompt);
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  if (stdinClosed) return Promise.resolve(null);
  return new Promise((res) => waiters.push(res));
}

//const answer = await ask("请输入：");
//ask() 创建并返回了一个 Promise（空盒子）。
//await 拿到并扣留了这个盒子。
//res(l) 触发，把 l（内容） 发送给了这个盒子。
//await 看到盒子满了，自动开箱取出 l，交给了 answer。

// ── 主程序 ───────────────────────────────────────────────────────────
async function main() {
  // 当前回合的中断控制器（Ctrl+C 时 abort）
  let currentAbort = null;
  // 当前会话 id（每轮自动保存到 .sessions/<id>.json）
  let currentSessionId = newSessionId();

  // 1) 装配 agent 上下文（MCP / 子 agent / Skills / dispatch / 系统提示）
  const stop = ui.startSpinner("连接 MCP 服务器");
  const {
    mcp, dispatch, allTools, skills, systemPrompt, baseConfirmNeeded,
    isParallelSafe, toolPolicies, statePrompt, planState,
  } = await buildAgentContext({
    client, model: MODEL,
    getSignal: () => currentAbort?.signal,
    onSubStep: (n, a, label) => console.log(paint(c.dim, `     ↳ 子助手${label || ""} ${n} ${a.pattern || a.path || ""}`)),
  });
  stop();
  const hasMcp = mcp.tools.length > 0;
  // 单进程模式也统一经过 ToolRegistry，避免与 daemon 的校验、超时和重试语义不一致。
  const registry = new ToolRegistry({
    dispatch,
    tools: allTools,
    policies: toolPolicies,
    onEvent: (ev) => {
      if (ev.type === "retry") console.log(paint(c.yellow, `  ↻ ${ev.name} 第 ${ev.attempt} 次重试：${ev.message}`));
    },
  });

  // 空闲时 Ctrl+C 退出；生成中 Ctrl+C 打断（中断在下方 turn 里处理）
  rl.on("SIGINT", () => {
    if (currentAbort) currentAbort.abort();
    else { console.log(paint(c.dim, "\n再见！")); mcp.closeAll().finally(() => process.exit(0)); }
  });

  // 3) 权限策略：写操作和所有 MCP 工具默认需确认；用户可选"本会话不再询问"
  const sessionAllow = new Set();
  function confirmNeeded(name) {
    if (process.env.MINICODE_YES) return false; // 自动批准模式
    if (sessionAllow.has(name)) return false;
    return baseConfirmNeeded(name);
  }

  // 4) 界面回调（agent loop 在各阶段调用它们）
  /** @type {null | (() => void)} */
  let spinnerStop = null;
  let streaming = false;

  const callbacks = {
    onWaitStart() {
      spinnerStop = ui.startSpinner("thinking");
    },
    onWaitEnd() {
      if (spinnerStop) { spinnerStop(); spinnerStop = null; }
    },
    onToken(t) {
      if (!streaming) { stdout.write("\n" + paint(c.green + c.bold, "● ")); streaming = true; }
      stdout.write(t);
    },
    onTextEnd() {
      if (streaming) { stdout.write("\n"); streaming = false; }
    },
    onToolUse(name, args) {
      const isSub = name === "spawn_agent" || name === "spawn_agents";
      const label = isSub ? paint(c.cyan, "🤖 " + name)
        : mcp.isMcpTool(name) ? paint(c.blue, name) : paint(c.magenta, name);
      const arg =
        name === "run_command" ? args.command :
        name === "grep" || name === "glob" ? args.pattern :
        name === "spawn_agent" ? args.task :
        name === "spawn_agents" ? `${args.tasks?.length || 0} 个并行子任务` :
        args.path ?? "";
      console.log("\n" + paint(c.dim, "⚙ ") + label + paint(c.dim, arg ? `  ${arg}` : ""));
      // 改文件时先把 diff 显示出来，让用户看清改了什么
      if (name === "edit_file" && args.old_str != null) {
        console.log(ui.renderDiff(args.old_str, args.new_str ?? ""));
      } else if (name === "write_file" && args.content != null) {
        console.log(paint(c.green, ui.indent(ui.truncate(args.content, 300), "  + ")));
      }
    },
    onToolResult(name, result, { isError }) {
      const head = isError ? paint(c.red, "  ↳ ") : paint(c.dim, "  ↳ ");
      console.log(head + ui.indent(ui.truncate(result, 800)).trimStart());
    },
    async confirm(name, args) {
      const detail =
        name === "run_command" ? args.command :
        name === "grep" || name === "glob" ? args.pattern :
        args.path ?? JSON.stringify(args);
      const ans = (await ask(
        paint(c.yellow, `  ⚠ 允许 ${name} → ${detail} ?  `) +
        paint(c.dim, "[y]是 [a]是且不再问 [n]否 ")
      )) ?? "";
      const k = ans.trim().toLowerCase();
      if (k === "a") { sessionAllow.add(name); return true; }
      return k === "y";
    },
  };

  // 5) 启动横幅
  console.log("\n" + ui.banner({ model: MODEL, toolCount: allTools.length, mcp: hasMcp, cwd: getWorkspace() }));
  const past = listSessions();
  if (past.length) console.log(paint(c.dim, `  有 ${past.length} 个历史会话 · /sessions 查看 · /resume 恢复最近一次`));

  const messages = []; // 对话历史（跨多轮的"记忆"）

  // 会话级用量统计
  let sessionIn = 0, sessionOut = 0, ctxTokens = 0;

  // 执行一次历史压缩（自动或手动 /compact 都走这里）
  async function doCompact(reason = "") {
    const stop = ui.startSpinner("压缩上下文");
    let newMsgs = null;
    try {
      newMsgs = await compact(client, MODEL, messages, { keepTurns: 2 });
    } catch (e) {
      stop();
      console.log(paint(c.red, "  压缩失败：" + e.message));
      return false;
    }
    stop();
    if (!newMsgs) { console.log(paint(c.dim, "  （历史还很短，无需压缩）")); return false; }
    const before = messages.length;
    messages.length = 0;
    messages.push(...newMsgs);
    ctxTokens = 0; // 压缩后真实大小等下一轮再测
    console.log(paint(c.dim, `  ✦ 已压缩上下文${reason ? "（" + reason + "）" : ""}：${before} → ${messages.length} 条消息`));
    return true;
  }

  // 每轮结束后的状态行
  function statusLine() {
    const ctx = ctxTokens ? `~${ctxTokens}` : "?";
    console.log(paint(c.dim, `  ─ 上下文 ${ctx} tok · 本会话 in ${sessionIn} / out ${sessionOut} tok`));
  }

  // ── 会话持久化辅助 ──
  function firstTitle() {
    const u = messages.find((m) => m.role === "user" && typeof m.content === "string");
    return u ? u.content.slice(0, 30) : "";
  }
  function saveCurrent(title) {
    try {
      saveSession(currentSessionId, { model: MODEL, title: title || firstTitle(), messages, sessionIn, sessionOut });
    } catch (e) { console.log(paint(c.red, "  保存会话失败：" + e.message)); }
  }
  function doResume(id) {
    const target = id || listSessions()[0]?.id;
    if (!target) { console.log(paint(c.dim, "  没有可恢复的会话。")); return; }
    const s = loadSession(target);
    if (!s) { console.log(paint(c.dim, `  未找到会话 ${target}`)); return; }
    messages.length = 0;
    messages.push(...(s.messages || []));
    planState.clear();
    sessionIn = s.sessionIn || 0; sessionOut = s.sessionOut || 0; ctxTokens = 0;
    currentSessionId = s.id;
    console.log(paint(c.green, `  ✦ 已恢复会话 ${s.id}`) + paint(c.dim, `（${messages.length} 条消息）`));
  }
  function printSessions() {
    const list = listSessions();
    if (!list.length) { console.log(paint(c.dim, "暂无历史会话。")); return; }
    console.log(ui.box([paint(c.bold, "历史会话（/resume <id> 恢复，留空恢复最近）"),
      ...list.slice(0, 10).map((s) => paint(c.cyan, s.id) + paint(c.dim, `  ${s.msgCount}条  ${s.title}`))], { color: c.gray }));
  }

  // 6) REPL 主循环
  while (true) {
    const input = await ask("\n" + paint(c.cyan + c.bold, "› "));
    if (input === null) break; // stdin 关闭
    const text = input.trim();
    if (!text) continue;

    // 斜杠命令（不发给模型，本地处理）
    if (text.startsWith("/") || text === "exit" || text === "quit") {
      const parts = text.replace(/^\//, "").split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const arg = parts.slice(1).join(" ");
      if (cmd === "exit" || cmd === "quit") break;
      if (cmd === "help") { printHelp(); continue; }
      if (cmd === "clear") { messages.length = 0; planState.clear(); sessionIn = sessionOut = ctxTokens = 0; console.log(paint(c.dim, "（已清空对话历史）")); continue; }
      if (cmd === "tools") { printTools(allTools, mcp); continue; }
      if (cmd === "mcp") { printMcp(mcp); continue; }
      if (cmd === "skills") {
        if (!skills.length) { console.log(paint(c.dim, "未配置技能（在 skills/<名字>/SKILL.md 添加）。")); continue; }
        console.log(ui.box([paint(c.bold, "技能"), ...skills.map((s) => paint(c.cyan, s.name) + paint(c.dim, `  ${s.description}`))], { color: c.gray }));
        continue;
      }
      if (cmd === "compact") { await doCompact("手动"); continue; }
      if (cmd === "usage") {
        console.log(ui.box([
          paint(c.bold, "用量"),
          `当前上下文  ~${ctxTokens} tok`,
          `本会话累计  输入 ${sessionIn} / 输出 ${sessionOut} tok`,
          `历史消息    ${messages.length} 条`,
          `自动压缩阈值 ${COMPACT_AT} tok`,
        ], { color: c.gray }));
        continue;
      }
      if (cmd === "save") { saveCurrent(arg); console.log(paint(c.dim, `  已保存会话 ${currentSessionId}`)); continue; }
      if (cmd === "sessions") { printSessions(); continue; }
      if (cmd === "resume") { doResume(arg); continue; }
      console.log(paint(c.dim, `未知命令 /${cmd}，输入 /help 查看。`));
      continue;
    }

    messages.push({ role: "user", content: text });
    currentAbort = new AbortController();
    try {
      const usage = await runAgentTurn(client, messages, {
        model: MODEL,
        tools: allTools,
        dispatch: (name, args, context) => registry.run(name, args, context),
        confirmNeeded,
        parallelSafe: isParallelSafe,
        statePrompt,
        compactIfNeeded: async () => {
          if (estimateTokens(messages) <= COMPACT_AT) return false;
          return doCompact("单轮执行中超过阈值");
        },
        ui: callbacks,
        signal: currentAbort.signal,
        system: systemPrompt,
      });
      if (usage?.aborted) console.log(paint(c.yellow, "\n  ⎋ 已中断当前回合"));
      if (usage) {
        sessionIn += usage.turnInput || 0;
        sessionOut += usage.turnOutput || 0;
        ctxTokens = usage.lastPromptTokens || ctxTokens;
      }
      statusLine();
      // 上下文超阈值就自动压缩
      if (ctxTokens > COMPACT_AT) await doCompact("超过阈值，自动");
      saveCurrent(); // 每轮自动保存会话
    } catch (err) {
      if (spinnerStop) { spinnerStop(); spinnerStop = null; }
      streaming = false;
      console.error(paint(c.red, `\n✗ 出错：${err.message}`));
      if (messages.at(-1)?.role === "user") messages.pop();
    } finally {
      currentAbort = null;
    }
  }

  await mcp.closeAll();
  rl.close();
  console.log(paint(c.dim, "\n再见！"));
}

// ── 斜杠命令的输出 ───────────────────────────────────────────────────
function printHelp() {
  console.log(ui.box([
    paint(c.bold, "命令"),
    paint(c.cyan, "/help") + paint(c.dim, "     显示这个帮助"),
    paint(c.cyan, "/tools") + paint(c.dim, "    列出所有可用工具"),
    paint(c.cyan, "/skills") + paint(c.dim, "   列出可用技能"),
    paint(c.cyan, "/mcp") + paint(c.dim, "      查看 MCP 服务器状态"),
    paint(c.cyan, "/usage") + paint(c.dim, "    查看 token 用量"),
    paint(c.cyan, "/compact") + paint(c.dim, "  手动压缩对话历史"),
    paint(c.cyan, "/sessions") + paint(c.dim, " 列出历史会话"),
    paint(c.cyan, "/resume") + paint(c.dim, "   恢复会话（/resume <id>，留空恢复最近）"),
    paint(c.cyan, "/save") + paint(c.dim, "     保存当前会话（可加标题）"),
    paint(c.cyan, "/clear") + paint(c.dim, "    清空对话历史"),
    paint(c.cyan, "exit") + paint(c.dim, "      退出"),
  ], { color: c.gray }));
}

function printTools(allTools, mcp) {
  const lines = [paint(c.bold, "可用工具")];
  for (const t of allTools) {
    const n = t.function.name;
    const tag = mcp.isMcpTool(n) ? paint(c.blue, "[MCP]") : paint(c.magenta, "[内置]");
    lines.push(`${tag} ${paint(c.cyan, n)}`);
  }
  console.log(ui.box(lines, { color: c.gray }));
}

function printMcp(mcp) {
  if (!mcp.status.length) {
    console.log(paint(c.dim, "未配置 MCP 服务器（编辑 mcp.json 添加）。"));
    return;
  }
  const lines = [paint(c.bold, "MCP 服务器")];
  for (const s of mcp.status) {
    if (s.ok) lines.push(paint(c.green, "● ") + s.name + paint(c.dim, `  ${s.toolCount} 个工具: ${s.tools.join(", ")}`));
    else lines.push(paint(c.red, "● ") + s.name + paint(c.dim, `  连接失败: ${s.error}`));
  }
  console.log(ui.box(lines, { color: c.gray }));
}

main();
