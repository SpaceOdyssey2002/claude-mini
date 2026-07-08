// setup.js —— 装配 agent 上下文：把工具集、MCP、子 agent、Skills、dispatch 一次性建好。
// REPL（index.js）和 daemon（core/runner.js）都用它，避免重复装配逻辑。

import { tools as builtinTools, handlers, needsConfirm } from "./tools.js";
import { McpManager } from "./mcp.js";
import { makeSubagentTool } from "./subagent.js";
import { loadSkills, skillsSection, makeSkillTool } from "./skills.js";
import { DEFAULT_SYSTEM } from "./agent.js";

/**
 * @param {Object} opts
 *   @param {object}   opts.client
 *   @param {string}   opts.model
 *   @param {Function} opts.getSignal   ()=>AbortSignal|undefined  子 agent 联动中断
 *   @param {Function} [opts.onSubStep] (name,args,label)=>void    子助手每一步回调
 * @returns {Promise<Object>} { mcp, dispatch, allTools, skills, systemPrompt, baseConfirmNeeded, isReadOnly }
 */
export async function buildAgentContext({ client, model, getSignal, onSubStep }) {
  const mcp = new McpManager();
  await mcp.init();

  // 统一调度：技能 → 子 agent → MCP → 内置
  async function dispatch(name, args) {
    if (name === "use_skill") return skillHandler(args);
    if (subHandlers[name]) return subHandlers[name](args);
    if (mcp.isMcpTool(name)) return mcp.callTool(name, args);
    if (handlers[name]) return handlers[name](args);
    throw new Error(`未知工具：${name}`);
  }

  // 子 agent（只读工具子集）
  const readonlyTools = builtinTools.filter((t) => !needsConfirm.has(t.function.name));
  const { tools: subTools, handlers: subHandlers } = makeSubagentTool({
    client, model, tools: readonlyTools, dispatch, getSignal, onStep: onSubStep,
  });

  // Skills
  const skills = loadSkills();
  const { tool: skillTool, handler: skillHandler } = makeSkillTool(skills);
  const systemPrompt = DEFAULT_SYSTEM + skillsSection(skills);

  const allTools = [...builtinTools, ...mcp.tools, ...subTools, ...(skills.length ? [skillTool] : [])];

  // 是否需确认（写操作 + 所有 MCP 工具）；调用方再叠加 sessionAllow / 自动批准
  const baseConfirmNeeded = (name) => needsConfirm.has(name) || mcp.isMcpTool(name);
  const isReadOnly = (name) => !baseConfirmNeeded(name);

  return { mcp, dispatch, allTools, skills, systemPrompt, baseConfirmNeeded, isReadOnly };
}
