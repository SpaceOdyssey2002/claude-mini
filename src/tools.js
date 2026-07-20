// tools.js —— 定义 agent 能调用的工具，以及每个工具的真正执行逻辑。
//
// 一个"工具"由两部分组成：
//   1. 给模型看的描述（schema）：告诉 Claude 这个工具叫什么、干什么、要什么参数
//   2. 我们本地的执行函数（handler）：模型决定调用后，由我们的代码真正去执行
//
// 这是 Claude Code 的核心思想：模型只负责"决定做什么"，真正的动作由你的程序执行。

import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const execAsync = promisify(exec);

// ── 工作目录沙箱 ─────────────────────────────────────────────────────
// 所有文件操作都被限制在 WORKSPACE 内，模型给出越界路径（如 ../、绝对路径到别处）
// 会被直接拒绝。这是防止 agent 误改/误读工作目录之外文件的安全护栏。
let WORKSPACE = process.cwd();
export function setWorkspace(dir) { WORKSPACE = path.resolve(dir); }
export function getWorkspace() { return WORKSPACE; }

function resolveInside(p) {
  const abs = path.resolve(WORKSPACE, p ?? ".");
  const rel = path.relative(WORKSPACE, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`路径越界：'${p}' 不在工作目录内（${WORKSPACE}）`);
  }
  return abs;
}

