#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";

import { runAgentTurn } from "../src/agent.js";
import { compact } from "../src/context.js";
import { FileCheckpointManager } from "../src/core/checkpoint.js";
import { ToolRegistry, validateArgs } from "../src/core/registry.js";
import { McpManager } from "../src/mcp.js";
import { createModelRuntime } from "../src/model.js";
import { PlanState } from "../src/plan.js";
import { getWorkspace, handlers, setWorkspace, toolPolicies, tools as builtinTools } from "../src/tools.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pct = (n, d) => d ? Number((100 * n / d).toFixed(2)) : null;
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round = (n, digits = 2) => Number(n.toFixed(digits));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const options = { provider: "deepseek", runs: 5, delayMs: 200, output: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--provider") options.provider = argv[++i];
    else if (argv[i] === "--runs") options.runs = Number(argv[++i]);
    else if (argv[i] === "--delay-ms") options.delayMs = Number(argv[++i]);
    else if (argv[i] === "--output") options.output = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") options.help = true;
    else throw new Error(`未知参数：${argv[i]}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 20) {
    throw new Error("--runs 必须是 1-20 的整数");
  }
  if (!Number.isInteger(options.delayMs) || options.delayMs < 50 || options.delayMs > 2000) {
    throw new Error("--delay-ms 必须是 50-2000 的整数");
  }
  return options;
}

function help() {
  return `DeepSeek 驱动的 minicode A/B 量化测试

用法：
  node benchmark/deepseek-ab.js --provider deepseek --runs 5

测试只读取 DEEPSEEK_API_KEY 环境变量，不会保存凭据。`;
}

const quietUi = {
  onWaitStart() {}, onWaitEnd() {}, onToken() {}, onTextEnd() {},
  onToolUse() {}, onToolResult() {}, async confirm() { return true; },
};

function tool(name, description, properties = {}, required = []) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false },
    },
  };
}

function assistantCalls(messages) {
  return messages.flatMap((message) => message.role === "assistant" ? (message.tool_calls || []) : []);
}

function toolContents(messages) {
  return messages.filter((message) => message.role === "tool").map((message) => message.content || "");
}

async function runToolAgent(runtime, { prompt, tools, dispatch, parallelSafe, limits, system = "" }) {
  const messages = [{ role: "user", content: prompt }];
  const started = performance.now();
  const result = await runAgentTurn(runtime.client, messages, {
    model: runtime.model,
    tools,
    dispatch,
    confirmNeeded: () => false,
    parallelSafe,
    ui: quietUi,
    suppressText: true,
    limits: { deadlineMs: 120_000, ...(limits || {}) },
    ...(system ? { system } : {}),
  });
  return { messages, result, durationMs: performance.now() - started };
}

const READ_TOOLS = [
  tool("query_repository_status", "只读查询仓库状态。必须与另外两个状态查询在同一轮一起调用。"),
  tool("query_test_status", "只读查询测试状态。必须与另外两个状态查询在同一轮一起调用。"),
  tool("query_dependency_status", "只读查询依赖状态。必须与另外两个状态查询在同一轮一起调用。"),
];

async function parallelRun(runtime, parallel, delayMs, runId) {
  const intervals = [];
  const registry = new ToolRegistry({
    tools: READ_TOOLS,
    policies: new Map(READ_TOOLS.map((entry) => [entry.function.name, {
      idempotent: true, maxRetries: 0, timeoutMs: 5000,
    }])),
    dispatch: async (name) => {
      const started = performance.now();
      await sleep(delayMs);
      const ended = performance.now();
      intervals.push({ name, started, ended });
      return JSON.stringify({ ok: true, source: name, runId, value: `${name}-verified` });
    },
  });
  const outcome = await runToolAgent(runtime, {
    tools: READ_TOOLS,
    prompt: "请同时查询仓库、测试和依赖三项状态。必须在同一条回复中一次性调用三个工具，拿到全部结果后再总结，不得省略。",
    dispatch: (name, args, context) => registry.run(name, args, context),
    parallelSafe: () => parallel,
    limits: { maxIterations: 4, maxToolCalls: 6 },
  });
  const calls = assistantCalls(outcome.messages);
  const results = toolContents(outcome.messages);
  const names = new Set(intervals.map((entry) => entry.name));
  const correct = READ_TOOLS.every((entry) => names.has(entry.function.name))
    && results.filter((content) => content.includes("verified")).length === 3;
  const executionSpanMs = intervals.length
    ? Math.max(...intervals.map((entry) => entry.ended)) - Math.min(...intervals.map((entry) => entry.started))
    : 0;
  return {
    correct,
    oneBatch: calls.length >= 3
      && outcome.messages.some((message) => message.role === "assistant" && message.tool_calls?.length === 3),
    durationMs: outcome.durationMs,
    executionSpanMs,
  };
}

async function measureParallel(runtime, runs, delayMs) {
  const serial = [];
  const parallel = [];
  for (let i = 0; i < runs; i++) {
    serial.push(await parallelRun(runtime, false, delayMs, `serial-${i}`));
    parallel.push(await parallelRun(runtime, true, delayMs, `parallel-${i}`));
  }
  const serialSpan = median(serial.map((item) => item.executionSpanMs));
  const parallelSpan = median(parallel.map((item) => item.executionSpanMs));
  const serialEnd = median(serial.map((item) => item.durationMs));
  const parallelEnd = median(parallel.map((item) => item.durationMs));
  return {
    runsPerMode: runs,
    resultConsistencyRate: pct(
      [...serial, ...parallel].filter((item) => item.correct).length,
      runs * 2,
    ),
    sameBatchCallRate: pct(
      [...serial, ...parallel].filter((item) => item.oneBatch).length,
      runs * 2,
    ),
    serialMedianToolSpanMs: Math.round(serialSpan),
    parallelMedianToolSpanMs: Math.round(parallelSpan),
    toolSpanReductionRate: pct(serialSpan - parallelSpan, serialSpan),
    serialMedianEndToEndMs: Math.round(serialEnd),
    parallelMedianEndToEndMs: Math.round(parallelEnd),
    endToEndReductionRate: pct(serialEnd - parallelEnd, serialEnd),
  };
}

async function withMcpConfig(config, run) {
  const previous = process.cwd();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-deepseek-mcp-"));
  try {
    await fs.writeFile(path.join(temp, "mcp.json"), JSON.stringify(config), "utf8");
    process.chdir(temp);
    return await run();
  } finally {
    process.chdir(previous);
    await fs.rm(temp, { recursive: true, force: true });
  }
}

function makeHttpFixture() {
  const server = new McpServer({ name: "deepseek-ab-http", version: "1.0.0" });
  server.registerTool("echo", {
    description: "只读回显给定文本。",
    inputSchema: { text: z.string().min(1) },
    outputSchema: { echoed: z.string() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ text }) => ({
    content: [{ type: "text", text }],
    structuredContent: { echoed: text },
  }));
  return server;
}

function callSchemaValid(entry, schemas) {
  try {
    const args = JSON.parse(entry.function.arguments || "{}");
    return validateArgs(schemas.get(entry.function.name), args).length === 0;
  } catch {
    return false;
  }
}

async function runMcpAgent(runtime, config, expectedTool, prompt, expectedText) {
  return withMcpConfig(config, async () => {
    const manager = new McpManager();
    try {
      await manager.init();
      const discovered = manager.status.length === 1
        && manager.status[0].ok
        && manager.tools.some((entry) => entry.function.name === expectedTool);
      const registry = new ToolRegistry({
        tools: manager.tools,
        policies: manager.policies,
        dispatch: (name, args, context) => manager.call(name, args, context),
      });
      const outcome = await runToolAgent(runtime, {
        tools: manager.tools,
        prompt,
        dispatch: (name, args, context) => registry.run(name, args, context),
        parallelSafe: (name) => !!manager.policies.get(name)?.parallelSafe,
        limits: { maxIterations: 4, maxToolCalls: 4 },
      });
      const schemas = new Map(manager.tools.map((entry) => [entry.function.name, entry.function.parameters]));
      const calls = assistantCalls(outcome.messages).filter((entry) => entry.function.name === expectedTool);
      const validCalls = calls.filter((entry) => callSchemaValid(entry, schemas)).length;
      const called = toolContents(outcome.messages).some((content) => content.includes(expectedText));
      return { discovered, called, calls: calls.length, validCalls };
    } finally {
      await manager.closeAll();
    }
  });
}

async function measureMcp(runtime, runs) {
  const demo = path.join(ROOT, "mcp-servers", "demo-server.js");
  const app = createMcpExpressApp();
  app.post("/mcp", async (req, res) => {
    const server = makeHttpFixture();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => { transport.close(); server.close(); });
  });
  const httpServer = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const port = httpServer.address().port;
  const results = [];
  try {
    for (let i = 0; i < runs; i++) {
      results.push(await runMcpAgent(
        runtime,
        { mcpServers: { demo: { command: process.execPath, args: [demo] } } },
        "mcp__demo__add",
        `必须调用 MCP 加法工具计算 ${40 + i} + 2，得到工具证据后只回答结果。`,
        `\"sum\":${42 + i}`,
      ));
      results.push(await runMcpAgent(
        runtime,
        { mcpServers: { remote: { url: `http://127.0.0.1:${port}/mcp` } } },
        "mcp__remote__echo",
        `必须调用 MCP 回显工具原样回显 TOKEN-${i}，得到工具证据后只回答结果。`,
        `TOKEN-${i}`,
      ));
    }
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  const calls = results.reduce((sum, item) => sum + item.calls, 0);
  const validCalls = results.reduce((sum, item) => sum + item.validCalls, 0);
  return {
    groups: results.length,
    transports: ["stdio", "streamable-http"],
    discoverySuccessRate: pct(results.filter((item) => item.discovered).length, results.length),
    callTaskSuccessRate: pct(results.filter((item) => item.called).length, results.length),
    toolCalls: calls,
    schemaValidCalls: validCalls,
    parameterSchemaValidRate: pct(validCalls, calls),
  };
}

