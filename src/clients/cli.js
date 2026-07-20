// clients/cli.js —— 瘦 CLI 客户端：连接 minicode-core，把事件流以朴素行式打印。
import { runRepl } from "./client.js";
import * as ui from "../ui.js";
import { stdout } from "node:process";

const { c, paint } = ui;
let streaming = false;
let spinnerStop = null;

function startSpinner() {
  if (!spinnerStop) spinnerStop = ui.startSpinner("processing");
}

function stopSpinner() {
  if (!spinnerStop) return;
  spinnerStop();
  spinnerStop = null;
}

const argOf = (ev) =>
  ev.args?.command || ev.args?.pattern || ev.args?.path || ev.args?.task ||
  (ev.args?.tasks ? `${ev.args.tasks.length}个并行任务` : "") || "";

function render(ev) {
  switch (ev.type) {
    case "token":
      stopSpinner();
      if (!streaming) { stdout.write("\n" + paint(c.green + c.bold, "● ")); streaming = true; }
      stdout.write(ev.text); break;
    case "status":
      if (ev.state === "thinking") startSpinner();
      if (ev.state === "idle") { stopSpinner(); streaming = false; if (ev.stop_reason === "aborted") console.log(paint(c.yellow, "\n  ⎋ 已中断")); }
      break;
    case "tool_use":
      stopSpinner();
      streaming = false;
      console.log("\n" + paint(c.magenta, "⚙ " + ev.name) + paint(c.dim, argOf(ev) ? "  " + argOf(ev) : "")); break;
    case "tool_result":
      stopSpinner();
      console.log(paint(ev.ok ? c.dim : c.red, "  ↳ ") + ui.indent(ui.truncate(ev.preview || "", 400)).trimStart()); break;
    case "sub_step":
      console.log(paint(c.dim, `     ↳ 子助手${ev.label || ""} ${ev.name} ${ev.arg || ""}`)); break;
    case "permission_request":
      stopSpinner();
      console.log(paint(c.yellow, `\n  ⚠ 请求 ${ev.name} → ${ev.detail}`) + paint(c.dim, "  [y]是 [a]不再问 [n]否")); break;
    case "retry":
      console.log(paint(c.yellow, `  ↻ 重试 ${ev.name}（${ev.reason}）`)); break;
    case "compaction":
      console.log(paint(c.dim, `  ✦ 压缩上下文 ${ev.before}→${ev.after} 条`)); break;
    case "structured_output":
      stopSpinner(); streaming = false;
      console.log("\n" + paint(c.green + c.bold, "● ") + ev.text); break;
    case "error":
      stopSpinner();
      console.log(paint(c.red, `\n✗ ${ev.message}`)); break;
    case "_help":
      console.log(ui.box([paint(c.bold, "命令"), ...ev.lines.map((line) => paint(c.cyan, line))], { color: c.gray })); break;
    case "_tools":
      console.log(ui.box([
        paint(c.bold, "可用工具"),
        ...ev.res.tools.map((t) => `${t.kind === "mcp" ? paint(c.blue, "[MCP]") : paint(c.magenta, "[本地]")} ${paint(c.cyan, t.name)}${t.needsConfirm ? paint(c.yellow, " 需审批") : ""}`),
      ], { color: c.gray })); break;
    case "_mcp":
      console.log(ui.box([
        paint(c.bold, "MCP 服务器"),
        ...(ev.res.status.length ? ev.res.status.map((s) =>
          s.ok
            ? `${paint(c.green, "●")} ${s.name}  ${s.toolCount} 个工具  ${paint(c.dim, (s.tools || []).join(", "))}`
            : `${paint(c.red, "●")} ${s.name}  ${paint(c.dim, s.error || "连接失败")}`
        ) : [paint(c.dim, "未配置 MCP 服务器")]),
      ], { color: c.gray })); break;
    case "_skills":
      console.log(ui.box([
        paint(c.bold, "Skills"),
        ...(ev.res.skills.length ? ev.res.skills.map((s) => `${paint(c.cyan, s.name)}  ${paint(c.dim, s.description || "")}`) : [paint(c.dim, "未配置 Skills")]),
      ], { color: c.gray })); break;
    case "_usage": {
      const u = ev.res.usage;
      console.log(ui.box([
        paint(c.bold, "用量"),
        `上下文 ~${u.ctx} tok`,
        `累计输入 ${u.in} / 输出 ${u.out} tok`,
        `threads=${u.threads} notes=${u.notes} messages=${u.msgs}`,
      ], { color: c.gray })); break;
    }
    case "_compacted":
      console.log(paint(ev.res.changed ? c.green : c.dim, ev.res.changed ? `  ✓ 已压缩 ${ev.res.before} -> ${ev.res.after} 条消息` : "  （当前上下文无需压缩）")); break;
    case "_saved":
      console.log(paint(c.green, `  ✓ 已保存会话 ${ev.res.sessionId}`)); break;
    case "_cleared":
      console.log(paint(c.green, `  ✓ 已清空当前上下文：${ev.res.before} -> ${ev.res.after} 条消息`)); break;
    case "_format":
      console.log(paint(ev.changed ? c.green : c.cyan, `  ${ev.changed ? "✓" : "•"} 输出格式：${ev.current}`) +
        paint(c.dim, `  可选：${ev.formats.map((f) => f.name).join(", ")}`)); break;
    case "_resumed":
      console.log(paint(c.green, `  ✓ 已恢复会话 ${ev.res.sessionId}`) + paint(c.dim, `  threads=${ev.res.threads} notes=${ev.res.notes} messages=${ev.res.msgs}`)); break;
    case "_status_line": {
      const u = ev.res?.usage; if (u) console.log(paint(c.dim, `  ─ 上下文 ~${u.ctx} tok · in ${u.in} / out ${u.out}`)); break;
    }
    case "_sessions":
      console.log(ui.box([paint(c.bold, "历史会话"), ...ev.list.slice(0, 10).map((s) => paint(c.cyan, s.id) + paint(c.dim, `  ${s.msgCount}条  ${s.title}`))], { color: c.gray })); break;
  }
}

runRepl({ render, title: paint(c.bold + c.cyan, "\nminicode CLI") + paint(c.dim, " — 连接 minicode-core · exit 退出 · /sessions 列表") });
