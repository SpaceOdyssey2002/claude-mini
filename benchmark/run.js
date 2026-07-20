#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

import { AgentRunner } from "../src/core/runner.js";
import { Session } from "../src/core/memory.js";
import { getWorkspace, setWorkspace } from "../src/tools.js";
import { tasks, setupTask } from "./tasks.js";

function parseArgs(argv) {
  const out = { mode: "mock", runs: 1, task: "", output: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mode") out.mode = argv[++i];
    else if (arg === "--runs") out.runs = Number(argv[++i]);
    else if (arg === "--task") out.task = argv[++i];
    else if (arg === "--output") out.output = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isInteger(out.runs) || out.runs < 1 || out.runs > 10) throw new Error("--runs 必须是 1-10 的整数");
  if (!new Set(["mock", "real"]).has(out.mode)) throw new Error("--mode 只能是 mock 或 real");
  return out;
}

function help() {
  return `minicode 端到端 benchmark

用法：
  node benchmark/run.js --mode mock --runs 1
  node benchmark/run.js --mode real --runs 3
  node benchmark/run.js --mode real --task fix_and_test

真实模式需要 DEEPSEEK_API_KEY。结果写入 benchmark/results/。`;
}

function streamResponse({ calls = null, content = "", usage = { prompt_tokens: 20, completion_tokens: 5 } }) {
  return {
    async *[Symbol.asyncIterator]() {
      if (calls?.length) {
        yield {
          choices: [{ delta: { tool_calls: calls.map((call, index) => ({
            index,
            id: `mock-${randomUUID()}`,
            function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
          })) } }],
        };
      } else if (content) {
        yield { choices: [{ delta: { content } }] };
      }
      yield { choices: [], usage };
    },
  };
}

function makeMockClient(task) {
  let turn = 0;
  return {
    chat: { completions: { async create(request) {
      if (!request.stream) {
        return { choices: [{ message: { content: "结构化 benchmark 摘要" } }] };
      }
      const calls = task.mockTurns[turn++];
      return calls ? streamResponse({ calls }) : streamResponse({ content: task.mockFinal });
    } } },
  };
}

function makeRealClient() {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("真实 benchmark 需要 DEEPSEEK_API_KEY");
  return new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: "https://api.deepseek.com",
    maxRetries: 3,
    timeout: 120_000,
  });
}

function parseToolError(content) {
  try {
    const parsed = JSON.parse(content || "{}");
    return parsed?.ok === false ? parsed.error || {} : null;
  } catch {
    return null;
  }
}

function analyzeCalls(messages, events, allowedTools) {
  const toolMessages = new Map(
    messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m])
  );
  const calls = [];
  for (const message of messages) {
    for (const call of message.tool_calls || []) {
      let jsonValid = true;
      try { JSON.parse(call.function.arguments || "{}"); } catch { jsonValid = false; }
      const error = parseToolError(toolMessages.get(call.id)?.content);
      calls.push({
        name: call.function.name,
        jsonValid,
        schemaValid: jsonValid && error?.code !== "INVALID_TOOL_ARGUMENTS" && error?.code !== "INVALID_TOOL_ARGUMENTS_JSON",
        selectionValid: allowedTools.has(call.function.name),
        errorCode: error?.code || "",
      });
    }
  }
  const results = events.filter((e) => e.type === "tool_result");
  return {
    calls,
    results,
    successfulResults: results.filter((e) => e.ok).length,
    failedResults: results.filter((e) => !e.ok).length,
  };
}

async function cleanupSession(id) {
  for (const suffix of [".json", ".events.jsonl", ".trace.jsonl"]) {
    await fs.rm(path.join(Session.dir(), id + suffix), { force: true });
  }
}

