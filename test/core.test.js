// test/core.test.js —— 核心模块单元测试（node:test，零依赖，不联网）。
// 跑：npm test  （即 node --test）

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateArgs, classifyError } from "../src/core/registry.js";
import { frame, createLineParser, rpc, dispatchRpc } from "../src/core/rpc.js";
import { EventBus } from "../src/core/eventbus.js";
import { Session } from "../src/core/memory.js";
import { estimateTokens } from "../src/context.js";
import { handlers, setWorkspace } from "../src/tools.js";

// ── ToolRegistry：参数校验 ──
test("validateArgs 缺必填参数报错", () => {
  const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  assert.deepEqual(validateArgs(schema, {}), ["缺少必填参数 'path'"]);
  assert.deepEqual(validateArgs(schema, { path: "a.js" }), []);
});

test("validateArgs 类型与枚举校验", () => {
  const schema = { type: "object", properties: { n: { type: "integer" }, c: { enum: ["a", "b"] } } };
  assert.equal(validateArgs(schema, { n: 1.5 }).length, 1);
  assert.equal(validateArgs(schema, { c: "x" }).length, 1);
  assert.deepEqual(validateArgs(schema, { n: 3, c: "a" }), []);
});

// ── 失败分类 ──
test("classifyError 分类正确", () => {
  assert.equal(classifyError({ name: "AbortError" }).kind, "aborted");
  assert.equal(classifyError({ status: 503, message: "Service Unavailable" }).retryable, true);
  assert.equal(classifyError({ message: "路径越界" }).retryable, false);
  assert.equal(classifyError({ message: "timeout" }).kind, "transient");
});

// ── JSON-RPC over NDJSON：分帧 + 分发 ──
test("createLineParser 正确按行解析（含半包）", () => {
  const got = [];
  const parse = createLineParser((m) => got.push(m));
  parse(frame({ a: 1 }).slice(0, 3));   // 半包
  parse(frame({ a: 1 }).slice(3));      // 补齐第一条
  parse(frame({ b: 2 }) + frame({ c: 3 })); // 一次两条
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test("dispatchRpc 调用方法并回响应；通知不回", async () => {
  const sent = [];
  const methods = { add: ({ a, b }) => a + b };
  await dispatchRpc(rpc.request(1, "add", { a: 2, b: 3 }), methods, (o) => sent.push(o));
  await dispatchRpc(rpc.notify("add", { a: 1, b: 1 }), methods, (o) => sent.push(o)); // 通知无 id
  await dispatchRpc(rpc.request(2, "nope", {}), methods, (o) => sent.push(o));         // 未知方法
  assert.equal(sent[0].result, 5);
  assert.equal(sent.length, 2); // 通知没有响应
  assert.equal(sent[1].error.code, -32601);
});

// ── EventBus ──
test("EventBus emit/subscribe/seq/history", () => {
  const bus = new EventBus();
  const seen = [];
  const unsub = bus.subscribe((e) => seen.push(e));
  const e1 = bus.emit({ type: "token", text: "hi" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "token");
  assert.ok(e1.seq > 0 && e1.ts);
  unsub();
  bus.emit({ type: "token", text: "x" });
  assert.equal(seen.length, 1); // 已取消订阅
  assert.equal(bus.history.length, 2);
});

// ── 分层记忆 ──
test("Session thread/notes/messages", () => {
  const s = new Session("test-xyz");
  s.newThread("t1");
  s.messages.push({ role: "user", content: "hi" });
  assert.equal(s.messages.length, 1);
  s.addNote("记住代号 ALPHA");
  assert.match(s.notesText(), /ALPHA/);
  assert.equal(s.threads.length, 1);
});

// ── 上下文 token 估算 ──
test("estimateTokens 随内容增长", () => {
  const a = estimateTokens([{ role: "user", content: "x" }]);
  const b = estimateTokens([{ role: "user", content: "x".repeat(100) }]);
  assert.ok(b > a);
});

// ── 工作目录沙箱 ──
test("文件工具拦截越界路径", async () => {
  setWorkspace(process.cwd());
  await assert.rejects(() => handlers.read_file({ path: "../../../etc/passwd" }), /越界/);
  await assert.rejects(() => handlers.read_file({ path: "C:/Windows/win.ini" }), /越界/);
  await assert.rejects(() => handlers.edit_file({ path: "C:/Windows/win.ini", old_str: "x", new_str: "y" }), /越界/);
});
