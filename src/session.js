// session.js —— 会话持久化：把对话历史存到 .sessions/ 目录，支持列出与恢复。
//
// 每个会话是一个 JSON 文件，记录完整 messages、用量、标题、时间。
// 主程序每轮结束自动保存当前会话；用户可用 /sessions 查看、/resume 恢复，
// 退出后再进来也能接着上次聊。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, ".sessions");

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* 忽略 */ }
}

// 用时间戳生成会话 id（普通 Node 进程里 new Date 可用）
export function newSessionId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `sess-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function saveSession(id, data) {
  ensureDir();
  const payload = { id, ...data, updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(DIR, id + ".json"), JSON.stringify(payload, null, 2), "utf8");
}

export function loadSession(id) {
  const f = path.join(DIR, id + ".json");
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}

// 列出所有会话（按更新时间倒序）
export function listSessions() {
  ensureDir();
  let files;
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
      out.push({ id: d.id, updatedAt: d.updatedAt || "", title: d.title || "", msgCount: (d.messages || []).length });
    } catch { /* 跳过损坏文件 */ }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
