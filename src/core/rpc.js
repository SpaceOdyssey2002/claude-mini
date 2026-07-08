// core/rpc.js —— JSON-RPC 2.0 协议，按 NDJSON（一行一个 JSON）分帧。
//
// 这是 CLI/TUI 客户端和 minicode-core daemon 之间的「类型化通信协议」。比起裸 socket，
// JSON-RPC 给了我们：请求/响应配对（靠 id）、通知（无 id，单向，用于推事件）、标准错误结构。
// NDJSON 分帧简单可靠：一条消息一行，按 \n 切。

// 一条消息编码成一行
export function frame(obj) {
  return JSON.stringify(obj) + "\n";
}

// 创建一个流式行解析器：喂入 socket 的 data chunk，凑齐整行就回调 onMessage(解析后的对象)
export function createLineParser(onMessage) {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { onMessage(JSON.parse(line)); } catch { /* 半包/坏行，忽略 */ }
    }
  };
}

// 构造各类消息
export const rpc = {
  request(id, method, params) { return { jsonrpc: "2.0", id, method, params }; },
  notify(method, params) { return { jsonrpc: "2.0", method, params }; }, // 无 id = 通知
  result(id, result) { return { jsonrpc: "2.0", id, result }; },
  error(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; },
};

// 标准错误码
export const RPC_ERR = {
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602, INTERNAL: -32603,
};

// 服务端分发：根据 methods 表处理一条请求消息，通过 send 回发响应。
// 通知（无 id）不回响应。
export async function dispatchRpc(msg, methods, send, ctx) {
  if (msg.method === undefined) return; // 不是请求/通知（可能是响应），忽略
  const fn = methods[msg.method];
  const isNotify = msg.id === undefined || msg.id === null;
  if (!fn) {
    if (!isNotify) send(rpc.error(msg.id, RPC_ERR.METHOD_NOT_FOUND, `未知方法：${msg.method}`));
    return;
  }
  try {
    const result = await fn(msg.params || {}, ctx);
    if (!isNotify) send(rpc.result(msg.id, result ?? null));
  } catch (e) {
    if (!isNotify) send(rpc.error(msg.id, RPC_ERR.INTERNAL, e.message));
  }
}
