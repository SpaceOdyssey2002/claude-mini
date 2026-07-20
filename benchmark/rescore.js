#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { tasks } from "./tasks.js";

const input = process.argv[2];
if (!input) {
  console.error("用法：node benchmark/rescore.js <report.json>");
  process.exit(1);
}

const report = JSON.parse(await fs.readFile(path.resolve(input), "utf8"));
const definitions = new Map(tasks.map((task) => [task.id, task]));
const metaTools = ["update_plan", "take_note", "use_skill", "spawn_agent", "spawn_agents"];

for (const result of report.results) {
  const task = definitions.get(result.taskId);
  if (!task) throw new Error(`报告包含未知任务：${result.taskId}`);
  const allowed = new Set([...task.allowedTools, ...metaTools]);
  for (const call of result.toolCalls) call.selectionValid = allowed.has(call.name);
}

const calls = report.results.flatMap((r) => r.toolCalls);
const toolResults = report.results.reduce((n, r) => n + r.toolResults, 0);
const successful = report.results.reduce((n, r) => n + r.successfulToolResults, 0);
const expectedFailures = report.results.filter((r) => r.recoveryExpected && r.observedFailure).length;
const unexpectedFailures = Math.max(0, toolResults - successful - expectedFailures);
const pct = (n, d) => d ? Number((100 * n / d).toFixed(2)) : null;

delete report.summary.toolSelectionAccuracy;
report.summary.toolPolicyComplianceRate = pct(calls.filter((c) => c.selectionValid).length, calls.length);
report.summary.unexpectedToolFailureRate = pct(unexpectedFailures, toolResults);
report.rescoredAt = new Date().toISOString();
report.scoringVersion = 2;

const output = path.resolve(input.replace(/\.json$/i, ".reviewed.json"));
const markdownPath = output.replace(/\.json$/i, ".md");
await fs.writeFile(output, JSON.stringify(report, null, 2), "utf8");

const s = report.summary;
const markdown = `# minicode Benchmark（复核版）

- 模式：${report.mode}
- 模型：${report.model}
- 任务运行数：${s.runs}
- 任务完成率：${s.taskCompletionRate}%
- 参数 JSON 合法率：${s.parameterJsonValidRate}%
- 参数 Schema 合法率：${s.parameterSchemaValidRate}%
- 工具策略合规率：${s.toolPolicyComplianceRate}%
- 工具执行成功率：${s.toolExecutionSuccessRate}%
- 非预期工具失败率：${s.unexpectedToolFailureRate}%
- 错误恢复成功率：${s.recoverySuccessRate}%
- 平均工具调用数：${s.averageToolCallsPerRun}

> 工具策略合规率按当前任务允许集合重新计算；预设恢复场景中的首次失败不计入“非预期失败”。
`;
await fs.writeFile(markdownPath, markdown, "utf8");
console.log(`复核报告：${output}`);
console.log(`Markdown：${markdownPath}`);
