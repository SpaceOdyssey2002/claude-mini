// plan.js —— 结构化计划状态。计划独立于聊天历史保存于运行时，压缩上下文后仍可注入模型。

export class PlanState {
  constructor() {
    this.explanation = "";
    this.steps = [];
    this.version = 0;
  }

  update({ explanation = "", steps }) {
    const ids = new Set();
    let inProgress = 0;
    for (const step of steps) {
      if (ids.has(step.id)) throw new Error(`计划步骤 id 重复：${step.id}`);
      ids.add(step.id);
      if (step.status === "in_progress") inProgress++;
      if ((step.status === "completed" || step.status === "blocked") && !step.evidence?.trim()) {
        throw new Error(`步骤 ${step.id} 标记为 ${step.status} 时必须提供 evidence`);
      }
    }
    if (inProgress > 1) throw new Error("计划中最多只能有一个 in_progress 步骤");
    this.explanation = explanation;
    this.steps = steps.map((step) => ({ ...step }));
    this.version++;
    return this.text();
  }

  clear() {
    this.explanation = "";
    this.steps = [];
    this.version++;
  }

  text() {
    if (!this.steps.length) return "（当前没有结构化计划）";
    const lines = [`计划版本 ${this.version}${this.explanation ? `：${this.explanation}` : ""}`];
    for (const s of this.steps) {
      const acceptance = s.acceptance ? `；验收：${s.acceptance}` : "";
      const evidence = s.evidence ? `；证据：${s.evidence}` : "";
      lines.push(`- [${s.status}] ${s.id} ${s.description}${acceptance}${evidence}`);
    }
    return lines.join("\n");
  }

  prompt() {
    if (!this.steps.length) return "";
    return `\n\n【当前结构化计划——以此为执行状态，不要重复已完成步骤】\n${this.text()}`;
  }
}

export function makePlanTool(state) {
  const tool = {
    type: "function",
    function: {
      name: "update_plan",
      description: "创建或更新复杂任务的结构化执行计划。超过两个步骤的任务先调用；验证完成后及时更新步骤状态和证据。每次传入完整计划。",
      parameters: {
        type: "object",
        properties: {
          explanation: { type: "string", maxLength: 1000, description: "本次创建或调整计划的原因" },
          steps: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1, maxLength: 40, description: "稳定步骤 id，如 step-1" },
                description: { type: "string", minLength: 1, maxLength: 500, description: "可执行的步骤描述" },
                status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] },
                acceptance: { type: "string", maxLength: 500, description: "该步骤的可验证完成条件" },
                evidence: { type: "string", maxLength: 1000, description: "完成或阻塞的工具证据" },
              },
              required: ["id", "description", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["steps"],
        additionalProperties: false,
      },
    },
  };

  const handler = (args) => state.update(args);
  const policy = {
    sideEffect: "runtime-state", requiresApproval: false, parallelSafe: false,
    idempotent: true, timeoutMs: 5_000, maxRetries: 0,
  };
  return { tool, handler, policy };
}
