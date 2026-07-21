#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";

import { runAgentTurn } from "../src/agent.js";
import { compact, estimateTokens } from "../src/context.js";
import { FileCheckpointManager } from "../src/core/checkpoint.js";
import { ToolRegistry } from "../src/core/registry.js";
import { McpManager } from "../src/mcp.js";
import { createModelRuntime } from "../src/model.js";
import { formatFinalOutput, resolveOutputContract } from "../src/output.js";
import { PlanState } from "../src/plan.js";
import { getWorkspace, handlers, setWorkspace, toolPolicies, tools } from "../src/tools.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pct = (n, d) => d ? Number((100 * n / d).toFixed(2)) : null;
const round = (n, digits = 2) => Number(n.toFixed(digits));
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function parseArgs(argv) {
  const options = { provider: "ollama", runs: 3, microRuns: 5, output: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--provider") options.provider = argv[++i];
    else if (arg === "--runs") options.runs = Number(argv[++i]);
    else if (arg === "--micro-runs") options.microRuns = Number(argv[++i]);
    else if (arg === "--output") options.output = argv[++i];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 10) {
    throw new Error("--runs 必须是 1-10 的整数");
  }
  if (!Number.isInteger(options.microRuns) || options.microRuns < 1 || options.microRuns > 50) {
    throw new Error("--micro-runs 必须是 1-50 的整数");
  }
  return options;
}

function help() {
  return `minicode 贡献量化实验

用法：
  node benchmark/quantify.js --provider ollama --runs 3 --micro-runs 5

--runs        本地模型实验重复次数（1-10）
--micro-runs  确定性集成实验重复次数（1-50）
--output      自定义 JSON 报告路径`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function streamResponse({ calls = null, content = "", promptTokens = 10, completionTokens = 2 }) {
  return {
    async *[Symbol.asyncIterator]() {
      if (calls?.length) {
        yield {
          choices: [{ delta: { tool_calls: calls.map((call, index) => ({
            index,
            id: call.id || `call-${randomUUID()}`,
            function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
          })) } }],
        };
      } else {
        yield { choices: [{ delta: { content } }] };
      }
      yield { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } };
    },
  };
}

const quietUi = {
  onWaitStart() {}, onWaitEnd() {}, onToken() {}, onTextEnd() {},
  onToolUse() {}, onToolResult() {}, async confirm() { return true; },
};