async function runOne(task, runNumber, mode, realClient) {
  const originalCwd = process.cwd();
  const originalWorkspace = getWorkspace();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `minicode-bench-${task.id}-`));
  const sessionId = `bench-${task.id}-${runNumber}-${randomUUID().slice(0, 8)}`;
  let runner;
  const events = [];
  const startedAt = Date.now();
  try {
    await setupTask(task, root);
    process.chdir(root);
    setWorkspace(root);
    runner = await new AgentRunner({
      client: mode === "mock" ? makeMockClient(task) : realClient,
      model: mode === "mock" ? "mock-model" : (process.env.DEEPSEEK_MODEL || "deepseek-chat"),
      session: new Session(sessionId),
      autoApprove: true,
    }).init();
    const unsubscribe = runner.bus.subscribe((event) => events.push(event));
    let runResult;
    try {
      runResult = await runner.run(task.prompt);
    } finally {
      unsubscribe();
    }
    const finalText = [...runner.session.messages].reverse()
      .find((m) => m.role === "assistant" && typeof m.content === "string" && m.content)?.content || "";
    let assertions;
    try {
      assertions = await task.assert({ root, finalText, events, runResult });
    } catch (error) {
      assertions = [{ name: "验收代码执行", pass: false, detail: error.message }];
    }
    const metaTools = new Set(["update_plan", "take_note", "use_skill", "spawn_agent", "spawn_agents"]);
    const allowed = new Set([...task.allowedTools, ...metaTools]);
    const analysis = analyzeCalls(runner.session.messages, events, allowed);
    const observedFailure = analysis.failedResults > 0;
    const passed = !!runResult.ok && !runResult.aborted && !runResult.stopped && assertions.every((a) => a.pass);
    return {
      taskId: task.id,
      category: task.category,
      run: runNumber,
      passed,
      durationMs: Date.now() - startedAt,
      finalText,
      assertions,
      toolCalls: analysis.calls,
      toolResults: analysis.results.length,
      successfulToolResults: analysis.successfulResults,
      failedToolResults: analysis.failedResults,
      firstToolSucceeded: analysis.results.length ? !!analysis.results[0].ok : null,
      recoveryExpected: !!task.recoveryExpected,
      observedFailure,
      recovered: !!task.recoveryExpected && observedFailure && passed,
      stopped: runResult.stopped || "",
      usage: runResult.usage || { in: 0, out: 0, ctx: 0 },
    };
  } finally {
    await runner?.close();
    process.chdir(originalCwd);
    setWorkspace(originalWorkspace);
    await cleanupSession(sessionId);
    await fs.rm(root, { recursive: true, force: true });
  }
}

const pct = (n, d) => d ? Number((100 * n / d).toFixed(2)) : null;

function summarize(results) {
  const calls = results.flatMap((r) => r.toolCalls);
  const toolResults = results.reduce((n, r) => n + r.toolResults, 0);
  const successful = results.reduce((n, r) => n + r.successfulToolResults, 0);
  const expectedFailures = results.filter((r) => r.recoveryExpected && r.observedFailure).length;
  const allFailures = toolResults - successful;
  const unexpectedFailures = Math.max(0, allFailures - expectedFailures);
  const recoveryCases = results.filter((r) => r.recoveryExpected);
  const firstCalls = results.filter((r) => r.firstToolSucceeded !== null);
  return {
    runs: results.length,
    passed: results.filter((r) => r.passed).length,
    taskCompletionRate: pct(results.filter((r) => r.passed).length, results.length),
    toolCalls: calls.length,
    parameterJsonValidRate: pct(calls.filter((c) => c.jsonValid).length, calls.length),
    parameterSchemaValidRate: pct(calls.filter((c) => c.schemaValid).length, calls.length),
    toolPolicyComplianceRate: pct(calls.filter((c) => c.selectionValid).length, calls.length),
    toolExecutionSuccessRate: pct(successful, toolResults),
    unexpectedToolFailureRate: pct(unexpectedFailures, toolResults),
    firstToolSuccessRate: pct(firstCalls.filter((r) => r.firstToolSucceeded).length, firstCalls.length),
    recoveryCases: recoveryCases.length,
    recoverySuccessRate: pct(recoveryCases.filter((r) => r.recovered).length, recoveryCases.length),
    controlledStops: results.filter((r) => r.stopped).length,
    averageToolCallsPerRun: results.length ? Number((calls.length / results.length).toFixed(2)) : 0,
    totalInputTokens: results.reduce((n, r) => n + (r.usage.in || 0), 0),
    totalOutputTokens: results.reduce((n, r) => n + (r.usage.out || 0), 0),
    averageDurationMs: results.length ? Math.round(results.reduce((n, r) => n + r.durationMs, 0) / results.length) : 0,
  };
}

