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
  if (status === 429 || status >= 500 || /timeout|timed out|etimedout|econn|network|socket|fetch failed|503|overload|requesttimeout/.test(m))
    return { kind: "transient", retryable: true };
  if (/越界|outside allowed|not found|找不到|不存在|enoent|无权|permission|拒绝|invalid|校验失败|不匹配|not unique/.test(m))
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

  function visit(s, value, label) {
    if (!s) return;
    if (s.type && !typeOk(value, s.type)) {
      errs.push(`${label}类型应为 ${s.type}`);
      return;
    }
    if (s.enum && !s.enum.includes(value)) errs.push(`${label}应为 ${s.enum.join("/")} 之一`);
    if (typeof value === "string") {
      if (s.minLength !== undefined && value.length < s.minLength) errs.push(`${label}长度不能小于 ${s.minLength}`);
      if (s.maxLength !== undefined && value.length > s.maxLength) errs.push(`${label}长度不能大于 ${s.maxLength}`);
      if (s.pattern) {
        try { if (!new RegExp(s.pattern).test(value)) errs.push(`${label}格式不匹配 ${s.pattern}`); }
        catch { errs.push(`${label}的 schema pattern 无效`); }
      }
    }
    if (typeof value === "number") {
      if (s.minimum !== undefined && value < s.minimum) errs.push(`${label}不能小于 ${s.minimum}`);
      if (s.maximum !== undefined && value > s.maximum) errs.push(`${label}不能大于 ${s.maximum}`);
    }
    if (Array.isArray(value)) {
      if (s.minItems !== undefined && value.length < s.minItems) errs.push(`${label}至少需要 ${s.minItems} 项`);
      if (s.maxItems !== undefined && value.length > s.maxItems) errs.push(`${label}最多允许 ${s.maxItems} 项`);
      if (s.items) value.forEach((item, i) => visit(s.items, item, `${label}[${i}] `));
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const props = s.properties || {};
      for (const req of s.required || []) {
        if (value[req] === undefined) errs.push(`${label}缺少必填参数 '${req}'`);
      }
      for (const [k, v] of Object.entries(value)) {
        if (!props[k]) {
          if (s.additionalProperties === false) errs.push(`${label}不允许额外参数 '${k}'`);
          continue;
        }
        visit(props[k], v, `${label}参数 '${k}' `);
      }
    }
  }

  if (!schema) return ["找不到工具参数 schema"];
  visit(schema, args ?? {}, "");
  return errs;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(Object.assign(new Error("操作已中断"), { name: "AbortError" }));
  const onAbort = () => {
    clearTimeout(timer);
    reject(Object.assign(new Error("操作已中断"), { name: "AbortError" }));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});

async function withTimeout(run, timeoutMs, parentSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) controller.abort(parentSignal.reason);
  else parentSignal?.addEventListener("abort", onAbort, { once: true });
  let timer;
  let rejectParentAbort;
  const parentAbort = new Promise((_, reject) => { rejectParentAbort = reject; });
  const rejectOnParentAbort = () => {
    onAbort();
    rejectParentAbort(Object.assign(new Error("操作已中断"), { name: "AbortError" }));
  };
  parentSignal?.removeEventListener("abort", onAbort);
  if (parentSignal?.aborted) rejectOnParentAbort();
  else parentSignal?.addEventListener("abort", rejectOnParentAbort, { once: true });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = Object.assign(new Error(`工具执行超时（${timeoutMs}ms）`), { code: "TOOL_TIMEOUT" });
      reject(err);
      controller.abort(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout, parentAbort]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", rejectOnParentAbort);
  }
}

