import { test } from "node:test";
import assert from "node:assert/strict";

import { createOllamaClient, resolveModelConfig } from "../src/model.js";

test("模型提供商默认保持 DeepSeek，并要求 API key", () => {
  assert.throws(
    () => resolveModelConfig({ argv: [], env: {} }),
    /DEEPSEEK_API_KEY/
  );
  const config = resolveModelConfig({ argv: [], env: { DEEPSEEK_API_KEY: "test-key" } });
  assert.equal(config.provider, "deepseek");
  assert.equal(config.model, "deepseek-chat");
  assert.equal(config.baseURL, "https://api.deepseek.com");
  assert.deepEqual(config.requestDefaults, {});
});

test("--provider ollama 覆盖环境选择并生成本地 Qwen 配置", () => {
  const config = resolveModelConfig({
    argv: ["--provider", "ollama"],
    env: {
      MINICODE_PROVIDER: "deepseek",
      OLLAMA_BASE_URL: "http://localhost:11434",
      OLLAMA_MODEL: "qwen3:8b",
      OLLAMA_NUM_CTX: "16384",
      OLLAMA_THINK: "false",
    },
  });
  assert.equal(config.provider, "ollama");
  assert.equal(config.model, "qwen3:8b");
  assert.equal(config.baseURL, "http://localhost:11434");
  assert.equal(config.contextWindow, 16384);
  assert.equal(config.compactAt, 12288);
  assert.deepEqual(config.requestDefaults, {
    think: false,
    options: { num_ctx: 16384 },
    keep_alive: "10m",
  });
});

test("Ollama 适配器把 OpenAI 请求转换为原生参数并转换工具调用结果", async () => {
  /** @type {any} */
  let sent;
  const config = resolveModelConfig({ argv: ["--local"], env: {} });
  const client = createOllamaClient(config, {
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return new Response(JSON.stringify({
        message: { role: "assistant", content: "", tool_calls: [{
          id: "call-1", function: { index: 0, name: "add", arguments: { a: 2, b: 5 } },
        }] },
        done: true, prompt_eval_count: 10, eval_count: 4,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const result = await client.chat.completions.create({
    model: "qwen3:8b",
    messages: [{ role: "user", content: "2+5" }],
    tools: [{ type: "function", function: { name: "add", parameters: { type: "object" } } }],
    stream: false,
  });
  assert.ok(sent);
  assert.equal(sent.options.num_ctx, 16384);
  assert.equal(sent.think, false);
  assert.equal(sent.keep_alive, "10m");
  assert.equal(result.choices[0].message.tool_calls[0].function.arguments, '{"a":2,"b":5}');
  assert.equal(result.usage.total_tokens, 14);
});

test("本地/远程别名和 Ollama 参数校验", () => {
  assert.equal(resolveModelConfig({ argv: ["--local"], env: {} }).provider, "ollama");
  assert.equal(resolveModelConfig({ argv: ["--remote"], env: { DEEPSEEK_API_KEY: "x" } }).provider, "deepseek");
  assert.throws(
    () => resolveModelConfig({ argv: ["--local"], env: { OLLAMA_NUM_CTX: "many" } }),
    /OLLAMA_NUM_CTX/
  );
  assert.throws(
    () => resolveModelConfig({ argv: ["--local"], env: { OLLAMA_THINK: "maybe" } }),
    /OLLAMA_THINK/
  );
});
