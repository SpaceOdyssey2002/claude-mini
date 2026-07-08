// clients/replay.js —— 回放会话。
// daemon/client 模式优先回放 trace + events；单进程模式没有事件文件时，回放 session JSON 里的 messages。

import fs from "node:fs";
import path from "node:path";
import { readEvents } from "../core/eventbus.js";
import { readTrace, formatTraceEntry } from "../core/trace.js";
import { Session } from "../core/memory.js";
import * as ui from "../ui.js";

const { c, paint } = ui;
const dir = Session.dir();

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function listSessionFiles() {
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((file) => {
        const data = readJson(path.join(dir, file)) || {};
        return {
          id: data.id || file.replace(/\.json$/, ""),
          updatedAt: data.updatedAt || data.createdAt || "",
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

function messagesFromSession(data) {
  if (Array.isArray(data?.messages)) return data.messages;
  const threads = Array.isArray(data?.threads) ? data.threads : [];
  const active = threads.find((t) => t.id === data.activeThreadId) || threads[0];
  return Array.isArray(active?.messages) ? active.messages : [];
}

function renderMessages(messages) {
  if (!messages.length) {
    console.log(paint(c.dim, "  （这个会话没有可回放的 messages）"));
    return;
  }
  for (const m of messages) {
    if (m.role === "user") {
      console.log(paint(c.cyan, "\n■ 用户"));
      console.log(ui.indent(String(m.content || ""), "  "));
      continue;
    }
    if (m.role === "assistant") {
      console.log(paint(c.green, "\n● 助手"));
      if (m.content) console.log(ui.indent(String(m.content), "  "));
      for (const tc of m.tool_calls || []) {
        console.log(paint(c.magenta, `  ⚙ ${tc.function?.name || "tool"}`) + paint(c.dim, ` ${tc.function?.arguments || "{}"}`));
      }
      continue;
    }
    if (m.role === "tool") {
      console.log(paint(c.dim, "\n  ↳ 工具结果"));
      console.log(ui.indent(ui.truncate(String(m.content || ""), 600), "    "));
    }
  }
}

const id = process.argv[2] || listSessionFiles()[0]?.id;
if (!id) {
  console.log("没有可回放的会话。先运行一次 minicode 任务。");
  process.exit(0);
}

console.log(paint(c.bold + c.cyan, `回放会话 ${id}`));

const trace = readTrace(path.join(dir, id + ".trace.jsonl"));
const events = readEvents(path.join(dir, id + ".events.jsonl"));

if (trace.length) {
  console.log(paint(c.bold, "\n— Trace 时间线（IPC / EVT / LLM）—"));
  for (const e of trace) console.log("  " + paint(c.dim, formatTraceEntry(e)));
}

if (events.length) {
  console.log(paint(c.bold, "\n— 事件流回放 —"));
  for (const e of events) {
    switch (e.type) {
      case "run_start": console.log(paint(c.cyan, `■ 目标：${e.goal}`)); break;
      case "message": console.log(paint(c.green, "● ") + e.text); break;
      case "tool_use": console.log(paint(c.magenta, `  ⚙ ${e.name}`) + paint(c.dim, " " + (e.args?.command || e.args?.path || e.args?.pattern || e.args?.task || ""))); break;
      case "tool_result": console.log(paint(e.ok ? c.dim : c.red, "    ↳ " + (e.preview || "").split("\n")[0])); break;
      case "permission_request": console.log(paint(c.yellow, `  ⚠ 审批请求 ${e.name} → ${e.detail}`)); break;
      case "permission_response": console.log(paint(c.yellow, `  ✓ 审批 ${e.id} = ${e.decision}`)); break;
      case "retry": console.log(paint(c.yellow, `  ↻ 重试 ${e.name}（${e.reason}）`)); break;
      case "compaction": console.log(paint(c.blue, `  ✓ 压缩 ${e.before}→${e.after}`)); break;
      case "usage": console.log(paint(c.dim, `  ─ in ${e.in} / out ${e.out} · ctx ~${e.ctx}`)); break;
      case "error": console.log(paint(c.red, `  ✗ ${e.message}`)); break;
      case "run_end": console.log(paint(c.dim, "■ 结束")); break;
    }
  }
  process.exit(0);
}

const data = readJson(path.join(dir, id + ".json"));
console.log(paint(c.bold, "\n— messages 回放（单进程会话或无事件文件会话）—"));
renderMessages(messagesFromSession(data));