const RECOVERY_TOOL = tool("lookup_release_evidence", "查询发布证据；这是只读、幂等工具。", {
  release_id: { type: "string", pattern: "^REL-[0-9]+$" },
}, ["release_id"]);

async function recoveryRun(runtime, retries, index) {
  const attempts = new Map();
  const events = [];
  const expected = `EVIDENCE-${index}`;
  const registry = new ToolRegistry({
    tools: [RECOVERY_TOOL],
    policies: new Map([["lookup_release_evidence", {
      idempotent: true, maxRetries: retries, timeoutMs: 5000,
    }]]),
    onEvent: (event) => events.push(event),
    dispatch: async (_name, args, context) => {
      const key = context.executionId;
      const count = (attempts.get(key) || 0) + 1;
      attempts.set(key, count);
      if (count === 1) throw new Error("network timeout: injected transient failure");
      return JSON.stringify({ ok: true, releaseId: args.release_id, evidence: expected });
    },
  });
  const outcome = await runToolAgent(runtime, {
    tools: [RECOVERY_TOOL],
    prompt: `请查询 REL-${1000 + index} 的发布证据。必须以工具结果为准；失败时不要猜测。最终答案必须包含证据编号。`,
    dispatch: (name, args, context) => registry.run(name, args, context),
    parallelSafe: () => true,
    limits: { maxIterations: 6, maxToolCalls: 6, maxConsecutiveErrors: 2, maxRecoveryAttempts: 1 },
  });
  const hasEvidence = toolContents(outcome.messages).some((content) => content.includes(expected));
  const final = outcome.result.finalContent || "";
  return {
    completed: hasEvidence && final.includes(expected),
    retries: events.filter((event) => event.type === "retry").length,
    stopped: outcome.result.stopped || "",
  };
}

