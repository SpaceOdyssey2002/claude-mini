// core/memory.js —— 分层记忆：session / thread / notes / context。
//
//   session  顶层容器，一段持续的协作（可跨多次启动）
//   thread   会话线，一条具体的对话（messages 就是它的「context 工作窗口」）
//   notes    跨 thread 的持久笔记（agent 记给自己的，会注入系统提示）
//
// 对比"一个大数组拼历史"：分层让我们能"新开话题不丢全局记忆"、"压缩只压当前 thread"、
// "notes 长期留存"。存到 .sessions/<id>.json。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = path.join(ROOT, ".sessions");

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* 忽略 */ } }
const nowISO = () => new Date().toISOString();

export function newSessionId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `sess-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export class Session {
  constructor(id) {
    this.id = id || newSessionId();
    this.createdAt = nowISO();
    this.threads = [];
    this.notes = [];
    this.activeThreadId = null;
    this.usage = { in: 0, out: 0 };
  }

  newThread(title = "") {
    const t = { id: `thread-${this.threads.length + 1}`, title, messages: [], createdAt: nowISO() };
    this.threads.push(t);
    this.activeThreadId = t.id;
    return t;
  }
  active() {
    return this.threads.find((t) => t.id === this.activeThreadId) || this.newThread();
  }
  // 当前 thread 的 messages 就是「context 工作窗口」
  get messages() { return this.active().messages; }

  addNote(text) { this.notes.push({ ts: nowISO(), text }); }
  // notes 注入系统提示用
  notesText() {
    if (!this.notes.length) return "";
    return "\n\n你之前记下的笔记（notes）：\n" + this.notes.map((n) => `- ${n.text}`).join("\n");
  }

  save() {
    ensureDir();
    const title = this.threads[0]?.messages.find((m) => m.role === "user" && typeof m.content === "string")?.content.slice(0, 30) || "";
    const payload = {
      id: this.id, createdAt: this.createdAt, updatedAt: nowISO(), title,
      threads: this.threads, notes: this.notes, activeThreadId: this.activeThreadId, usage: this.usage,
    };
    fs.writeFileSync(path.join(DIR, this.id + ".json"), JSON.stringify(payload, null, 2), "utf8");
  }

  static load(id) {
    const f = path.join(DIR, id + ".json");
    if (!fs.existsSync(f)) return null;
    try {
      const d = JSON.parse(fs.readFileSync(f, "utf8"));
      const s = new Session(d.id);
      s.createdAt = d.createdAt; s.threads = d.threads || []; s.notes = d.notes || [];
      s.activeThreadId = d.activeThreadId; s.usage = d.usage || { in: 0, out: 0 };
      if (!s.threads.length) s.newThread();
      return s;
    } catch { return null; }
  }

  static list() {
    ensureDir();
    let files;
    try { files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")); } catch { return []; }
    const out = [];
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
        const msgs = (d.threads || []).reduce((n, t) => n + (t.messages || []).length, 0);
        out.push({ id: d.id, updatedAt: d.updatedAt || "", title: d.title || "", threads: (d.threads || []).length, notes: (d.notes || []).length, msgCount: msgs });
      } catch { /* 跳过损坏 */ }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  static dir() { return DIR; }
}
