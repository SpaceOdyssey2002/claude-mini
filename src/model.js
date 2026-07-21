// model.js —— 统一模型提供商配置。
//
// minicode 的所有模型调用都使用 OpenAI Chat Completions 形状，因此 DeepSeek 和
// Ollama 可以共享同一套 agent loop。差异只集中在 endpoint、模型名、鉴权和 Ollama
// 的本地推理参数。

import OpenAI from "openai";

const PROVIDER_ALIASES = new Map([
  ["deepseek", "deepseek"],
  ["remote", "deepseek"],
  ["ollama", "ollama"],
  ["local", "ollama"],
  ["qwen", "ollama"],
]);

function providerFromArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--local") return "ollama";
    if (argv[i] === "--remote") return "deepseek";
    if (argv[i] === "--provider") return argv[i + 1];
    if (argv[i].startsWith("--provider=")) return argv[i].slice("--provider=".length);
  }
  return "";
}

function normalizedProvider(value) {
  const provider = PROVIDER_ALIASES.get(String(value || "").trim().toLowerCase());
  if (!provider) {
    throw new Error(`未知模型提供商 '${value}'，可选 deepseek/ollama（也可写 remote/local）`);
  }
  return provider;
}

function positiveInt(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} 必须是正整数`);
  return parsed;
}

function envBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (/^(?:1|true|yes|on)$/i.test(value)) return true;
  if (/^(?:0|false|no|off)$/i.test(value)) return false;
  throw new Error("OLLAMA_THINK 必须是 true/false");
}

function ollamaBaseUrl(value) {
  const url = new URL(String(value || "http://127.0.0.1:11434"));
  url.pathname = url.pathname.replace(/\/v1\/?$/, "/");
  return url.toString().replace(/\/$/, "");
}

/** 纯配置解析，便于 CLI、daemon、benchmark 和测试共享。 */
export function resolveModelConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  const selected = providerFromArgs(argv) || env.MINICODE_PROVIDER || "deepseek";
  const provider = normalizedProvider(selected);

  if (provider === "ollama") {
    const numCtx = positiveInt(env.OLLAMA_NUM_CTX, 16_384, "OLLAMA_NUM_CTX");
    return {
      provider,
      providerLabel: "本地 Ollama",
      model: env.OLLAMA_MODEL || "qwen3:8b",
      baseURL: ollamaBaseUrl(env.OLLAMA_BASE_URL),
      contextWindow: numCtx,
      compactAt: Math.max(1_000, Math.floor(numCtx * 0.75)),
      requestDefaults: {
        think: envBoolean(env.OLLAMA_THINK, false),
        options: { num_ctx: numCtx },
        keep_alive: env.OLLAMA_KEEP_ALIVE || "10m",
      },
    };
  }

  if (!env.DEEPSEEK_API_KEY) {
    throw new Error(
      "DeepSeek 模式缺少 DEEPSEEK_API_KEY。使用本地 Qwen：npm run start:local；" +
      "使用远程 DeepSeek：先设置 DEEPSEEK_API_KEY"
    );
  }
  return {
    provider,
    providerLabel: "远程 DeepSeek",
    model: env.DEEPSEEK_MODEL || "deepseek-chat",
    baseURL: env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    apiKey: env.DEEPSEEK_API_KEY,
    compactAt: 40_000,
    requestDefaults: {},
  };
}

function parseToolArguments(value) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || "{}"); }
  catch { return {}; }
}

function toOllamaMessage(message) {
  const converted = { role: message.role, content: message.content ?? "" };
  if (message.tool_calls?.length) {
    converted.tool_calls = message.tool_calls.map((call, index) => ({
      ...(call.id ? { id: call.id } : {}),
      type: "function",
      function: {
        index,
        name: call.function.name,
        arguments: parseToolArguments(call.function.arguments),
      },
    }));
  }
  if (message.tool_call_id) converted.tool_call_id = message.tool_call_id;
  return converted;
}

function toOpenAIToolCalls(calls = []) {
  return calls.map((call, index) => ({
    id: call.id || `ollama-call-${index}`,
    index: call.function?.index ?? index,
    type: "function",
    function: {
      name: call.function?.name || "",
      arguments: JSON.stringify(call.function?.arguments || {}),
    },
  }));
}

function toUsage(result) {
  if (result.prompt_eval_count === undefined && result.eval_count === undefined) return undefined;
  const prompt = result.prompt_eval_count || 0;
  const completion = result.eval_count || 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function ollamaError(status, body) {
  const message = body?.error || `Ollama 请求失败：HTTP ${status}`;
  return Object.assign(new Error(message), { status });
}

/**
 * 用 Ollama 原生 /api/chat 实现项目需要的 OpenAI Chat Completions 子集。
 * 这样 Tool Calling 上层代码不用分叉，同时 num_ctx/think/keep_alive 能真正生效。
 */
export function createOllamaClient(config, { fetchImpl = fetch } = {}) {
  const endpoint = new URL("/api/chat", config.baseURL);

  async function request(body, requestOptions = {}) {
    const defaults = config.requestDefaults || {};
    const options = { ...(defaults.options || {}) };
    if (body.temperature !== undefined) options.temperature = body.temperature;
    if (body.max_tokens !== undefined) options.num_predict = body.max_tokens;
    const payload = {
      model: body.model,
      messages: (body.messages || []).map(toOllamaMessage),
      stream: !!body.stream,
      think: body.think ?? defaults.think ?? false,
      options,
      keep_alive: body.keep_alive ?? defaults.keep_alive,
      ...(body.tools?.length ? { tools: body.tools } : {}),
      ...(body.response_format?.type === "json_object" ? { format: "json" } : {}),
    };
    const signals = [AbortSignal.timeout(120_000)];
    if (requestOptions.signal) signals.push(requestOptions.signal);
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.any(signals),
    });

    if (!body.stream) {
      const result = await response.json();
      if (!response.ok || result.error) throw ollamaError(response.status, result);
      const toolCalls = toOpenAIToolCalls(result.message?.tool_calls);
      return {
        choices: [{
          finish_reason: toolCalls.length ? "tool_calls" : result.done_reason || "stop",
          message: {
            role: "assistant",
            content: result.message?.content || "",
            ...(result.message?.thinking ? { reasoning: result.message.thinking } : {}),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
        }],
        usage: toUsage(result),
      };
    }

    if (!response.ok) {
      let result;
      try { result = await response.json(); } catch { result = {}; }
      throw ollamaError(response.status, result);
    }
    if (!response.body) throw new Error("Ollama 流式响应没有 body");

    return {
      async *[Symbol.asyncIterator]() {
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const bytes of response.body) {
          buffer += decoder.decode(bytes, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const result = JSON.parse(line);
            if (result.error) throw ollamaError(response.status, result);
            const toolCalls = toOpenAIToolCalls(result.message?.tool_calls);
            const delta = {
              ...(result.message?.content ? { content: result.message.content } : {}),
              ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            };
            const usage = toUsage(result);
            yield {
              choices: Object.keys(delta).length ? [{ delta, finish_reason: result.done_reason || null }] : [],
              ...(usage ? { usage } : {}),
            };
          }
        }
        const tail = buffer.trim();
        if (tail) {
          const result = JSON.parse(tail);
          if (result.error) throw ollamaError(response.status, result);
          const usage = toUsage(result);
          yield { choices: [], ...(usage ? { usage } : {}) };
        }
      },
    };
  }

  return { chat: { completions: { create: request } } };
}

/**
 * 创建只暴露项目实际使用的 chat.completions.create 客户端，并统一注入提供商默认参数。
 * 调用方仍可在单次请求中覆盖默认值。
 */
export function createModelRuntime(options = {}) {
  const config = resolveModelConfig(options);
  const fetchImpl = options.fetchImpl || fetch;
  const client = config.provider === "ollama"
    ? createOllamaClient(config, { fetchImpl })
    : new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      maxRetries: 3,
      timeout: 120_000,
    });

  return {
    ...config,
    client,
    async check() {
      if (config.provider !== "ollama") return { ok: true };
      const tagsUrl = new URL("/api/tags", config.baseURL);
      let response;
      try {
        response = await fetchImpl(tagsUrl, { signal: AbortSignal.timeout(5_000) });
      } catch (error) {
        throw new Error(`无法连接本地 Ollama（${tagsUrl.origin}）：${error.message}。请先启动 Ollama`);
      }
      if (!response.ok) throw new Error(`Ollama 健康检查失败：HTTP ${response.status}`);
      const data = await response.json();
      const models = (data.models || []).map((item) => item.name || item.model);
      if (!models.includes(config.model)) {
        throw new Error(`本地未安装模型 ${config.model}。请运行：ollama pull ${config.model}`);
      }
      return { ok: true, models };
    },
  };
}