async function measureRecovery(runtime, runs) {
  const disabled = [];
  const enabled = [];
  for (let i = 0; i < runs; i++) {
    disabled.push(await recoveryRun(runtime, 0, i));
    enabled.push(await recoveryRun(runtime, 1, i));
  }
  return {
    injectedTasksPerMode: runs,
    withoutRetryCompletionRate: pct(disabled.filter((item) => item.completed).length, runs),
    withRetryCompletionRate: pct(enabled.filter((item) => item.completed).length, runs),
    retryEvents: enabled.reduce((sum, item) => sum + item.retries, 0),
  };
}

function makeFileRegistry(root) {
  return new ToolRegistry({
    tools: builtinTools,
    policies: toolPolicies,
    checkpointManager: new FileCheckpointManager({ root }),
    dispatch: (name, args, context) => handlers[name](args, context),
  });
}

async function measureCheckpoint(runs) {
  const previousWorkspace = getWorkspace();
  let checks = 0;
  let passed = 0;
  try {
    for (let i = 0; i < runs; i++) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-deepseek-checkpoint-"));
      try {
        setWorkspace(root);
        const target = path.join(root, "value.js");
        await fs.writeFile(target, "export const value = 1;\n", "utf8");

        let registry = makeFileRegistry(root);
        await registry.run("edit_file", { path: "value.js", old_str: "value = 1", new_str: "value = 2" });
        try { await registry.run("run_command", { command: "node -e \"process.exit(2)\"" }); } catch {}
        checks++;
        passed += Number((await fs.readFile(target, "utf8")) === "export const value = 1;\n");

        registry = makeFileRegistry(root);
        await registry.run("edit_file", { path: "value.js", old_str: "value = 1", new_str: "value = 2" });
        await fs.writeFile(target, "export const value = 99; // external\n", "utf8");
        try { await registry.run("run_command", { command: "node -e \"process.exit(2)\"" }); } catch {}
        checks++;
        passed += Number((await fs.readFile(target, "utf8")) === "export const value = 99; // external\n");

        await fs.writeFile(target, "export const value = 1;\n", "utf8");
        registry = makeFileRegistry(root);
        await registry.run("edit_file", { path: "value.js", old_str: "value = 1", new_str: "value = 2" });
        await registry.run("run_command", { command: "node -e \"console.log('PASS')\"" });
        checks++;
        passed += Number((await fs.readFile(target, "utf8")) === "export const value = 2;\n");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    setWorkspace(previousWorkspace);
  }
  return { checks, passed, passRate: pct(passed, checks) };
}

function contextCase(index) {
  const goal = `GOAL-ORION-${index}`;
  const steps = Array.from({ length: 6 }, (_, i) => `STEP-${index}-${i + 1}`);
  const noise = (block) => Array.from(
    { length: 180 },
    (_, i) => `noise-${block}-${i}: unrelated module inspected; no action required`,
  ).join("\n");
  const messages = [
    { role: "user", content: `原始目标编号 ${goal}。必须完成这些步骤：${steps.join("、")}。不得遗漏。` },
    { role: "assistant", content: `目标已记录。\n${noise(1)}` },
    { role: "user", content: `保持原目标不变。以下是无关排查信息：\n${noise(2)}` },
    { role: "assistant", content: `已排除无关项。\n${noise(3)}` },
    { role: "user", content: `继续排查，不要改变既定步骤。\n${noise(4)}` },
    { role: "assistant", content: `继续执行。\n${noise(5)}` },
    { role: "user", content: "现在汇报原始目标编号和仍需遵循的全部步骤编号。" },
  ];
  return { goal, steps, messages };
}

async function recall(runtime, messages, system = "") {
  const response = await runtime.client.chat.completions.create({
    model: runtime.model,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      ...messages,
    ],
    temperature: 0,
  });
  return {
    content: response.choices?.[0]?.message?.content || "",
    inputTokens: response.usage?.prompt_tokens || 0,
  };
}

