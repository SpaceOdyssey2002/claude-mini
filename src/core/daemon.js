// core/daemon.js —— minicode-core 守护进程：常驻的 Agent 运行时。
//
// CLI/TUI 只是客户端，真正跑任务的是这个 daemon。它通过 TCP + JSON-RPC(NDJSON) 对外服务：
//   - 托管多个 AgentRunner（按 session）
//   - 把每个 run 的事件流通过 IPC 推给订阅的客户端
//   - 接收权限审批/中断等控制指令
// 好处：客户端崩了任务不一定死、可多客户端、过程可订阅可回放——这就是「运行时」而非「脚本」。

import net from "node:net";
import OpenAI from "openai";
import { frame, createLineParser, rpc, dispatchRpc } from "./rpc.js";
import { AgentRunner } from "./runner.js";
import { Session } from "./memory.js";
import { setWorkspace } from "../tools.js";

const PORT = Number(process.env.MINICODE_PORT) || 47800;
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const WORKSPACE = process.env.MINICODE_WORKSPACE || process.cwd();

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("✗ 未检测到 DEEPSEEK_API_KEY"); process.exit(1);
}
setWorkspace(WORKSPACE);
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY, baseURL: "https://api.deepseek.com",
  maxRetries: 3, timeout: 120_000,
});

const runners = new Map(); // sessionId → AgentRunner

async function getRunner(sessionId, autoApprove) {
  if (sessionId && runners.has(sessionId)) return runners.get(sessionId);
  const session = (sessionId && Session.load(sessionId)) || new Session(sessionId || undefined);
  const r = new AgentRunner({ client, model: MODEL, session, autoApprove });
  await r.init();
  runners.set(r.session.id, r);
  return r;
}

function makeMethods(send) {
  return {
    ping: () => "pong",
    "session.list": () => Session.list(),

    async "tools.list"({ sessionId }) {
      const r = await getRunner(sessionId);
      return { sessionId: r.session.id, tools: r.toolSummaries() };
    },

    async "mcp.status"({ sessionId }) {
      const r = await getRunner(sessionId);
      return { sessionId: r.session.id, status: r.mcpStatus() };
    },

    async "skills.list"({ sessionId }) {
      const r = await getRunner(sessionId);
      return { sessionId: r.session.id, skills: r.skillSummaries() };
    },

    async "usage.get"({ sessionId }) {
      const r = await getRunner(sessionId);
      return { sessionId: r.session.id, usage: r.usageSummary() };
    },

    async compact({ sessionId }) {
      const r = await getRunner(sessionId);
      return { sessionId: r.session.id, ...(await r.compactNow("manual")) };
    },

    async "session.save"({ sessionId, title }) {
      const r = await getRunner(sessionId);
      return { sessionId: r.session.id, ...r.save(title || "") };
    },

    async "session.clear"({ sessionId }) {
      const r = await getRunner(sessionId);
      return { sessionId: r.session.id, ...r.clear() };
    },

    async run({ sessionId, goal, autoApprove }) {
      const r = await getRunner(sessionId, !!autoApprove);
      r.autoApprove = !!autoApprove;
      // 把该 runner 的事件流转发给当前连接
      const unsub = r.bus.subscribe((ev) => send(rpc.notify("event", { sessionId: r.session.id, ...ev })));
      r.tracer("ipc", "in", { method: "run", goal });
      try {
        const res = await r.run(goal);
        r.tracer("ipc", "out", res);
        return { sessionId: r.session.id, ...res };
      } finally {
        unsub();
      }
    },

    "permission.respond": ({ sessionId, id, decision }) => {
      const r = runners.get(sessionId);
      return r ? r.respondPermission(id, decision) : false;
    },

    interrupt: ({ sessionId }) => {
      const r = runners.get(sessionId);
      return r ? r.interrupt() : false;
    },

    async resume({ sessionId }) {
      const r = await getRunner(sessionId);
      return {
        sessionId: r.session.id, threads: r.session.threads.length,
        notes: r.session.notes.length, msgs: r.session.messages.length,
      };
    },
  };
}

const server = net.createServer((conn) => {
  conn.setEncoding("utf8");
  const send = (obj) => { try { conn.write(frame(obj)); } catch { /* 连接已断 */ } };
  const methods = makeMethods(send);
  const parse = createLineParser((msg) => dispatchRpc(msg, methods, send));
  conn.on("data", parse);
  conn.on("error", () => {});
});

server.listen(PORT, () => {
  console.log(`minicode-core daemon 监听 127.0.0.1:${PORT}`);
  console.log(`工作目录沙箱：${WORKSPACE}`);
  console.log(`模型：${MODEL}  ·  Ctrl+C 停止`);
});

process.on("SIGINT", () => { console.log("\nminicode-core 停止"); process.exit(0); });
