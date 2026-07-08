// agent.js —— agentic loop（核心）：流式输出 + 内置/MCP/子agent 工具统一路由
//                + 同一轮只读工具并行执行 + 可被 Ctrl+C 中断。
//
//   调模型(流式) ──> 边收边打印文字 / 累积它要调用的工具
//      └─> 有工具调用？无需确认的并行跑、需确认的串行问；结果喂回去 ──> 再调模型
//          └─> 没有工具调用了 ──> 本回合结束
//
// 这个文件不关心"工具具体怎么执行"——执行交给 deps.dispatch，确认交给 deps.confirmNeeded，
// 界面渲染交给 deps.ui，中断信号由 deps.signal 传入。

export const DEFAULT_SYSTEM = `你是一个运行在用户终端里的编程助手（一个迷你版 Claude Code）。
你可以读写文件、执行命令、搜索代码，能用通过 MCP 接入的外部工具，
还能用 spawn_agent 把独立的只读调查任务派给子助手。
- 动手前先简要说明你打算做什么。
- 需要了解情况时主动用工具去看，而不是猜。
- 多个互相独立的查询可以在一条消息里一起发起（会被并行执行）。
- 完成后用一两句话总结你做了什么。
- 用中文回复。`;

// 工具结果喂回模型前的最大长度：防止一个超大文件/命令输出瞬间撑爆上下文。
const TOOL_RESULT_CAP = Number(process.env.MINICODE_TOOL_CAP) || 8000;
function capForContext(text) {
  if (typeof text !== "string" || text.length <= TOOL_RESULT_CAP) return text;
  return text.slice(0, TOOL_RESULT_CAP) + `\n…（输出过长，已截断，省略 ${text.length - TOOL_RESULT_CAP} 字）`;
}

// 判断一个异常是不是"被中断"
function isAbort(e, signal) {
  return signal?.aborted || e?.name === "AbortError" || e?.name === "APIUserAbortError";
}

// 中断后修复历史：若最后一条 assistant 带 tool_calls 但部分结果没回填，
// 补上占位 tool 消息，保证 user/assistant/tool 配对完整，下一轮请求不会 400。
function repairToolResults(messages) {
  let aIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].tool_calls?.length) { aIdx = i; break; }
    if (messages[i].role === "user") break;
  }
  if (aIdx < 0) return;
  const ids = messages[aIdx].tool_calls.map((t) => t.id);
  const answered = new Set(messages.slice(aIdx + 1).filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  for (const id of ids) {
    if (!answered.has(id)) messages.push({ role: "tool", tool_call_id: id, content: "[已中断]" });
  }
}

export async function runAgentTurn(client, messages, deps) {
  const { model, tools, dispatch, confirmNeeded, ui } = deps;
  const system = deps.system || DEFAULT_SYSTEM;

  // 本回合的 token 用量累计；lastPromptTokens 反映"当前上下文有多大"，用于触发压缩
  let turnInput = 0, turnOutput = 0, lastPromptTokens = 0;

  // 执行单个工具调用，返回一条 tool 消息（不直接 push，便于并行后按原序回填）
  async function execOne(call) {
    let args = {};
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      return { role: "tool", tool_call_id: call.id, content: "参数 JSON 解析失败" };
    }
    ui.onToolUse(call.name, args);
    if (confirmNeeded(call.name)) {
      const ok = await ui.confirm(call.name, args);
      if (!ok) return { role: "tool", tool_call_id: call.id, content: "用户拒绝了这次操作。" };
    }
    try {
      const result = await dispatch(call.name, args);
      ui.onToolResult(call.name, result, { isError: false });
      return { role: "tool", tool_call_id: call.id, content: capForContext(result) };
    } catch (err) {
      const msg = `工具执行出错：${err.message}`;
      ui.onToolResult(call.name, msg, { isError: true });
      return { role: "tool", tool_call_id: call.id, content: msg };
    }
  }

  try {
    while (true) {
      ui.onWaitStart(); // 开始等模型（界面会转 spinner）

      const stream = await client.chat.completions.create(
        {
          model,
          messages: [{ role: "system", content: system }, ...messages],
          tools: tools.length ? tools : undefined,
          stream: true,
          stream_options: { include_usage: true }, // 最后一个 chunk 带真实 token 用量
        },
        { signal: deps.signal } // 传入中断信号，Ctrl+C 时能打断
      );

      let content = "";
      const toolCalls = []; // 按 index 累积：{ id, name, arguments(字符串) }
      let started = false;

      for await (const chunk of stream) {
        if (chunk.usage) {
          lastPromptTokens = chunk.usage.prompt_tokens || 0;
          turnInput += chunk.usage.prompt_tokens || 0;
          turnOutput += chunk.usage.completion_tokens || 0;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};

        if (!started && (delta.content || delta.tool_calls)) { started = true; ui.onWaitEnd(); }
        if (delta.content) { content += delta.content; ui.onToken(delta.content); }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index;
            if (!toolCalls[i]) toolCalls[i] = { id: "", name: "", arguments: "" };
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function?.name) toolCalls[i].name = tc.function.name;
            if (tc.function?.arguments) toolCalls[i].arguments += tc.function.arguments;
          }
        }
      }

      // 流被中断：OpenAI SDK 在 abort 时是"静默结束迭代"而非抛异常，
      // 所以这里显式检查信号。保留已生成的文字，丢弃不完整的工具调用。
      if (deps.signal?.aborted) {
        ui.onWaitEnd();
        if (content) ui.onTextEnd();
        if (content) messages.push({ role: "assistant", content });
        repairToolResults(messages);
        return { aborted: true, lastPromptTokens, turnInput, turnOutput };
      }

      if (!started) ui.onWaitEnd();
      if (content) ui.onTextEnd();

      // 模型这条回复进历史
      const assistantMsg = { role: "assistant", content: content || null };
      if (toolCalls.length) {
        assistantMsg.tool_calls = toolCalls.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: t.arguments || "{}" },
        }));
      }
      messages.push(assistantMsg);

      // 没有工具调用 —— 本回合结束
      if (!toolCalls.length) return { lastPromptTokens, turnInput, turnOutput };

      // 执行工具：无需确认的（只读/已批准）并行跑，需确认的串行处理；结果按原序回填
      const results = new Array(toolCalls.length);
      const parallel = [];
      for (let i = 0; i < toolCalls.length; i++) {
        if (!confirmNeeded(toolCalls[i].name)) parallel.push(i);
      }
      await Promise.all(parallel.map((i) => execOne(toolCalls[i]).then((r) => { results[i] = r; })));
      for (let i = 0; i < toolCalls.length; i++) {
        if (!results[i]) results[i] = await execOne(toolCalls[i]);
      }
      for (const r of results) messages.push(r);
      // 继续 while，再问模型
    }
  } catch (e) {
    if (isAbort(e, deps.signal)) {
      ui.onWaitEnd();
      ui.onTextEnd();
      repairToolResults(messages); // 保证历史结构合法
      return { aborted: true, lastPromptTokens, turnInput, turnOutput };
    }
    throw e;
  }
}
