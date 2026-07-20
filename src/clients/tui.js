// clients/tui.js —— TUI 客户端：订阅同一份事件流，用盒子/卡片渲染（工具块、权限审批卡片）。
// 和 cli.js 共用 runRepl，只是把事件画得更像「界面」。
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
      // 工具调用渲染成一个块
      console.log("\n" + ui.box([paint(c.magenta, "⚙ " + ev.name) + (argOf(ev) ? paint(c.dim, "  " + argOf(ev)) : "")], { color: c.magenta }));
      break;
    case "tool_result": {
      stopSpinner();
      const lines = ui.truncate(ev.preview || "(无输出)", 300).split("\n").slice(0, 8);
      console.log(ui.box([paint(c.bold, ev.ok ? "结果" : "结果(错误)"), ...lines], { color: ev.ok ? c.gray : c.red }));
      break;
    }
    case "sub_step":
      console.log(paint(c.dim, `     ↳ 子助手${ev.label || ""} ${ev.name} ${ev.arg || ""}`)); break;
    case "permission_request":
      stopSpinner();
      // 权限审批卡片
      console.log("\n" + ui.box([
        paint(c.bold + c.yellow, "⚠ 权限审批"),
        `工具：${ev.name}`,
        paint(c.dim, `目标：${ev.detail}`),
        "",
        paint(c.dim, "[y] 允许   [a] 本会话允许   [n] 拒绝"),
      ], { color: c.yellow }));
      break;
    case "retry":
      console.log(paint(c.yellow, `  ↻ 重试 ${ev.name}（${ev.reason}）`)); break;
    case "compaction":
      console.log(ui.box([paint(c.bold, "上下文压缩"), `${ev.before} → ${ev.after} 条消息（${ev.reason}）`], { color: c.blue })); break;
    case "structured_output":
      stopSpinner(); streaming = false;
      console.log(ui.box([paint(c.bold + c.green, `结构化结果 · ${ev.format}`), ...ev.text.split("\n")], { color: c.green })); break;
    case "error":
      stopSpinner();
      console.log(ui.box([paint(c.bold + c.red, "出错"), ev.message], { color: c.red })); break;
    case "_help":
      console.log(ui.box([paint(c.bold, "命令"), ...ev.lines], { color: c.gray })); break;
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
      console.log(ui.box([paint(c.bold, ev.res.changed ? "已压缩" : "无需压缩"), `${ev.res.before} -> ${ev.res.after} 条消息`], { color: ev.res.changed ? c.green : c.gray })); break;
    case "_saved":
      console.log(ui.box([paint(c.bold + c.green, "已保存会话"), ev.res.sessionId], { color: c.green })); break;
    case "_cleared":
      console.log(ui.box([paint(c.bold + c.green, "已清空上下文"), `${ev.res.before} -> ${ev.res.after} 条消息`], { color: c.green })); break;
    case "_format":
      console.log(ui.box([
        paint(c.bold, "最终输出格式"),
        `${ev.changed ? "已切换为" : "当前"}：${paint(c.cyan, ev.current)}`,
        paint(c.dim, `可选：${ev.formats.map((f) => f.name).join(", ")}`),
      ], { color: ev.changed ? c.green : c.gray })); break;
    case "_resumed":
      console.log(ui.box([
        paint(c.bold + c.green, "已恢复会话"),
        ev.res.sessionId,
        paint(c.dim, `threads=${ev.res.threads} notes=${ev.res.notes} messages=${ev.res.msgs}`),
      ], { color: c.green })); break;
    case "_status_line": {
      const u = ev.res?.usage;
      if (u) {
        const meter = "█".repeat(Math.min(20, Math.round((u.ctx / 40000) * 20))).padEnd(20, "░");
        console.log(paint(c.dim, `  上下文 [${meter}] ~${u.ctx} tok · in ${u.in} / out ${u.out}`));
      }
      break;
    }
    case "_sessions":
      console.log(ui.box([paint(c.bold, "历史会话"), ...ev.list.slice(0, 10).map((s) => paint(c.cyan, s.id) + paint(c.dim, `  ${s.msgCount}条 ${s.notes}笔记  ${s.title}`))], { color: c.gray })); break;
  }
}

runRepl({
  render,
  title: "\n" + ui.box([
    paint(c.bold + c.cyan, "minicode-tui") + paint(c.dim, "  连接 minicode-core 的终端界面"),
    paint(c.dim, "exit 退出 · /sessions 列表 · Ctrl+C 中断当前任务"),
  ], { color: c.cyan }),
});
