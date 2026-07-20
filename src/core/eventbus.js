// core/eventbus.js —— 事件总线：把 Agent 执行过程外化成结构化事件流。
//
// Agent 内部不再直接 console.log，而是往总线 emit 事件；订阅者（TUI/CLI/落盘）各取所需。
// 这是 minicode 运行时架构的关键：执行过程可订阅、可持久化、可回放。
//
// 事件类型（type）约定：
//   run_start / run_end        一次任务的开始/结束
//   status                     运行状态：running / idle / aborted（带 stop_reason）
//   token                      流式文字增量
//   message                    一段完整的助手文字
//   tool_use                   模型发起工具调用（executionId, toolCallId, name, 脱敏 args）
//   tool_result                工具返回（同一 executionId、状态、耗时、脱敏 preview）
//   permission_request         需要用户审批（审批 id + executionId + 风险策略）
//   permission_response        审批结果（审批 id + executionId + decision）
//   retry                      工具瞬时失败重试
//   usage                      token 用量
//   compaction                 上下文压缩
//   error                      错误

import fs from "node:fs";

let SEQ = 0;

export class EventBus {
  constructor(logFile = null) {
    this.subs = new Set();
    this.logFile = logFile;
    this.history = [];
  }
  setLogFile(f) { this.logFile = f; }

  // 订阅，返回取消订阅函数
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }

  // 发一条事件：自动补 seq + 时间戳，推给订阅者，并追加到 jsonl
  emit(ev) {
    const e = { seq: ++SEQ, ts: new Date().toISOString(), ...ev };
    this.history.push(e);
    for (const fn of this.subs) { try { fn(e); } catch { /* 订阅者异常不影响总线 */ } }
    if (this.logFile) { try { fs.appendFileSync(this.logFile, JSON.stringify(e) + "\n"); } catch { /* 落盘失败忽略 */ } }
    return e;
  }
}

// 从 events.jsonl 读回事件（用于回放）
export function readEvents(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