function recentWindow(messages, keepUserTurns = 2) {
  const users = [];
  messages.forEach((message, index) => { if (message.role === "user") users.push(index); });
  return messages.slice(users[Math.max(0, users.length - keepUserTurns)] || 0);
}

async function measureContext(runtime, runs) {
  let recentMissing = 0;
  let enhancedMissing = 0;
  let enhancedGoals = 0;
  const fullTokens = [];
  const enhancedTokens = [];
  for (let i = 0; i < runs; i++) {
    const sample = contextCase(i);
    const question = "只输出原始目标编号和六个步骤编号，不要解释。";
    const recent = await recall(runtime, [...recentWindow(sample.messages), { role: "user", content: question }]);
    const full = await recall(runtime, [...sample.messages, { role: "user", content: question }]);

    const compacted = await compact(runtime.client, runtime.model, sample.messages, { keepTurns: 2 });
    const plan = new PlanState();
    plan.update({
      explanation: `保持 ${sample.goal}`,
      steps: sample.steps.map((id, stepIndex) => ({
        id,
        description: `执行步骤 ${id}`,
        status: stepIndex === 0 ? "in_progress" : "pending",
        acceptance: `${id} 完成并有证据`,
      })),
    });
    const enhanced = await recall(
      runtime,
      [...(compacted || sample.messages), { role: "user", content: question }],
      `必须以原始目标和当前结构化计划为准。${plan.prompt()}`,
    );
    recentMissing += sample.steps.filter((step) => !recent.content.includes(step)).length;
    enhancedMissing += sample.steps.filter((step) => !enhanced.content.includes(step)).length;
    enhancedGoals += Number(enhanced.content.includes(sample.goal));
    fullTokens.push(full.inputTokens);
    enhancedTokens.push(enhanced.inputTokens);
  }
  const totalSteps = runs * 6;
  const fullAverage = mean(fullTokens);
  const enhancedAverage = mean(enhancedTokens);
  return {
    runs,
    recentWindowMissedStepRate: pct(recentMissing, totalSteps),
    summaryAndPlanMissedStepRate: pct(enhancedMissing, totalSteps),
    enhancedGoalRetentionRate: pct(enhancedGoals, runs),
    fullHistoryAverageInputTokens: Math.round(fullAverage),
    compactedPlanAverageInputTokens: Math.round(enhancedAverage),
    inputTokenReductionRate: pct(fullAverage - enhancedAverage, fullAverage),
    comparisonNote: "漏步骤率以近期窗口为基线；Token 降幅以完整未压缩历史为基线。",
  };
}