export class ToolRegistry {
  /**
   * @param {Object} opts
   *   @param {Function} opts.dispatch   底层执行器 (name,args)=>Promise<string>
   *   @param {Array}    opts.tools      工具列表（取其 schema 用于校验）
   *   @param {Map<string, Object>|Object} [opts.policies] 工具策略
   *   @param {number}   [opts.maxRetries=2]
   *   @param {Function} [opts.onEvent]  (ev)=>void  重试等事件回调
   *   @param {Object}   [opts.checkpointManager] 文件检查点管理器
   */
  constructor({ dispatch, tools = [], policies = new Map(), maxRetries = 2, onEvent, checkpointManager }) {
    this.dispatch = dispatch;
    this.maxRetries = maxRetries;
    this.onEvent = onEvent || (() => {});
    this.checkpointManager = checkpointManager;
    if (this.checkpointManager) this.checkpointManager.onEvent = this.onEvent;
    this.policies = policies instanceof Map ? policies : new Map(Object.entries(policies || {}));
    this.schemas = new Map();
    for (const t of tools || []) this.schemas.set(t.function.name, t.function.parameters);
  }

  setTools(tools) { for (const t of tools) this.schemas.set(t.function.name, t.function.parameters); }

  async finishRun({ success = true, reason = success ? "end_turn" : "run_failed" } = {}) {
    if (!this.checkpointManager?.hasActive()) return { attempted: false, reason };
    return success
      ? this.checkpointManager.commit(reason)
      : this.checkpointManager.rollback(reason);
  }

  async run(name, args, context = {}) {
    // 1. 参数校验
    const errs = validateArgs(this.schemas.get(name), args);
    if (errs.length) {
      throw Object.assign(new Error(`参数校验失败：${errs.join("；")}`), {
        code: "INVALID_TOOL_ARGUMENTS", classification: "permanent", retryable: false,
      });
    }

    // 2. 执行 + 瞬时错误重试
    const policy = this.policies.get(name) || {};
    const timeoutMs = policy.timeoutMs || 60_000;
    const retries = policy.idempotent === false ? 0 : (policy.maxRetries ?? this.maxRetries);
    const checkpointPaths = typeof policy.checkpointPaths === "function"
      ? policy.checkpointPaths(args) || []
      : [];
    if (this.checkpointManager && checkpointPaths.length) {
      await this.checkpointManager.capture(checkpointPaths);
    }
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await withTimeout(
          (signal) => this.dispatch(name, args, { ...context, signal }),
          timeoutMs,
          context.signal
        );
        if (result === undefined || result === null) {
          const err = Object.assign(new Error("工具返回了空的 undefined/null 结果"), { code: "INVALID_TOOL_RESULT" });
          throw err;
        }
        if (policy.validateResult) {
          const validationError = policy.validateResult(result, args);
          if (validationError) {
            throw Object.assign(new Error(`工具结果校验失败：${validationError}`), {
              code: "INVALID_TOOL_RESULT", classification: "permanent", retryable: false,
            });
          }
        }
        if (this.checkpointManager && checkpointPaths.length) {
          await this.checkpointManager.recordPost(checkpointPaths);
        }
        if (this.checkpointManager && policy.settlesCheckpoint) {
          await this.checkpointManager.commit(`${name}_succeeded`);
        }
        return typeof result === "string" ? result : JSON.stringify(result);
      } catch (err) {
        lastErr = err;
        if (this.checkpointManager && checkpointPaths.length) {
          await this.checkpointManager.recordPost(checkpointPaths);
        }
        const cls = classifyError(err);
        err.classification = cls.kind;
        err.retryable = cls.retryable && policy.idempotent !== false;
        if (err.retryable && attempt < retries) {
          this.onEvent({ type: "retry", name, attempt: attempt + 1, reason: cls.kind, message: err.message });
          const base = 300 * (2 ** attempt);
          const jitter = Math.floor(Math.random() * 100);
          await sleep(base + jitter, context.signal);
          continue;
        }
        if (this.checkpointManager && (checkpointPaths.length || policy.settlesCheckpoint)) {
          const rollback = await this.checkpointManager.rollback(`${name}_failed`);
          if (rollback.attempted) {
            err.rollback = rollback;
            const changed = rollback.restored.length + rollback.removed.length;
            const summary = rollback.conflicts.length
              ? `文件回滚完成 ${changed} 项，另有 ${rollback.conflicts.length} 个冲突未覆盖`
              : `已从检查点回滚 ${changed} 个文件`;
            err.message = `${err.message}\n${summary}`;
          }
        }
        throw err;
      }
    }
    throw lastErr;
  }
}