// lexical 路径检查还不足以防符号链接/junction 越界；执行前再校验真实路径。
async function assertRealInside(abs, originalPath, { allowMissing = false, visited = new Set() } = {}) {
  if (visited.has(abs)) throw new Error(`路径中的符号链接形成循环：${originalPath}`);
  visited.add(abs);
  const workspaceReal = await fs.realpath(WORKSPACE);
  if (allowMissing) {
    try {
      const info = await fs.lstat(abs);
      if (info.isSymbolicLink()) {
        const link = await fs.readlink(abs);
        const target = path.resolve(path.dirname(abs), link);
        return assertRealInside(target, originalPath, { allowMissing: true, visited });
      }
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  let probe = abs;
  let real;
  while (true) {
    try {
      real = await fs.realpath(probe);
      break;
    } catch (e) {
      if (!allowMissing || e.code !== "ENOENT") throw e;
      const parent = path.dirname(probe);
      if (parent === probe) throw e;
      probe = parent;
    }
  }
  const rel = path.relative(workspaceReal, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`路径越界：'${originalPath}' 通过符号链接指向工作目录外（${real}）`);
  }
}

// 递归遍历目录收集文件，自动跳过 node_modules / .git 等噪音目录。
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", "dist", "build", ".next"]);
async function walkFiles(dir, out = [], depth = 0) {
  if (depth > 12) return out; // 防止极深目录
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walkFiles(full, out, depth + 1);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// 把 glob 模式（支持 * ** ?）转成正则
function globToRegExp(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
        else { re += ".*"; i++; }
      } else re += "[^/]*";
    } else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

// ── 1. 给模型看的工具描述（OpenAI / DeepSeek 的 function calling 格式）──
// 描述写得越清楚，模型越知道什么时候该用、怎么用。
export const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "分段读取工作目录内的文本文件。大文件应使用 offset/limit 分批读取，避免一次返回过多内容。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, description: "工作目录内的文件路径" },
          offset: { type: "integer", minimum: 1, description: "从第几行开始读取，1-based，默认 1" },
          limit: { type: "integer", minimum: 1, maximum: 2000, description: "最多读取多少行，默认 400" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "把内容写入文件（会覆盖原有内容；若目录不存在会自动创建）。用于创建新文件或修改已有文件。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, description: "工作目录内要写入的文件路径" },
          content: { type: "string", description: "要写入的完整文件内容" },
          create_only: { type: "boolean", description: "为 true 时只允许创建新文件，若文件已存在则失败" },
          expected_sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$", description: "可选的旧文件 SHA-256；不匹配时拒绝覆盖，防止覆盖并发修改" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "在工作目录或其子目录执行一条 shell 命令。非零退出码会作为失败返回；适合编译、测试和只读 git 检查。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", minLength: 1, description: "要执行的命令，例如 'node app.js' 或 'git status'" },
          cwd: { type: "string", minLength: 1, description: "工作目录内的执行目录，默认 '.'" },
          timeout_ms: { type: "integer", minimum: 1000, maximum: 120000, description: "超时时间，默认 60000ms" },
          max_output_chars: { type: "integer", minimum: 1000, maximum: 200000, description: "返回输出的字符上限，默认 20000" },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "列出某个目录下的文件和子目录。想了解项目结构、找文件时用。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "目录路径，默认为当前目录 '.'" },
          depth: { type: "integer", minimum: 1, maximum: 3, description: "递归深度，默认 1（仅当前目录）" },
          max_entries: { type: "integer", minimum: 1, maximum: 1000, description: "最大返回条目数，默认 500" },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "对文件做精确替换：把 old_str 替换成 new_str。比整体覆盖更安全，适合改动已有文件的一小部分。old_str 必须在文件中唯一出现一次。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, description: "工作目录内要修改的文件路径" },
          old_str: { type: "string", minLength: 1, description: "要被替换掉的原文（需在文件中唯一）" },
          new_str: { type: "string", description: "替换成的新内容" },
          expected_sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$", description: "可选的当前文件 SHA-256；不匹配时拒绝修改" },
        },
        required: ["path", "old_str", "new_str"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "在文件内容里按正则搜索，返回匹配的 文件:行号:内容。用于在项目里找代码、定位某个函数或字符串。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "要搜索的正则表达式" },
          path: { type: "string", description: "搜索的根目录，默认当前目录 '.'" },
          include: { type: "string", description: "可选文件 glob，例如 '**/*.js'" },
          max_results: { type: "integer", minimum: 1, maximum: 200, description: "最大匹配数，默认 100" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "按文件名模式查找文件（支持 * ** ?），例如 'src/**/*.js'。用于了解项目里有哪些某类文件。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "glob 模式，例如 **/*.json" },
          path: { type: "string", description: "搜索的根目录，默认当前目录 '.'" },
          max_results: { type: "integer", minimum: 1, maximum: 500, description: "最大返回文件数，默认 200" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
];

// ── 2. 哪些工具有副作用、执行前需要用户确认 ──────────────────────────
// read_file / list_dir 是只读的，可以直接执行；写、改、执行命令会改变系统，先问一下更安全。
const nonEmptyText = (result) => typeof result === "string" && result.length > 0
  ? null : "工具必须返回非空文本";
const prefixText = (prefix) => (result) => typeof result === "string" && result.startsWith(prefix)
  ? null : `工具结果必须以 '${prefix}' 开头`;

export const toolPolicies = new Map([
  ["read_file",  { sideEffect: "none", requiresApproval: false, parallelSafe: true,  idempotent: true,  timeoutMs: 10_000, maxRetries: 2, validateResult: prefixText("[文件 ") }],
  ["list_dir",   { sideEffect: "none", requiresApproval: false, parallelSafe: true,  idempotent: true,  timeoutMs: 10_000, maxRetries: 2 }],
  ["grep",       { sideEffect: "none", requiresApproval: false, parallelSafe: true,  idempotent: true,  timeoutMs: 30_000, maxRetries: 1, validateResult: nonEmptyText }],
  ["glob",       { sideEffect: "none", requiresApproval: false, parallelSafe: true,  idempotent: true,  timeoutMs: 30_000, maxRetries: 1, validateResult: nonEmptyText }],
  ["write_file", { sideEffect: "workspace-write", requiresApproval: true, parallelSafe: false, idempotent: true,  timeoutMs: 15_000, maxRetries: 1, validateResult: prefixText("已写入 ") }],
  ["edit_file",  { sideEffect: "workspace-write", requiresApproval: true, parallelSafe: false, idempotent: false, timeoutMs: 15_000, maxRetries: 0, validateResult: prefixText("已修改 ") }],
  ["run_command",{ sideEffect: "process", requiresApproval: true, parallelSafe: false, idempotent: false, timeoutMs: 125_000, maxRetries: 0, validateResult: nonEmptyText }],
]);

export const needsConfirm = new Set(
  [...toolPolicies].filter(([, p]) => p.requiresApproval).map(([name]) => name)
);

// ── 3. 工具的真正执行逻辑 ────────────────────────────────────────────
// 每个 handler 接收模型给的参数，返回一个字符串结果（会作为 tool_result 喂回给模型）。
export const handlers = {
  async read_file({ path: filePath, offset = 1, limit = 400 }) {
    const abs = resolveInside(filePath);
    await assertRealInside(abs, filePath);
    const content = await fs.readFile(abs, "utf8");
    const lines = content.split(/\r?\n/);
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    const start = Math.max(0, offset - 1);
    const selected = lines.slice(start, start + limit);
    const end = start + selected.length;
    const suffix = end < lines.length
      ? `\n…（已读取第 ${start + 1}-${end} 行，共 ${lines.length} 行；继续读取请设置 offset=${end + 1}）`
      : "";
    return `[文件 ${filePath}｜SHA-256 ${sha256}｜共 ${lines.length} 行]\n` + selected.join("\n") + suffix;
  },

  async write_file({ path: filePath, content, create_only = false, expected_sha256 = undefined }) {
    const abs = resolveInside(filePath);
    await assertRealInside(abs, filePath, { allowMissing: true });
    let previous = null;
    try { previous = await fs.readFile(abs); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (create_only && previous !== null) throw new Error(`文件已存在，create_only 拒绝覆盖：${filePath}`);
    if (expected_sha256) {
      if (previous === null) throw new Error(`文件不存在，无法校验 expected_sha256：${filePath}`);
      const actual = createHash("sha256").update(previous).digest("hex");
      if (actual.toLowerCase() !== expected_sha256.toLowerCase()) {
        throw new Error(`文件已变化，SHA-256 不匹配：期望 ${expected_sha256}，实际 ${actual}`);
      }
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return `已写入 ${abs}（${Buffer.byteLength(content, "utf8")} 字节）`;
  },

  async run_command({ command, cwd = ".", timeout_ms = 60_000, max_output_chars = 20_000 }, context = {}) {
    const commandCwd = resolveInside(cwd);
    await assertRealInside(commandCwd, cwd);
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: commandCwd,
        timeout: timeout_ms,
        maxBuffer: 10 * 1024 * 1024, // 最多收 10MB 输出
        signal: context.signal,
      });
      const output = (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "") || "(命令无输出)";
      return output.length > max_output_chars
        ? output.slice(0, max_output_chars) + `\n…（命令输出已截断，省略 ${output.length - max_output_chars} 字）`
        : output;
    } catch (err) {
      const parts = [`命令执行失败：${err.message}`];
      if (err.stdout) parts.push(`[stdout]\n${err.stdout}`);
      if (err.stderr) parts.push(`[stderr]\n${err.stderr}`);
      const failure = Object.assign(new Error(parts.join("\n").slice(0, max_output_chars)), {
        code: err.code,
        cause: err,
      });
      if (err.name === "AbortError") failure.name = "AbortError";
      throw failure;
    }
  },

  async list_dir({ path: dirPath = ".", depth = 1, max_entries = 500 }) {
    const abs = resolveInside(dirPath);
    await assertRealInside(abs, dirPath);
    const out = [];
    async function visit(dir, prefix, remaining) {
      const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      if (!entries.length && !prefix) out.push("(空目录)");
      for (const e of entries) {
        if (out.length >= max_entries) return;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        out.push(e.isDirectory() ? rel + "/" : rel);
        if (e.isDirectory() && remaining > 1 && !SKIP_DIRS.has(e.name)) {
          await visit(path.join(dir, e.name), rel, remaining - 1);
        }
      }
    }
    await visit(abs, "", depth);
    if (out.length >= max_entries) out.push(`…（条目过多，已截断到 ${max_entries} 条）`);
    return out.join("\n");
  },

  async edit_file({ path: filePath, old_str, new_str, expected_sha256 = undefined }) {
    const abs = resolveInside(filePath);
    await assertRealInside(abs, filePath);
    const content = await fs.readFile(abs, "utf8");
    if (expected_sha256) {
      const actual = createHash("sha256").update(content, "utf8").digest("hex");
      if (actual.toLowerCase() !== expected_sha256.toLowerCase()) {
        throw new Error(`文件已变化，SHA-256 不匹配：期望 ${expected_sha256}，实际 ${actual}`);
      }
    }
    // 统计 old_str 出现次数，要求唯一——避免改错地方（和真 Claude Code 的 Edit 一样）
    const count = content.split(old_str).length - 1;
    if (count === 0) throw new Error("在文件中找不到 old_str");
    if (count > 1) throw new Error(`old_str 出现了 ${count} 次，不唯一，请提供更多上下文`);
    const updated = content.replace(old_str, new_str);
    await fs.writeFile(abs, updated, "utf8");
    return `已修改 ${abs}`;
  },

  async grep({ pattern, path: root = ".", include, max_results = 100 }) {
    const re = new RegExp(pattern);
    const base = resolveInside(root);
    await assertRealInside(base, root);
    const includeRe = include ? globToRegExp(include) : null;
    const files = (await walkFiles(base)).filter((file) => {
      if (!includeRe) return true;
      return includeRe.test(path.relative(base, file).replace(/\\/g, "/"));
    });
    const hits = [];
    for (const file of files) {
      let text;
      try {
        text = await fs.readFile(file, "utf8");
      } catch {
        continue; // 二进制或无权限，跳过
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push(`${path.relative(WORKSPACE, file)}:${i + 1}:${lines[i].trim()}`);
          if (hits.length >= max_results) return hits.join("\n") + `\n…（结果过多，已截断到 ${max_results} 条）`;
        }
      }
    }
    return hits.length ? hits.join("\n") : "(无匹配)";
  },

  async glob({ pattern, path: root = ".", max_results = 200 }) {
    const re = globToRegExp(pattern);
    const base = resolveInside(root);
    await assertRealInside(base, root);
    const files = await walkFiles(base);
    const matched = files
      .map((f) => path.relative(base, f).replace(/\\/g, "/")) // 统一用 / 比较
      .filter((rel) => re.test(rel))
      .slice(0, max_results);
    return matched.length ? matched.join("\n") : "(无匹配文件)";
  },
};
