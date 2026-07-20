import { validateArgs } from "./core/registry.js";

const contracts = {
  json: {
    name: "json",
    description: "任意 JSON 对象",
    schema: { type: "object" },
  },
  task_result: {
    name: "task_result",
    description: "可供自动化流程消费的任务执行结果",
    schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["completed", "partial", "failed"] },
        summary: { type: "string", minLength: 1, maxLength: 2000 },
        changed_files: { type: "array", maxItems: 100, items: { type: "string" } },
        verification: { type: "array", maxItems: 50, items: { type: "string" } },
        remaining: { type: "array", maxItems: 50, items: { type: "string" } },
      },
      required: ["status", "summary", "changed_files", "verification", "remaining"],
      additionalProperties: false,
    },
  },
};

export function listOutputFormats() {
  return [
    { name: "text", description: "普通自然语言输出" },
    ...Object.values(contracts).map(({ name, description }) => ({ name, description })),
  ];
}

export function resolveOutputContract(name = "text") {
  const normalized = String(name || "text").trim().toLowerCase();
  if (normalized === "text") return null;
  const contract = contracts[normalized];
  if (!contract) {
    const names = listOutputFormats().map((item) => item.name).join("、");
    throw Object.assign(new Error(`未知输出格式 '${name}'，可选：${names}`), { code: "INVALID_OUTPUT_FORMAT" });
  }
  return contract;
}

export function parseAndValidateOutput(content, contract) {
  let value;
  try {
    value = JSON.parse(content);
  } catch (error) {
    return { ok: false, errors: [`不是合法 JSON：${error.message}`] };
  }
  const errors = validateArgs(contract.schema, value);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export async function formatFinalOutput(client, model, { goal, draft, contract, signal = undefined, maxRetries = 2 }) {
  const messages = [
    {
      role: "system",
      content:
        "你是最终结果格式化器。只能使用任务目标和执行草稿中已有的事实，不得补造文件、测试或成功状态。" +
        "输出必须是一个合法 JSON 对象，并严格符合给定 JSON Schema；不要输出 Markdown 代码块或额外解释。\n" +
        `JSON Schema:\n${JSON.stringify(contract.schema)}`,
    },
    {
      role: "user",
      content: `任务目标：\n${goal}\n\nAgent 执行草稿：\n${draft || "（无草稿）"}`,
    },
  ];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await client.chat.completions.create({
      model,
      messages,
      response_format: { type: "json_object" },
      stream: false,
    }, { signal });
    inputTokens += response.usage?.prompt_tokens || 0;
    outputTokens += response.usage?.completion_tokens || 0;
    const content = response.choices?.[0]?.message?.content || "";
    const checked = parseAndValidateOutput(content, contract);
    if (checked.ok) {
      return {
        text: JSON.stringify(checked.value, null, 2),
        value: checked.value,
        attempts: attempt + 1,
        usage: { inputTokens, outputTokens },
      };
    }
    if (attempt < maxRetries) {
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content: `上一次结果未通过本地 Schema 校验：${checked.errors.join("；")}。只修正格式，不得改变事实。`,
      });
      continue;
    }
    throw Object.assign(new Error(`结构化输出校验失败：${checked.errors.join("；")}`), {
      code: "INVALID_STRUCTURED_OUTPUT",
    });
  }
}
