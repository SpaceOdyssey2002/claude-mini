// core/registry.js —— 工具注册表：在工具「执行前」加一道安全闸。
//
// 真实工具调用不该裸跑。统一经 ToolRegistry.run：
//   1. 按工具的 JSON Schema 校验参数（缺必填/类型不符 → 直接报错，不浪费一次执行）
//   2. 执行；失败时分类（瞬时/永久/中断），瞬时错误退避重试，永久错误直接抛
// 抛出的错误最终会被 agent loop 捕获、格式化后回喂模型，让它自纠。

// ── 失败分类 ─────────────────────────────────────────────────────────
export function classifyError(err) {
  const m = (err?.message || "").toLowerCase();
  const status = err?.status;
  if (err?.name === "AbortError" || err?.name === "APIUserAbortError") return { kind: "aborted", retryable: false };
  if (status === 429 || status >= 500 || /timeout|econn|network|socket|fetch failed|503|overload/.test(m))
    return { kind: "transient", retryable: true };
  if (/越界|not found|找不到|enoent|无权|permission|拒绝|invalid|校验失败/.test(m))
    return { kind: "permanent", retryable: false };
  return { kind: "unknown", retryable: false };
}

// ── 极简 JSON Schema 参数校验 ────────────────────────────────────────
function typeOk(v, t) {
  switch (t) {
    case "string": return typeof v === "string";
    case "number": return typeof v === "number";
    case "integer": return Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "array": return Array.isArray(v);
    case "object": return v && typeof v === "object" && !Array.isArray(v);
    default: return true;
  }
}
export function validateArgs(schema, args) {
  const errs = [];
  if (!schema || schema.type !== "object") return errs;
  const props = schema.properties || {};
  args = args || {};
  for (const req of schema.required || []) {
    if (args[req] === undefined) errs.push(`缺少必填参数 '${req}'`);
  }
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) continue; // 允许额外字段
    if (p.type && !typeOk(v, p.type)) errs.push(`参数 '${k}' 类型应为 ${p.type}`);
    if (p.enum && !p.enum.includes(v)) errs.push(`参数 '${k}' 应为 ${p.enum.join("/")} 之一`);
  }
  return errs;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ToolRegistry {
  /**
   * @param {Object} opts
   *   @param {Function} opts.dispatch   底层执行器 (name,args)=>Promise<string>
   *   @param {Array}    opts.tools      工具列表（取其 schema 用于校验）
   *   @param {number}   [opts.maxRetries=2]
   *   @param {Function} [opts.onEvent]  (ev)=>void  重试等事件回调
   */
  constructor({ dispatch, tools = [], maxRetries = 2, onEvent }) {
    this.dispatch = dispatch;
    this.maxRetries = maxRetries;
    this.onEvent = onEvent || (() => {});
    this.schemas = new Map();
    for (const t of tools || []) this.schemas.set(t.function.name, t.function.parameters);
  }

  setTools(tools) { for (const t of tools) this.schemas.set(t.function.name, t.function.parameters); }

  async run(name, args) {
    // 1. 参数校验
    const errs = validateArgs(this.schemas.get(name), args);
    if (errs.length) throw new Error(`参数校验失败：${errs.join("；")}`);

    // 2. 执行 + 瞬时错误重试
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.dispatch(name, args);
      } catch (err) {
        lastErr = err;
        const cls = classifyError(err);
        err.classification = cls.kind;
        if (cls.retryable && attempt < this.maxRetries) {
          this.onEvent({ type: "retry", name, attempt: attempt + 1, reason: cls.kind, message: err.message });
          await sleep(300 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }
}
