import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const sha256 = (content) => createHash("sha256").update(content).digest("hex");

function checkpointError(code, message) {
  return Object.assign(new Error(message), {
    code,
    classification: "permanent",
    retryable: false,
  });
}

function sameVersion(actual, expected) {
  return actual.exists === expected.exists
    && (!actual.exists || actual.sha256 === expected.sha256);
}

/**
 * 内存文件检查点。
 *
 * 只为明确声明 checkpointPaths 的工作区文件工具保存 pre-image。它不会尝试
 * 回滚命令、数据库、网络或 MCP 副作用。恢复前必须确认文件仍等于 Agent 最后
 * 写入的版本，避免覆盖用户或其他进程在检查点之后的修改。
 */
export class FileCheckpointManager {
  /**
   * @param {{
   *   root?: string,
   *   maxFiles?: number,
   *   maxBytes?: number,
   *   onEvent?: (event: Object) => void
   * }} options
   */
  constructor({ root = process.cwd(), maxFiles = 100, maxBytes = 20 * 1024 * 1024, onEvent } = {}) {
    this.root = path.resolve(root);
    this.maxFiles = maxFiles;
    this.maxBytes = maxBytes;
    this.onEvent = onEvent || (() => {});
    this.sequence = 0;
    this.active = null;
  }

  hasActive() {
    return !!this.active;
  }

  async resolveInside(input) {
    const abs = path.resolve(this.root, input ?? ".");
    const lexical = path.relative(this.root, abs);
    if (lexical.startsWith("..") || path.isAbsolute(lexical)) {
      throw checkpointError("CHECKPOINT_PATH_OUTSIDE_WORKSPACE", `检查点路径越界：${input}`);
    }

    const rootReal = await fs.realpath(this.root);
    let probe = abs;
    let real;
    while (true) {
      try {
        real = await fs.realpath(probe);
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const parent = path.dirname(probe);
        if (parent === probe) throw error;
        probe = parent;
      }
    }
    const physical = path.relative(rootReal, real);
    if (physical.startsWith("..") || path.isAbsolute(physical)) {
      throw checkpointError(
        "CHECKPOINT_PATH_OUTSIDE_WORKSPACE",
        `检查点路径通过符号链接指向工作区外：${input}`
      );
    }
    return abs;
  }

  async readVersion(abs, { keepContent = false } = {}) {
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) {
        throw checkpointError("CHECKPOINT_NOT_A_FILE", `检查点只支持普通文件：${abs}`);
      }
      const content = await fs.readFile(abs);
      return {
        exists: true,
        sha256: sha256(content),
        size: content.length,
        ...(keepContent ? { content } : {}),
      };
    } catch (error) {
      if (error.code === "ENOENT") return { exists: false, sha256: null, size: 0 };
      throw error;
    }
  }

  begin() {
    if (this.active) return this.active;
    this.active = {
      id: `checkpoint-${++this.sequence}`,
      createdAt: new Date().toISOString(),
      totalBytes: 0,
      records: new Map(),
    };
    this.onEvent({ type: "checkpoint_started", checkpointId: this.active.id });
    return this.active;
  }

  async capture(paths) {
    const unique = [...new Set((paths || []).filter((p) => typeof p === "string" && p.length))];
    if (!unique.length) return null;
    const wasActive = !!this.active;
    const checkpoint = this.begin();
    try {
      for (const input of unique) {
        const abs = await this.resolveInside(input);
        if (checkpoint.records.has(abs)) continue;
        if (checkpoint.records.size >= this.maxFiles) {
          throw checkpointError("CHECKPOINT_FILE_LIMIT", `单个检查点最多保存 ${this.maxFiles} 个文件`);
        }
        const before = await this.readVersion(abs, { keepContent: true });
        if (checkpoint.totalBytes + before.size > this.maxBytes) {
          throw checkpointError("CHECKPOINT_SIZE_LIMIT", `单个检查点原始内容不能超过 ${this.maxBytes} 字节`);
        }
        checkpoint.totalBytes += before.size;
        checkpoint.records.set(abs, {
          path: path.relative(this.root, abs).replaceAll("\\", "/"),
          abs,
          before,
          after: before.exists
            ? { exists: true, sha256: before.sha256, size: before.size }
            : { exists: false, sha256: null, size: 0 },
        });
      }
    } catch (error) {
      if (!wasActive && checkpoint.records.size === 0) this.active = null;
      throw error;
    }
    return checkpoint.id;
  }

  async recordPost(paths) {
    if (!this.active) return;
    for (const input of paths || []) {
      const abs = await this.resolveInside(input);
      const record = this.active.records.get(abs);
      if (record) record.after = await this.readVersion(abs);
    }
  }

  async commit(reason = "validated") {
    if (!this.active) return { attempted: false, reason };
    const checkpoint = this.active;
    this.active = null;
    const paths = [...checkpoint.records.values()].map((record) => record.path);
    const report = {
      attempted: true,
      action: "commit",
      checkpointId: checkpoint.id,
      reason,
      paths,
    };
    this.onEvent({ type: "checkpoint_committed", ...report });
    return report;
  }

  async rollback(reason = "validation_failed") {
    if (!this.active) return { attempted: false, reason };
    const checkpoint = this.active;
    this.active = null;
    const restored = [];
    const removed = [];
    const conflicts = [];
    const records = [...checkpoint.records.values()].reverse();

    for (const record of records) {
      try {
        const current = await this.readVersion(record.abs);
        if (!sameVersion(current, record.after)) {
          conflicts.push({
            path: record.path,
            reason: "文件在 Agent 修改后又发生变化",
            expectedSha256: record.after.sha256,
            actualSha256: current.sha256,
          });
          continue;
        }
        if (record.before.exists) {
          await fs.mkdir(path.dirname(record.abs), { recursive: true });
          await fs.writeFile(record.abs, record.before.content);
          restored.push(record.path);
        } else if (current.exists) {
          await fs.unlink(record.abs);
          removed.push(record.path);
        }
      } catch (error) {
        conflicts.push({ path: record.path, reason: error.message });
      }
    }

    const report = {
      attempted: true,
      action: "rollback",
      checkpointId: checkpoint.id,
      reason,
      restored,
      removed,
      conflicts,
    };
    this.onEvent({
      type: conflicts.length ? "rollback_conflict" : "rollback",
      ...report,
    });
    return report;
  }
}
