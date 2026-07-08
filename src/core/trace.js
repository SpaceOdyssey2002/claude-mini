// core/trace.js —— 系统级时间线：把 IPC / EventBus / LLM 三层数据流记到 trace.jsonl，可回放复盘。
//
// 三层：
//   ipc       客户端↔daemon 的 JSON-RPC 请求/响应
//   eventbus  Agent 外化的每一条事件
//   llm       每次模型调用的元信息（方法、用量、工具调用数）——只记摘要，不存全文
// 排查问题时，按时间顺序看这三层，就能还原「用户目标 → 模型 → 工具 → 事件」整条链路。

import fs from "node:fs";

export function makeTracer(file) {
  // 返回一个记录函数；file 为空则记录是空操作
  return (layer, dir, data) => {
    if (!file) return;
    const entry = { ts: new Date().toISOString(), layer, dir, data };
    try { fs.appendFileSync(file, JSON.stringify(entry) + "\n"); } catch { /* 忽略 */ }
  };
}

export function readTrace(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// 把一条 trace 渲染成一行可读文本（供 replay 用）
export function formatTraceEntry(e) {
  const t = (e.ts || "").slice(11, 23); // 只取 时:分:秒.毫秒
  const arrow = e.dir === "in" ? "→" : e.dir === "out" ? "←" : "·";
  const tag = { ipc: "IPC", eventbus: "EVT", llm: "LLM" }[e.layer] || e.layer;
  let summary;
  if (e.layer === "ipc") summary = e.data.method || e.data.result !== undefined ? (e.data.method || "result") : JSON.stringify(e.data).slice(0, 80);
  else if (e.layer === "eventbus") summary = e.data.type + (e.data.name ? `(${e.data.name})` : "");
  else if (e.layer === "llm") summary = `${e.data.event || ""} in=${e.data.in ?? "?"} out=${e.data.out ?? "?"} tools=${e.data.tools ?? 0}`;
  else summary = JSON.stringify(e.data).slice(0, 80);
  return `${t} ${arrow} [${tag}] ${summary}`;
}
