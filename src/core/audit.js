import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AUDIT_DIR = path.join(PROJECT_ROOT, ".sessions");

const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|credential)/i;
const LARGE_TEXT_KEY = /^(?:content|code|old_str|new_str)$/i;

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function redactString(value) {
  return value
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/((?:token|password|passwd|secret|api[_-]?key)\s*[=:]\s*)[^\s,"']+/gi, "$1[redacted]");
}

function redact(value, key = "", depth = 0) {
  if (depth > 8) return "[depth-limit]";
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    if (LARGE_TEXT_KEY.test(key)) {
      return `[omitted ${value.length} chars sha256:${hash(value).slice(0, 16)}]`;
    }
    const safe = redactString(value);
    return safe.length > 500 ? safe.slice(0, 500) + `…[${safe.length - 500} chars omitted]` : safe;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, key, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k, depth + 1)]));
  }
  return value;
}

/** 审计日志只保留脱敏参数；真正的参数仍传给工具执行。 */
export function auditArgs(args) {
  return redact(args ?? {});
}

/** 参数摘要哈希用于关联相同调用，不把原始敏感值写入日志。 */
export function auditArgsHash(args) {
  return hash(JSON.stringify(args ?? {}));
}

export function auditPreview(value, max = 600) {
  const text = redactString(typeof value === "string" ? value : JSON.stringify(value));
  return text.length > max ? text.slice(0, max) + `…[${text.length - max} chars omitted]` : text;
}

/** 单进程入口没有 EventBus，使用独立 JSONL 文件保存同样的调用审计。 */
export function appendAuditEvent(sessionId, event) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const record = { ts: new Date().toISOString(), sessionId, ...event };
    fs.appendFileSync(path.join(AUDIT_DIR, `${sessionId}.audit.jsonl`), JSON.stringify(record) + "\n", "utf8");
  } catch {
    // 审计写盘失败不能伪装成业务工具失败；生产环境应在这里接入告警/强制失败策略。
  }
}