async function schedulingRun(parallelSafe) {
  let modelTurn = 0;
  const calls = [1, 2, 3].map((id) => ({ name: "probe", args: { id } }));
  const client = {
    chat: { completions: { create: async () => {
      modelTurn++;
      return modelTurn === 1
        ? streamResponse({ calls })
        : streamResponse({ content: "三个查询均完成" });
    } } },
  };
  const messages = [{ role: "user", content: "并行读取三个互不依赖的数据源" }];
  const started = performance.now();
  await runAgentTurn(client, messages, {
    model: "scripted",
    tools: [{
      type: "function",
      function: {
        name: "probe",
        parameters: {
          type: "object",
          properties: { id: { type: "integer" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
    }],
    dispatch: async (_name, args) => {
      await sleep(150);
      return JSON.stringify({ ok: true, id: args.id });
    },
    confirmNeeded: () => false,
    parallelSafe: () => parallelSafe,
    ui: quietUi,
  });
  const toolResults = messages.filter((message) => message.role === "tool");
  return {
    durationMs: performance.now() - started,
    correct: toolResults.length === 3 && toolResults.every((message) => /"ok":true/.test(message.content)),
  };
}

async function measureScheduling(runs) {
  const sequential = [];
  const parallel = [];
  let correct = 0;
  for (let i = 0; i < runs; i++) {
    const seq = await schedulingRun(false);
    const par = await schedulingRun(true);
    sequential.push(seq.durationMs);
    parallel.push(par.durationMs);
    correct += Number(seq.correct) + Number(par.correct);
  }
  const seqMedian = median(sequential);
  const parMedian = median(parallel);
  return {
    runsPerMode: runs,
    toolCallsPerRun: 3,
    correctnessRate: pct(correct, runs * 2),
    sequentialMedianMs: Math.round(seqMedian),
    parallelMedianMs: Math.round(parMedian),
    medianLatencyReductionRate: pct(seqMedian - parMedian, seqMedian),
    speedup: round(seqMedian / parMedian),
  };
}

async function withMcpConfig(config, run) {
  const previous = process.cwd();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-quant-mcp-"));
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
  const server = new McpServer({ name: "quant-http", version: "1.0.0" });
  server.registerTool("echo", {
    description: "结构化回显",
    inputSchema: { text: z.string() },
    outputSchema: { echoed: z.string() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ text }) => ({
    content: [{ type: "text", text }],
    structuredContent: { echoed: text },
  }));
  return server;
}

async function measureMcp(runs) {
  const demo = path.join(ROOT, "mcp-servers", "demo-server.js");
  let successes = 0;
  let operations = 0;
  const latencies = [];

  await withMcpConfig({
    mcpServers: { demo: { command: process.execPath, args: [demo] } },
  }, async () => {
    const manager = new McpManager();
    try {
      const start = performance.now();
      await manager.init();
      latencies.push(performance.now() - start);
      operations++;
      successes += Number(
        manager.tools.some((tool) => tool.function.name === "mcp__demo__add")
        && manager.tools.some((tool) => tool.function.name === "read_mcp_resource")
      );
      for (let i = 0; i < runs; i++) {
        let before = performance.now();
        const sum = await manager.callTool("mcp__demo__add", { a: i, b: 7 });
        latencies.push(performance.now() - before);
        operations++;
        successes += Number(sum.structuredContent?.sum === i + 7);

        before = performance.now();
        const listed = await manager.listResources("demo");
        latencies.push(performance.now() - before);
        operations++;
        successes += Number(listed.resources.some((resource) => resource.uri === "demo://minicode/mcp-guide"));

        before = performance.now();
        const resource = await manager.readResource("demo", "demo://minicode/mcp-guide");
        latencies.push(performance.now() - before);
        operations++;
        successes += Number(resource.contents.some((item) => /Resources 发现/.test(item.text || "")));
      }
    } finally {
      await manager.closeAll();
    }
  });

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
  try {
    const address = httpServer.address();
    await withMcpConfig({
      mcpServers: { remote: { url: `http://127.0.0.1:${address.port}/mcp` } },
    }, async () => {
      const manager = new McpManager();
      try {
        const start = performance.now();
        await manager.init();
        latencies.push(performance.now() - start);
        operations++;
        successes += Number(manager.tools.some((tool) => tool.function.name === "mcp__remote__echo"));
        for (let i = 0; i < runs; i++) {
          const text = `echo-${i}`;
          const before = performance.now();
          const result = await manager.callTool("mcp__remote__echo", { text });
          latencies.push(performance.now() - before);
          operations++;
          successes += Number(result.structuredContent?.echoed === text);
        }
      } finally {
        await manager.closeAll();
      }
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }

  return {
    transports: ["stdio", "streamable-http"],
    operations,
    successfulOperations: successes,
    successRate: pct(successes, operations),
    averageOperationMs: Math.round(mean(latencies)),
  };
}

function queryTool() {
  return {
    type: "function",
    function: {
      name: "query",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  };
}

async function measureRetry(runs) {
  let withRetrySuccess = 0;
  let withoutRetrySuccess = 0;
  let totalRetryEvents = 0;
  for (let i = 0; i < runs; i++) {
    let attempts = 0;
    const events = [];
    const enabled = new ToolRegistry({
      tools: [queryTool()],
      policies: new Map([["query", { idempotent: true, maxRetries: 1, timeoutMs: 5000 }]]),
      onEvent: (event) => events.push(event),
      dispatch: async () => {
        attempts++;
        if (attempts === 1) throw new Error("network timeout");
        return "ok";
      },
    });
    try {
      withRetrySuccess += Number((await enabled.run("query", {})) === "ok");
    } catch { /* 记为失败 */ }
    totalRetryEvents += events.filter((event) => event.type === "retry").length;

    attempts = 0;
    const disabled = new ToolRegistry({
      tools: [queryTool()],
      policies: new Map([["query", { idempotent: true, maxRetries: 0, timeoutMs: 5000 }]]),
      dispatch: async () => {
        attempts++;
        if (attempts === 1) throw new Error("network timeout");
        return "ok";
      },
    });
    try {
      withoutRetrySuccess += Number((await disabled.run("query", {})) === "ok");
    } catch { /* 预期失败 */ }
  }
  return {
    injectedTransientFailuresPerMode: runs,
    withoutRetrySuccessRate: pct(withoutRetrySuccess, runs),
    withRetrySuccessRate: pct(withRetrySuccess, runs),
    retryEvents: totalRetryEvents,
  };
}

async function loopGuardRun(enabled) {
  let modelCalls = 0;
  let dispatchCalls = 0;
  const client = {
    chat: { completions: { create: async (request) => {
      modelCalls++;
      const forcedFinal = !request.tools;
      return forcedFinal
        ? streamResponse({ content: "已停止重复调用并说明未完成内容" })
        : streamResponse({ calls: [{ name: "probe", args: { key: "same" } }] });
    } } },
  };
  const result = await runAgentTurn(client, [{ role: "user", content: "重复调用测试" }], {
    model: "scripted",
    tools: [{ type: "function", function: { name: "probe", parameters: { type: "object" } } }],
    dispatch: async () => { dispatchCalls++; return "相同结果"; },
    confirmNeeded: () => false,
    parallelSafe: () => true,
    ui: quietUi,
    limits: {
      maxIterations: 6,
      maxToolCalls: 20,
      maxSameCall: enabled ? 2 : 999,
      maxSameResult: enabled ? 2 : 999,
      maxConsecutiveErrors: 999,
      maxRecoveryAttempts: enabled ? 1 : 0,
      deadlineMs: 60_000,
    },
  });
  return { dispatchCalls, modelCalls, stopped: result.stopped };
}

async function measureLoopGuard(runs) {
  const enabled = [];
  const disabled = [];
  for (let i = 0; i < runs; i++) {
    enabled.push(await loopGuardRun(true));
    disabled.push(await loopGuardRun(false));
  }
  const enabledCalls = mean(enabled.map((item) => item.dispatchCalls));
  const disabledCalls = mean(disabled.map((item) => item.dispatchCalls));
  return {
    runsPerMode: runs,
    guardAverageRepeatedCalls: round(enabledCalls),
    iterationLimitAverageRepeatedCalls: round(disabledCalls),
    repeatedCallsReductionRate: pct(disabledCalls - enabledCalls, disabledCalls),
    guardControlledStopRate: pct(enabled.filter((item) => item.stopped === "repeated_tool_call").length, runs),
  };
}

function makeFileRegistry(root, events = []) {
  return new ToolRegistry({
    tools,
    policies: toolPolicies,
    checkpointManager: new FileCheckpointManager({ root }),
    onEvent: (event) => events.push(event),
    dispatch: (name, args, context) => handlers[name](args, context),
  });
}

async function measureCheckpoint(runs) {
  const previousWorkspace = getWorkspace();
  let checks = 0;
  let passed = 0;
  for (let i = 0; i < runs; i++) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-quant-checkpoint-"));
    try {
      setWorkspace(temp);
      const target = path.join(temp, "value.js");
      await fs.writeFile(target, "export const value = 1;\n", "utf8");

      let registry = makeFileRegistry(temp);
      await registry.run("edit_file", { path: "value.js", old_str: "value = 1", new_str: "value = 2" });
      try { await registry.run("run_command", { command: 'node -e "process.exit(2)"' }); } catch { /* 预期失败 */ }
      checks++;
      passed += Number((await fs.readFile(target, "utf8")) === "export const value = 1;\n");

      registry = makeFileRegistry(temp);
      await registry.run("edit_file", { path: "value.js", old_str: "value = 1", new_str: "value = 2" });
      await fs.writeFile(target, "export const value = 99; // external\n", "utf8");
      try { await registry.run("run_command", { command: 'node -e "process.exit(2)"' }); } catch { /* 预期失败 */ }
      checks++;
      passed += Number((await fs.readFile(target, "utf8")) === "export const value = 99; // external\n");

      await fs.writeFile(target, "export const value = 1;\n", "utf8");
      registry = makeFileRegistry(temp);
      await registry.run("edit_file", { path: "value.js", old_str: "value = 1", new_str: "value = 2" });
      await registry.run("run_command", { command: 'node -e "console.log(\'PASS\')"' });
      checks++;
      passed += Number((await fs.readFile(target, "utf8")) === "export const value = 2;\n");
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
  setWorkspace(previousWorkspace);
  return {
    runs,
    checks,
    passed,
    safetyCheckPassRate: pct(passed, checks),
  };
}

function longHistory(seed) {
  const noise = Array.from({ length: 120 }, (_, index) => `日志${index}: 已检查无关模块 module-${seed}-${index}`).join("；");
  return [
    { role: "user", content: `原始目标：把 ORION-${seed} 的端口从 4312 改为 5312；不可修改 notes.txt。` },
    { role: "assistant", content: `已确认约束和目标。${noise}` },
    { role: "user", content: `额外约束：必须运行 verify-${seed}.js，失败方案 OLD-${seed} 不要重复。` },
    { role: "assistant", content: `已记录验证要求。${noise}` },
    { role: "user", content: "现在开始定位配置文件。" },
    { role: "assistant", content: "已定位 config/app.json。" },
    { role: "user", content: "继续修改并验证。" },
  ];
}

async function measureContext(runtime, runs) {
  const reductions = [];
  let summaryRetention = 0;
  let truncationRetention = 0;
  let planRetention = 0;
  for (let i = 0; i < runs; i++) {
    const messages = longHistory(i);
    const before = estimateTokens(messages);
    const compacted = await compact(runtime.client, runtime.model, messages, { keepTurns: 2 });
    const after = estimateTokens(compacted || messages);
    reductions.push(pct(before - after, before));
    const compactedText = JSON.stringify(compacted || messages);
    const required = [`ORION-${i}`, "4312", "5312", "notes.txt", `verify-${i}.js`, `OLD-${i}`];
    summaryRetention += Number(required.every((value) => compactedText.includes(value)));

    const directWindow = messages.slice(4);
    const windowText = JSON.stringify(directWindow);
    truncationRetention += Number(required.every((value) => windowText.includes(value)));

    const plan = new PlanState();
    plan.update({ steps: [
      { id: "locate", description: "定位配置", status: "completed", evidence: "config/app.json" },
      { id: "edit", description: "修改端口", status: "in_progress", acceptance: "端口为 5312" },
      { id: "verify", description: "运行验证", status: "pending", acceptance: `verify-${i}.js 通过` },
    ] });
    planRetention += Number(/locate/.test(plan.prompt()) && /verify/.test(plan.prompt()) && /5312/.test(plan.prompt()));
  }
  return {
    runs,
    directWindowConstraintRetentionRate: pct(truncationRetention, runs),
    summaryConstraintRetentionRate: pct(summaryRetention, runs),
    averageEstimatedTokenReductionRate: round(mean(reductions)),
    planStateRetentionRate: pct(planRetention, runs),
  };
}

async function measureStructuredOutput(runtime, runs) {
  const contract = resolveOutputContract("task_result");
  let successes = 0;
  let firstPass = 0;
  let repaired = 0;
  const attempts = [];
  for (let i = 0; i < runs; i++) {
    try {
      const result = await formatFinalOutput(runtime.client, runtime.model, {
        goal: `修复 demo-${i}.js 并运行 node verify-${i}.js`,
        draft: `已修改 demo-${i}.js；node verify-${i}.js 输出 PASS；没有剩余问题。`,
        contract,
      });
      successes++;
      attempts.push(result.attempts);
      if (result.attempts === 1) firstPass++;
      else repaired++;
    } catch {
      attempts.push(3);
    }
  }
  return {
    runs,
    firstPassSchemaValidRate: pct(firstPass, runs),
    finalSchemaValidRate: pct(successes, runs),
    repairedOutputs: repaired,
    averageAttempts: round(mean(attempts)),
  };
}

function markdown(report) {
  const e = report.experiments;
  return [
    "# minicode 贡献量化实验", "",
    `- 模型：${report.model}（${report.provider}，thinking=${report.think}）`,
    `- 模型实验重复：${report.modelRuns}`,
    `- 确定性实验重复：${report.microRuns}`,
    `- 时间：${report.createdAt}`, "",
    "## 核心循环与并行调度", "",
    `- 结果一致率：${e.scheduling.correctnessRate}%`,
    `- 三工具串行中位耗时：${e.scheduling.sequentialMedianMs}ms`,
    `- 三工具并行中位耗时：${e.scheduling.parallelMedianMs}ms`,
    `- 中位延迟降低：${e.scheduling.medianLatencyReductionRate}%（${e.scheduling.speedup}x）`, "",
    "## MCP", "",
    `- 覆盖传输：${e.mcp.transports.join("、")}`,
    `- 发现/调用/Resource 操作：${e.mcp.successfulOperations}/${e.mcp.operations}`,
    `- 操作成功率：${e.mcp.successRate}%`, "",
    "## 错误恢复、LoopGuard 与 checkpoint", "",
    `- 瞬时故障无重试成功率：${e.retry.withoutRetrySuccessRate}%`,
    `- 瞬时故障启用有限重试成功率：${e.retry.withRetrySuccessRate}%`,
    `- LoopGuard 重复调用减少：${e.loopGuard.repeatedCallsReductionRate}%`,
    `- LoopGuard 受控停止率：${e.loopGuard.guardControlledStopRate}%`,
    `- checkpoint 安全检查：${e.checkpoint.passed}/${e.checkpoint.checks}（${e.checkpoint.safetyCheckPassRate}%）`, "",
    "## 任务规划与上下文", "",
    `- 直接保留近期窗口的约束保持率：${e.context.directWindowConstraintRetentionRate}%`,
    `- 摘要压缩后的约束保持率：${e.context.summaryConstraintRetentionRate}%`,
    `- 估算 Token 平均降低：${e.context.averageEstimatedTokenReductionRate}%`,
    `- 独立 PlanState 保持率：${e.context.planStateRetentionRate}%`, "",
    "## 可选结构化输出", "",
    `- 首次 Schema 合法率：${e.structuredOutput.firstPassSchemaValidRate}%`,
    `- 本地校验和有限修复后的最终合法率：${e.structuredOutput.finalSchemaValidRate}%`,
    `- 平均生成次数：${e.structuredOutput.averageAttempts}`, "",
    "> 并行、MCP、故障注入、LoopGuard 和 checkpoint 是确定性工程实验；上下文摘要与结构化输出使用本地模型。不同类型结果不可混为同一模型能力分数。", "",
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(help()); return; }
  const runtime = createModelRuntime({ argv: ["--provider", options.provider] });
  await runtime.check();

  console.log("[1/6] 测量只读工具并行调度...");
  const scheduling = await measureScheduling(options.microRuns);
  console.log("[2/6] 测量 MCP stdio/Streamable HTTP...");
  const mcp = await measureMcp(options.microRuns);
  console.log("[3/6] 测量错误重试与 LoopGuard...");
  const retry = await measureRetry(options.microRuns);
  const loopGuard = await measureLoopGuard(options.microRuns);
  console.log("[4/6] 测量 checkpoint 回滚与冲突保护...");
  const checkpoint = await measureCheckpoint(options.microRuns);
  console.log("[5/6] 使用本地模型测量上下文压缩...");
  const context = await measureContext(runtime, options.runs);
  console.log("[6/6] 使用本地模型测量结构化输出...");
  const structuredOutput = await measureStructuredOutput(runtime, options.runs);

  const report = {
    createdAt: new Date().toISOString(),
    provider: runtime.provider,
    model: runtime.model,
    think: runtime.requestDefaults?.think ?? false,
    modelRuns: options.runs,
    microRuns: options.microRuns,
    experiments: { scheduling, mcp, retry, loopGuard, checkpoint, context, structuredOutput },
  };
  const resultsDir = path.join(ROOT, "benchmark", "results");
  await fs.mkdir(resultsDir, { recursive: true });
  const stamp = report.createdAt.replace(/[:.]/g, "-");
  const jsonPath = path.resolve(options.output || path.join(resultsDir, `quantify-${runtime.provider}-${stamp}.json`));
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
