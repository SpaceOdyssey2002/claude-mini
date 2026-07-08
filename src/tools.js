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
      if (pattern[i + 1] === "*") { re += ".*"; i++; } // ** 跨目录
      else re += "[^/\\\\]*";                          // * 单层
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
      description: "读取一个文件的文本内容。当你需要查看代码、配置或任何文本文件时使用。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "要读取的文件路径（相对或绝对）" },
        },
        required: ["path"],
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
          path: { type: "string", description: "要写入的文件路径" },
          content: { type: "string", description: "要写入的完整文件内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "在终端执行一条 shell 命令并返回输出（stdout + stderr）。用于编译、运行测试、git 操作、安装依赖等。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的命令，例如 'node app.js' 或 'git status'" },
        },
        required: ["command"],
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
        },
        required: [],
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
          path: { type: "string", description: "要修改的文件路径" },
          old_str: { type: "string", description: "要被替换掉的原文（需在文件中唯一）" },
          new_str: { type: "string", description: "替换成的新内容" },
        },
        required: ["path", "old_str", "new_str"],
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
        },
        required: ["pattern"],
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
        },
        required: ["pattern"],
      },
    },
  },
];

// ── 2. 哪些工具有副作用、执行前需要用户确认 ──────────────────────────
// read_file / list_dir 是只读的，可以直接执行；写、改、执行命令会改变系统，先问一下更安全。
export const needsConfirm = new Set(["write_file", "edit_file", "run_command"]);

// ── 3. 工具的真正执行逻辑 ────────────────────────────────────────────
// 每个 handler 接收模型给的参数，返回一个字符串结果（会作为 tool_result 喂回给模型）。
export const handlers = {
  async read_file({ path: filePath }) {
    const abs = resolveInside(filePath);
    const content = await fs.readFile(abs, "utf8");
    return content;
  },

  async write_file({ path: filePath, content }) {
    const abs = resolveInside(filePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return `已写入 ${abs}（${Buffer.byteLength(content, "utf8")} 字节）`;
  },

  async run_command({ command }) {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: WORKSPACE, // 命令在工作目录里执行
        timeout: 60_000, // 最多跑 60 秒，防止卡死
        maxBuffer: 10 * 1024 * 1024, // 最多收 10MB 输出
      });
      return (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "") || "(命令无输出)";
    } catch (err) {
      // 命令返回非 0 退出码也走到这里——把信息原样返回给模型，让它自己判断
      const parts = [`命令执行失败：${err.message}`];
      if (err.stdout) parts.push(`[stdout]\n${err.stdout}`);
      if (err.stderr) parts.push(`[stderr]\n${err.stderr}`);
      return parts.join("\n");
    }
  },

  async list_dir({ path: dirPath = "." }) {
    const abs = resolveInside(dirPath);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    if (entries.length === 0) return "(空目录)";
    // 目录加 / 后缀，方便模型区分文件和文件夹
    return entries
      .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
      .sort()
      .join("\n");
  },

  async edit_file({ path: filePath, old_str, new_str }) {
    const abs = resolveInside(filePath);
    const content = await fs.readFile(abs, "utf8");
    // 统计 old_str 出现次数，要求唯一——避免改错地方（和真 Claude Code 的 Edit 一样）
    const count = content.split(old_str).length - 1;
    if (count === 0) throw new Error("在文件中找不到 old_str");
    if (count > 1) throw new Error(`old_str 出现了 ${count} 次，不唯一，请提供更多上下文`);
    const updated = content.replace(old_str, new_str);
    await fs.writeFile(abs, updated, "utf8");
    return `已修改 ${abs}`;
  },

  async grep({ pattern, path: root = "." }) {
    const re = new RegExp(pattern);
    const files = await walkFiles(resolveInside(root));
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
          if (hits.length >= 100) return hits.join("\n") + "\n…（结果过多，已截断到 100 条）";
        }
      }
    }
    return hits.length ? hits.join("\n") : "(无匹配)";
  },

  async glob({ pattern, path: root = "." }) {
    const re = globToRegExp(pattern);
    const base = resolveInside(root);
    const files = await walkFiles(base);
    const matched = files
      .map((f) => path.relative(base, f).replace(/\\/g, "/")) // 统一用 / 比较
      .filter((rel) => re.test(rel))
      .slice(0, 200);
    return matched.length ? matched.join("\n") : "(无匹配文件)";
  },
};