function markdown(report) {
  const e = report.experiments;
  return [
    "# DeepSeek 驱动的 minicode A/B 量化报告", "",
    `- 模型：${report.model}`,
    `- 每组重复次数：${report.runs}`,
    `- 时间：${report.createdAt}`, "",
    "## 核心引擎：只读工具并行", "",
    `- 结果一致率：${e.parallel.resultConsistencyRate}%`,
    `- 三工具同批调用率：${e.parallel.sameBatchCallRate}%`,
    `- 工具执行区间中位数：${e.parallel.serialMedianToolSpanMs}ms → ${e.parallel.parallelMedianToolSpanMs}ms（降低 ${e.parallel.toolSpanReductionRate}%）`,
    `- Agent 端到端中位数：${e.parallel.serialMedianEndToEndMs}ms → ${e.parallel.parallelMedianEndToEndMs}ms（降低 ${e.parallel.endToEndReductionRate}%）`, "",
    "## MCP 与工具调用", "",
    `- stdio / Streamable HTTP 发现与调用测试：${e.mcp.groups} 组`,
    `- 工具发现成功率：${e.mcp.discoverySuccessRate}%`,
    `- 调用任务成功率：${e.mcp.callTaskSuccessRate}%`,
    `- 参数 Schema 合法率：${e.mcp.parameterSchemaValidRate}%（${e.mcp.schemaValidCalls}/${e.mcp.toolCalls}）`, "",
    "## 错误恢复与文件保护", "",
    `- 注入瞬时故障：每种模式 ${e.recovery.injectedTasksPerMode} 个任务`,
    `- 关闭有限重试完成率：${e.recovery.withoutRetryCompletionRate}%`,
    `- 开启有限重试完成率：${e.recovery.withRetryCompletionRate}%`,
    `- checkpoint / SHA-256 安全检查：${e.checkpoint.passed}/${e.checkpoint.checks}（${e.checkpoint.passRate}%）`, "",
    "## 任务规划与上下文", "",
    `- 仅保留近期窗口的漏步骤率：${e.context.recentWindowMissedStepRate}%`,
    `- 摘要 + 独立 Plan 的漏步骤率：${e.context.summaryAndPlanMissedStepRate}%`,
    `- 目标保持率：${e.context.enhancedGoalRetentionRate}%`,
    `- 平均输入 Token：${e.context.fullHistoryAverageInputTokens} → ${e.context.compactedPlanAverageInputTokens}（降低 ${e.context.inputTokenReductionRate}%）`,
    `- 口径：${e.context.comparisonNote}`, "",
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(help()); return; }
  const runtime = createModelRuntime({ argv: ["--provider", options.provider] });
  await runtime.check();

  console.log("[1/4] DeepSeek 只读工具并行 A/B...");
  const parallel = await measureParallel(runtime, options.runs, options.delayMs);
  console.log("[2/4] DeepSeek MCP stdio / Streamable HTTP 发现与调用...");
  const mcp = await measureMcp(runtime, options.runs);
  console.log("[3/4] DeepSeek 故障恢复 A/B 与 checkpoint...");
  const recovery = await measureRecovery(runtime, options.runs);
  const checkpoint = await measureCheckpoint(options.runs);
  console.log("[4/4] DeepSeek 长上下文 Plan / 摘要 A/B...");
  const context = await measureContext(runtime, options.runs);

  const report = {
    createdAt: new Date().toISOString(),
    provider: runtime.provider,
    model: runtime.model,
    runs: options.runs,
    experiments: { parallel, mcp, recovery, checkpoint, context },
  };
  const resultsDir = path.join(ROOT, "benchmark", "results");
  await fs.mkdir(resultsDir, { recursive: true });
  const stamp = report.createdAt.replace(/[:.]/g, "-");
  const jsonPath = path.resolve(options.output || path.join(resultsDir, `deepseek-ab-${stamp}.json`));
  const mdPath = jsonPath.replace(/\.json$/i, ".md");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(mdPath, markdown(report), "utf8");
  console.log("\n" + markdown(report));
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${mdPath}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
