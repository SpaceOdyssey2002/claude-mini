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
  // 轮数不够，没必要压缩
  if (userIdx.length <= keepTurns) return null;

  const splitAt = userIdx[userIdx.length - keepTurns]; // 从这里开始保留
  const older = messages.slice(0, splitAt);
  const kept = messages.slice(splitAt);
  if (older.length === 0) return null;

  // 让模型把旧对话总结成摘要
  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: "你是对话摘要器，只输出摘要本身，不要寒暄。" },
      {
        role: "user",
        content:
          "把下面的对话历史压缩成简洁的中文要点摘要，必须保留：关键事实、已做的决定、" +
          "改动过的文件及其要点、尚未完成的任务。\n\n===== 对话历史 =====\n" +
          renderHistory(older),
      },
    ],
  });
  const summary = res.choices?.[0]?.message?.content?.trim() || "(摘要为空)";

  // 把摘要前缀进保留段第一条用户消息里
  const first = kept[0];
  const newFirst = {
    role: "user",
    content: `【前情摘要（之前对话的压缩）】\n${summary}\n\n【当前请求】\n${first.content}`,
  };
  return [newFirst, ...kept.slice(1)];
}