function markdown(report) {
  const s = report.summary;
  const lines = [
    `# minicode Benchmark`, "",
    `- 模式：${report.mode}`,
    `- 模型：${report.model}`,
    `- 时间：${report.createdAt}`,
    `- 任务运行数：${s.runs}`, "",
    "## 汇总", "",
    "| 指标 | 数值 |", "|---|---:|",
    `| 任务完成率 | ${s.taskCompletionRate}% |`,
    `| 参数 JSON 合法率 | ${s.parameterJsonValidRate}% |`,
    `| 参数 Schema 合法率 | ${s.parameterSchemaValidRate}% |`,
    `| 工具策略合规率 | ${s.toolPolicyComplianceRate}% |`,
    `| 工具执行成功率 | ${s.toolExecutionSuccessRate}% |`,
    `| 非预期工具失败率 | ${s.unexpectedToolFailureRate}% |`,
    `| 首次工具成功率 | ${s.firstToolSuccessRate}% |`,
    `| 错误恢复成功率 | ${s.recoverySuccessRate}% |`,
    `| 平均工具调用数 | ${s.averageToolCallsPerRun} |`, "",
    "## 分任务", "",
    "| 任务 | 类别 | 轮次 | 完成 | 工具调用 | 工具失败 | 耗时 |",
    "|---|---|---:|---:|---:|---:|---:|",
    ...report.results.map((r) => `| ${r.taskId} | ${r.category} | ${r.run} | ${r.passed ? "是" : "否"} | ${r.toolCalls.length} | ${r.failedToolResults} | ${r.durationMs}ms |`),
    "",
    report.mode === "mock"
      ? "> mock 模式只验证 benchmark 与 Agent 工程链路，不代表真实模型能力；简历只能引用 real 模式结果。"
      : "> real 模式结果仅代表本任务集、模型版本和运行配置，应同时注明任务数与重复次数。",
  ];
  return lines.join("\n") + "\n";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(help()); return; }
  const selected = options.task ? tasks.filter((t) => t.id === options.task) : tasks;
  if (!selected.length) throw new Error(`找不到任务：${options.task}`);
  const realClient = options.mode === "real" ? makeRealClient() : null;
  const results = [];
  for (let run = 1; run <= options.runs; run++) {
    for (const task of selected) {
      process.stdout.write(`[${results.length + 1}/${selected.length * options.runs}] ${task.id} ... `);
      const result = await runOne(task, run, options.mode, realClient);
      results.push(result);
      console.log(result.passed ? "PASS" : "FAIL");
    }
  }
  const report = {
    createdAt: new Date().toISOString(),
    mode: options.mode,
    model: options.mode === "mock" ? "mock-model" : (process.env.DEEPSEEK_MODEL || "deepseek-chat"),
    summary: summarize(results),
    results,
  };
  const resultsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "results");
  await fs.mkdir(resultsDir, { recursive: true });
  const stamp = report.createdAt.replace(/[:.]/g, "-");
  const jsonPath = path.resolve(options.output || path.join(resultsDir, `${options.mode}-${stamp}.json`));
  const mdPath = jsonPath.replace(/\.json$/i, ".md");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(mdPath, markdown(report), "utf8");
  console.log("\n" + markdown(report));
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${mdPath}`);
  if (report.summary.passed !== report.summary.runs) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`benchmark 失败：${error.stack || error.message}`);
  process.exitCode = 1;
});
