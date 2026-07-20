// setup.js —— 装配 agent 上下文：把工具集、MCP、子 agent、Skills、dispatch 一次性建好。
// REPL（index.js）和 daemon（core/runner.js）都用它，避免重复装配逻辑。

import { tools as builtinTools, handlers, needsConfirm, toolPolicies as builtinPolicies, getWorkspace } from "./tools.js";
import { McpManager } from "./mcp.js";
import { makeSubagentTool } from "./subagent.js";
import { loadSkills, skillsSection, makeSkillTool } from "./skills.js";
import { DEFAULT_SYSTEM } from "./agent.js";
import { PlanState, makePlanTool } from "./plan.js";
import { FileCheckpointManager } from "./core/checkpoint.js";

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
  async function dispatch(name, args, context = {}) {
    if (name === "update_plan") return planHandler(args);
    if (name === "use_skill") return skillHandler(args);
    if (subHandlers[name]) return subHandlers[name](args);
    if (mcp.isMcpTool(name)) return mcp.call(name, args, context);
    if (handlers[name]) return handlers[name](args, context);
    throw new Error(`未知工具：${name}`);
  }

  // 子 agent（只读工具子集）
  const readonlyTools = builtinTools.filter((t) => !needsConfirm.has(t.function.name));
  const { tools: subTools, handlers: subHandlers, policies: subPolicies } = makeSubagentTool({
    client, model, tools: readonlyTools, dispatch, getSignal, onStep: onSubStep,
  });

  // Skills
  const skills = loadSkills();
  const { tool: skillTool, handler: skillHandler, policy: skillPolicy } = makeSkillTool(skills);
  const systemPrompt = DEFAULT_SYSTEM + skillsSection(skills);

  // Plan 状态不依赖聊天窗口；历史被压缩后仍会在每次模型调用前重新注入。
  const planState = new PlanState();
  const { tool: planTool, handler: planHandler, policy: planPolicy } = makePlanTool(planState);
  const checkpointManager = new FileCheckpointManager({ root: getWorkspace() });

  const allTools = [...builtinTools, ...mcp.tools, ...subTools, planTool, ...(skills.length ? [skillTool] : [])];
  const toolPolicies = new Map(builtinPolicies);
  for (const [name, policy] of mcp.policies) toolPolicies.set(name, policy);
  for (const [name, policy] of subPolicies) toolPolicies.set(name, policy);
  if (skills.length) toolPolicies.set("use_skill", skillPolicy);
  toolPolicies.set("update_plan", planPolicy);

  // 审批与并行安全是两个独立维度：批准写操作不代表它可以和其他写操作并发。
  const baseConfirmNeeded = (name) => toolPolicies.get(name)?.requiresApproval ?? (needsConfirm.has(name) || mcp.isMcpTool(name));
  const isReadOnly = (name) => !baseConfirmNeeded(name);
  const isParallelSafe = (name) => toolPolicies.get(name)?.parallelSafe === true;

  return {
    mcp, dispatch, allTools, skills, systemPrompt, baseConfirmNeeded, isReadOnly,
    isParallelSafe, toolPolicies, planState, checkpointManager,
    statePrompt: () => planState.prompt(),
  };
}
