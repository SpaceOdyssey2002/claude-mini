// clients/client.js —— 客户端公共逻辑：连接 daemon、JSON-RPC 调用、REPL 循环、权限/中断。
// CLI 和 TUI 都基于它，只是各自提供不同的事件渲染函数。

import net from "node:net";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { frame, createLineParser, rpc } from "../core/rpc.js";

const PORT = Number(process.env.MINICODE_PORT) || 47800;

// 建立到 daemon 的连接，返回 { call, onEvent, ready, close }
export function connect(port = PORT) {
  const sock = net.createConnection(port, "127.0.0.1");
  sock.setEncoding("utf8");
  const pending = new Map();
  let id = 0;
  let eventHandler = (_ev) => {};

  const parse = createLineParser((msg) => {
    if (msg.method === "event") { eventHandler(msg.params); return; } // 服务端推来的事件通知
    if (msg.id != null && pending.has(msg.id)) {                       // 请求的响应
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  sock.on("data", parse);

  return {
    call(method, params) {
      const myId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(myId, { resolve, reject });
        sock.write(frame(rpc.request(myId, method, params)));
      });
    },
    onEvent(fn) { eventHandler = fn; },
    ready() { return new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); }); },
    close() { sock.end(); },
  };
}

export function permissionResponseParams(currentSessionId, ev, decision) {
  return {
    sessionId: ev.sessionId || currentSessionId,
    id: ev.id,
    decision,
  };
}

function helpLines() {
  return [
    "/help             显示帮助",
    "/tools            查看工具",
    "/mcp              查看 MCP 连接状态",
    "/skills           查看 Skills",
    "/usage            查看 token 用量",
    "/compact          手动压缩上下文",
    "/sessions         查看旧会话",
    "/resume [id]      恢复会话；不传 id 时恢复最近一次",
    "/save [title]     保存当前会话，可选标题",
    "/clear            清空当前上下文",
    "exit / quit       退出客户端",
    "Ctrl+C            任务运行中为中断；空闲时为退出",
  ];
}

function rememberSession(current, res) {
  return res?.sessionId || current;
}

// 公共 REPL：连接 → 循环读目标 → run → 渲染事件流 → 处理权限/中断
// render(ev)：渲染一条事件（各客户端自定义外观）
export async function runRepl({ render, title, onReady = null }) {
  const conn = connect();
  try { await conn.ready(); }
  catch { console.error(`✗ 连不上 minicode-core（端口 ${PORT}）。先启动：npm run core`); process.exit(1); }

  // 输入队列（管道/交互都健壮）
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const queue = [], waiters = []; let closed = false;
  rl.on("line", (l) => waiters.length ? waiters.shift()(l) : queue.push(l));
  rl.on("close", () => { closed = true; while (waiters.length) waiters.shift()(null); });
  const ask = (p = "") => { if (p) stdout.write(p); return queue.length ? Promise.resolve(queue.shift()) : closed ? Promise.resolve(null) : new Promise((r) => waiters.push(r)); };

  let sessionId = null;
  let busy = false;

  conn.onEvent(async (ev) => {
    render(ev);
    if (ev.type === "permission_request") {
      const a = (await ask()) ?? "n";
      const k = a.trim().toLowerCase();
      const decision = k === "a" ? "a" : k === "y" ? "y" : "n";
      conn.call("permission.respond", permissionResponseParams(sessionId, ev, decision)).catch(() => {});
    }
  });

  rl.on("SIGINT", () => {
    if (busy && sessionId) conn.call("interrupt", { sessionId }).catch(() => {});
    else { conn.close(); process.exit(0); }
  });

  onReady?.({ conn });
  if (title) console.log(title);

  while (true) {
    const goal = await ask("\n› ");
    if (goal === null) break;
    const text = goal.trim();
    if (!text) continue;
    if (text === "exit" || text === "quit") break;
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      const arg = rest.join(" ").trim();
      if (cmd === "help") { render({ type: "_help", lines: helpLines() }); continue; }
      if (cmd === "tools") {
        const res = await conn.call("tools.list", { sessionId });
        sessionId = rememberSession(sessionId, res);
        render({ type: "_tools", res });
        continue;
      }
      if (cmd === "mcp") {
        const res = await conn.call("mcp.status", { sessionId });
        sessionId = rememberSession(sessionId, res);
        render({ type: "_mcp", res });
        continue;
      }
      if (cmd === "skills") {
        const res = await conn.call("skills.list", { sessionId });
        sessionId = rememberSession(sessionId, res);
        render({ type: "_skills", res });
        continue;
      }
      if (cmd === "usage") {
        const res = await conn.call("usage.get", { sessionId });
        sessionId = rememberSession(sessionId, res);
        render({ type: "_usage", res });
        continue;
      }
      if (cmd === "compact") {
        const res = await conn.call("compact", { sessionId });
        sessionId = rememberSession(sessionId, res);
        render({ type: "_compacted", res });
        continue;
      }
      if (cmd === "sessions") { render({ type: "_sessions", list: await conn.call("session.list", {}) }); continue; }
      if (cmd === "resume") {
        let target = arg || "";
        if (!target) {
          const list = await conn.call("session.list", {});
          target = list[0]?.id || "";
        }
        if (!target) {
          render({ type: "error", message: "没有可恢复的会话。" });
          continue;
        }
        const res = await conn.call("resume", { sessionId: target });
        sessionId = res.sessionId;
        render({ type: "_resumed", res });
        continue;
      }
      if (cmd === "save") {
        const res = await conn.call("session.save", { sessionId, title: arg });
        sessionId = rememberSession(sessionId, res);
        render({ type: "_saved", res });
        continue;
      }
      if (cmd === "clear") {
        const res = await conn.call("session.clear", { sessionId });
        sessionId = rememberSession(sessionId, res);
        render({ type: "_cleared", res });
        continue;
      }
      render({ type: "error", message: `未知命令 /${cmd}，输入 /help 查看可用命令。` });
      continue;
    }
    busy = true;
    try {
      const res = await conn.call("run", { sessionId, goal: text, autoApprove: !!process.env.MINICODE_YES });
      sessionId = res.sessionId;
      render({ type: "_status_line", res });
    } catch (e) {
      render({ type: "error", message: e.message });
    }
    busy = false;
  }
  conn.close();
  rl.close();
}
