// skills.js —— Skills（技能）：渐进式加载的领域知识/工作流。
//
// 灵感来自 Claude Code 的 Skills：每个技能是 skills/<名字>/SKILL.md，带 frontmatter
// （name + description）和正文（详细操作说明）。
// 关键是"渐进式披露"：
//   - 平时只把每个技能的"名字 + 一句话描述"放进系统提示（占用很少 token）
//   - 当任务匹配某个技能时，模型用 use_skill 工具读取该技能的完整正文，再据此操作
// 这样既让模型知道"有哪些本事可用"，又不必把所有细节一直塞在上下文里。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(PROJECT_ROOT, "skills");

// 解析 SKILL.md 的 frontmatter（--- 之间的 key: value）和正文
function parseSkill(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2].trim() };
}

// 加载 skills/ 目录下所有技能
export function loadSkills() {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return out; // 没有 skills 目录
  }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const file = path.join(SKILLS_DIR, d.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const { meta, body } = parseSkill(fs.readFileSync(file, "utf8"));
    out.push({ name: meta.name || d.name, description: meta.description || "", body });
  }
  return out;
}

// 生成注入系统提示的"技能清单"段落
export function skillsSection(skills) {
  if (!skills.length) return "";
  const lines = skills.map((s) => `- ${s.name}：${s.description}`).join("\n");
  return `\n\n你有以下"技能"可按需加载——当任务匹配某个技能时，先用 use_skill 工具读取它的完整说明，再据此操作：\n${lines}`;
}

// 构造 use_skill 工具（按名字返回某技能的完整正文）
export function makeSkillTool(skills) {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const tool = {
    type: "function",
    function: {
      name: "use_skill",
      description: "加载一个技能的完整操作说明。当任务匹配某个已列出的技能时，先调用它获取详细指引再动手。",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "技能名称" } },
        required: ["name"],
      },
    },
  };
  async function handler({ name }) {
    const s = byName.get(name);
    if (!s) return `没有名为 '${name}' 的技能。可用技能：${[...byName.keys()].join(", ") || "（无）"}`;
    return s.body;
  }
  return { tool, handler };
}
