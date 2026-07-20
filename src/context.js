// context.js —— 上下文管理：粗略 token 估算 + 历史压缩（摘要）。
//
// 为什么需要压缩：对话越长，每次请求要把全部历史发给模型，又慢又贵，最终会超出
// 模型的上下文窗口。压缩的做法是：把"较早的对话"用模型总结成一段摘要，替换掉原文，
// 只保留最近几轮的完整内容。这样既留住了关键信息，又把体积降下来。

// 粗略估算一组消息的 token 数（拿不到真实 usage 时的兜底；中英文混合约 2 字符/token）。
export function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    if (m.tool_calls) for (const t of m.tool_calls) chars += (t.function?.arguments || "").length;
  }
  return Math.ceil(chars / 2);
}

// 把一段历史渲染成可读文本，交给模型做摘要。
function renderHistory(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string") {
      out.push(`【用户】${m.content}`);
    } else if (m.role === "assistant") {
      if (m.content) out.push(`【助手】${m.content}`);
      if (m.tool_calls) {
        for (const t of m.tool_calls) out.push(`【助手·调用工具】${t.function.name}(${t.function.arguments})`);
      }
    } else if (m.role === "tool") {
      const c = typeof m.content === "string" ? m.content : "";
      out.push(`【工具结果】${c.slice(0, 500)}`);
    }
  }
  return out.join("\n");
}

/**
 * 压缩历史：把较早的消息总结成摘要，前缀进保留段的第一条用户消息里。
 * 这样不新增消息、不破坏 user/assistant/tool 的配对与顺序。
 *
 * @returns 新的 messages 数组；若不满足压缩条件返回 null
 */
export async function compact(client, model, messages, { keepTurns = 2 } = {}) {
  // 找出所有"真实用户轮"的下标（role=user 且 content 是字符串；工具结果是 role=tool，不算）
  const userIdx = [];
  messages.forEach((m, i) => {
    if (m.role === "user" && typeof m.content === "string") userIdx.push(i);
  });
  let older, kept, prefix = [], summaryTitle = "前情摘要（之前对话的压缩）";
  if (userIdx.length > keepTurns) {
    const splitAt = userIdx[userIdx.length - keepTurns]; // 从这里开始保留
    older = messages.slice(0, splitAt);
    kept = messages.slice(splitAt);
  } else {
    // 单个用户回合也可能产生大量工具循环。只压缩较早且完整的 assistant/tool 组，
    // 保留当前用户目标和最近 3 组工具交互，避免切断 tool_call/tool_result 配对。
    const lastUser = userIdx.at(-1);
    if (lastUser === undefined) return null;
    const groups = [];
    for (let i = lastUser + 1; i < messages.length; i++) {
      if (messages[i].role === "assistant" && messages[i].tool_calls?.length) groups.push(i);
    }
    if (groups.length <= 3) return null;
    const keepFrom = groups[groups.length - 3];
    prefix = messages.slice(0, lastUser + 1);
    older = messages.slice(lastUser + 1, keepFrom);
    kept = messages.slice(keepFrom);
    summaryTitle = "当前回合较早执行过程摘要";
  }
  if (!older.length) return null;

  // 让模型把旧对话总结成摘要
  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: "你是对话摘要器，只输出摘要本身，不要寒暄。" },
      {
        role: "user",
        content:
          "把下面的执行历史压缩成结构化中文摘要。严格使用这些小节：原始目标、不可变约束、" +
          "已确认事实、已做决定及原因、已修改文件、验证结果、失败方案（避免重复）、当前进度、未解决问题。" +
          "只记录有工具证据支持的事实，不要把失败调用的猜测写成事实。\n\n===== 对话历史 =====\n" +
          renderHistory(older),
      },
    ],
  });
  const summary = res.choices?.[0]?.message?.content?.trim() || "(摘要为空)";

  if (prefix.length) {
    return [...prefix, { role: "assistant", content: `【${summaryTitle}】\n${summary}` }, ...kept];
  }

  // 跨用户轮压缩时，把摘要前缀进保留段第一条用户消息。
  const first = kept[0];
  return [{
    role: "user",
    content: `【${summaryTitle}】\n${summary}\n\n【当前请求】\n${first.content}`,
  }, ...kept.slice(1)];
}
