// test/core.test.js —— 核心模块单元测试（node:test，零依赖，不联网）。
// 跑：npm test  （即 node --test）

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { validateArgs, classifyError, ToolRegistry } from "../src/core/registry.js";
import { frame, createLineParser, rpc, dispatchRpc } from "../src/core/rpc.js";
import { EventBus } from "../src/core/eventbus.js";
import { Session } from "../src/core/memory.js";
import { estimateTokens, compact } from "../src/context.js";
import { handlers, setWorkspace, getWorkspace } from "../src/tools.js";
import { runAgentTurn } from "../src/agent.js";
import { PlanState } from "../src/plan.js";

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

test("validateArgs 校验嵌套数组、范围和额外字段", () => {
  const schema = {
    type: "object",
    properties: {
      tasks: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", minLength: 1 } },
    },
    required: ["tasks"],
    additionalProperties: false,
  };
  assert.deepEqual(validateArgs(schema, { tasks: ["a", "b"] }), []);
  assert.ok(validateArgs(schema, { tasks: ["a", 2] }).length > 0);
  assert.ok(validateArgs(schema, { tasks: ["a", "b", "c"] }).length > 0);
  assert.ok(validateArgs(schema, { tasks: ["a"], extra: true }).length > 0);
});

// ── 失败分类 ──
test("classifyError 分类正确", () => {
  assert.equal(classifyError({ name: "AbortError" }).kind, "aborted");
  assert.equal(classifyError({ status: 503, message: "Service Unavailable" }).retryable, true);
  assert.equal(classifyError({ message: "路径越界" }).retryable, false);
  assert.equal(classifyError({ message: "timeout" }).kind, "transient");
});

test("ToolRegistry 只对幂等工具的 transient 错误重试", async () => {
  const tool = {
    type: "function",
    function: { name: "query", parameters: { type: "object", properties: {}, additionalProperties: false } },
  };
  let attempts = 0;
  const registry = new ToolRegistry({
    tools: [tool],
    policies: new Map([["query", { idempotent: true, maxRetries: 1, timeoutMs: 5000 }]]),
    dispatch: async () => {
      attempts++;
      if (attempts === 1) throw new Error("network timeout");
      return "ok";
    },
  });
  assert.equal(await registry.run("query", {}), "ok");
  assert.equal(attempts, 2);

  attempts = 0;
  const unsafe = new ToolRegistry({
    tools: [tool],
    policies: new Map([["query", { idempotent: false, maxRetries: 2, timeoutMs: 5000 }]]),
    dispatch: async () => { attempts++; throw new Error("network timeout"); },
  });
  await assert.rejects(() => unsafe.run("query", {}), /network timeout/);
  assert.equal(attempts, 1);
});

test("run_command 非零退出码会抛错而不是伪装成功", async () => {
  setWorkspace(process.cwd());
  await assert.rejects(
    () => handlers.run_command({ command: 'node -e "process.exit(2)"' }),
    /命令执行失败/
  );
});

test("主 Agent 重复相同观察后先恢复再由 LoopGuard 受控收尾", async () => {
  let modelCalls = 0;
  let dispatchCalls = 0;
  const systems = [];
  const client = {
    chat: { completions: { create: async (request) => {
      modelCalls++;
      systems.push(request.messages[0].content);
      const forcedFinal = !request.tools;
      return {
        async *[Symbol.asyncIterator]() {
          if (forcedFinal) {
            yield { choices: [{ delta: { content: "已受控停止" } }] };
          } else {
            yield { choices: [{ delta: { tool_calls: [{
              index: 0, id: `call-${modelCalls}`,
              function: { name: "read_file", arguments: '{"path":"same.txt"}' },
            }] } }] };
          }
          yield { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } };
        },
      };
    } } },
  };
  const ui = {
    onWaitStart() {}, onWaitEnd() {}, onToken() {}, onTextEnd() {},
    onToolUse() {}, onToolResult() {}, async confirm() { return true; },
  };
  const messages = [{ role: "user", content: "重复测试" }];
  const result = await runAgentTurn(client, messages, {
    model: "fake", tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
    dispatch: async () => { dispatchCalls++; return "相同结果"; },
    confirmNeeded: () => false,
    parallelSafe: () => true,
    ui,
    limits: {
      maxIterations: 10, maxToolCalls: 10, maxSameCall: 2, maxSameResult: 2,
      maxConsecutiveErrors: 5, maxRecoveryAttempts: 1, deadlineMs: 60_000,
    },
  });
  assert.equal(result.stopped, "repeated_tool_call");
  assert.equal(dispatchCalls, 3);
  assert.equal(modelCalls, 4);
  assert.ok(systems.some((s) => s.includes("自动错误恢复")));
  assert.equal(messages.at(-1).content, "已受控停止");
});

test("PlanState 强制唯一 id 和最多一个进行中步骤", () => {
  const plan = new PlanState();
  assert.match(plan.update({ steps: [
    { id: "s1", description: "分析", status: "completed", evidence: "a.js" },
    { id: "s2", description: "修改", status: "in_progress", acceptance: "测试通过" },
  ] }), /s2/);
  assert.match(plan.prompt(), /当前结构化计划/);
  assert.throws(() => plan.update({ steps: [
    { id: "s1", description: "a", status: "in_progress" },
    { id: "s2", description: "b", status: "in_progress" },
  ] }), /最多只能有一个/);
});

test("glob 的 **/ 可以匹配零层或多层目录", async () => {
  const oldWorkspace = getWorkspace();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-glob-"));
  try {
    await fs.mkdir(path.join(temp, "src", "deep"), { recursive: true });
    await fs.writeFile(path.join(temp, "src", "a.js"), "", "utf8");
    await fs.writeFile(path.join(temp, "src", "deep", "b.js"), "", "utf8");
    setWorkspace(temp);
    const result = await handlers.glob({ pattern: "src/**/*.js" });
    assert.match(result, /src\/a\.js/);
    assert.match(result, /src\/deep\/b\.js/);
  } finally {
    setWorkspace(oldWorkspace);
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("compact 可在单个长回合内压缩较早工具组并保留最近三组", async () => {
  const messages = [{ role: "user", content: "完成复杂任务" }];
  for (let i = 1; i <= 4; i++) {
    messages.push({
      role: "assistant", content: null,
      tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: `{"path":"${i}.txt"}` } }],
    });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: `result-${i}` });
  }
  const client = { chat: { completions: { create: async () => ({
    choices: [{ message: { content: "已确认事实：完成了第一组读取。" } }],
  }) } } };
  const compacted = await compact(client, "fake", messages, { keepTurns: 2 });
  assert.equal(compacted[0].role, "user");
  assert.match(compacted[1].content, /当前回合较早执行过程摘要/);
  assert.equal(compacted.filter((m) => m.tool_calls?.length).length, 3);
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
