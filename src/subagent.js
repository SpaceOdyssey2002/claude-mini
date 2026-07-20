// subagent.js —— 子 agent：spawn_agent（单个）+ spawn_agents（批量并行）。
//
// spawn_agent：把一个独立的只读调查任务派给子助手，子助手用只读工具自己查清楚、只回结论。
// spawn_agents：一次接收一组任务，内部用 Promise.all 同时跑多个子助手——真正的并行子 agent。
//   适合"把一个大调查拆成几块互不依赖的子任务、同时推进"，主上下文只收到各自的结论。
//
// 安全：子助手只拿到只读工具，不会改文件、不会执行命令。

import { validateArgs } from "./core/registry.js";

const SUB_SYSTEM = `你是一个只读调查子助手。用提供的只读工具（read_file/list_dir/grep/glob）
去查清楚交给你的问题，然后用简洁的中文要点给出结论。
不要尝试修改文件或执行命令——你只负责"查"和"答"。`;

/**
 * @param {Object} opts
 *   @param {object}   opts.client
 *   @param {string}   opts.model
 *   @param {Array}    opts.tools       只读工具列表（OpenAI 格式）
 *   @param {Function} opts.dispatch    (name,args)=>Promise<string>
 *   @param {Function} opts.getSignal   ()=>AbortSignal|undefined
 *   @param {Function} opts.onStep      (name,args,label)=>void   展示子助手每一步（可选）
 * @returns {{ tools: Array, handlers: Object, policies: Map<string, Object> }}
 */
export function makeSubagentTool({ client, model, tools, dispatch, getSignal, onStep }) {
  // 跑一个子助手到出结论。label 用于并行时区分是哪个子任务。
  async function runOne(task, label = "") {
    const messages = [{ role: "user", content: task }];
    const schemas = new Map(tools.map((t) => [t.function.name, t.function.parameters]));
    for (let step = 0; step < 8; step++) { // 最多 8 步，防止打转
      const res = await client.chat.completions.create(
        { model, messages: [{ role: "system", content: SUB_SYSTEM }, ...messages], tools, stream: false },
        { signal: getSignal?.() }
      );
      const msg = res.choices[0].message;
      messages.push(msg);
      if (!msg.tool_calls?.length) return msg.content || "(子助手没有给出结论)";
      for (const call of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || "{}"); }
        catch {
          messages.push({ role: "tool", tool_call_id: call.id, content: "参数 JSON 解析失败，请修正后再调用" });
          continue;
        }
        onStep?.(call.function.name, args, label);
        let result;
        try {
          const errs = validateArgs(schemas.get(call.function.name), args);
          if (errs.length) throw new Error(`参数校验失败：${errs.join("；")}`);
          result = await dispatch(call.function.name, args, { signal: getSignal?.() });
        }
        catch (e) { result = "出错：" + e.message; }
        messages.push({ role: "tool", tool_call_id: call.id, content: String(result).slice(0, 4000) });
      }
    }
    return "(子助手达到步数上限，未完成)";
  }

  const singleTool = {
    type: "function",
    function: {
      name: "spawn_agent",
      description:
        "派一个只读子助手独立完成一个调查类子任务（在代码库里搜集信息、定位实现、统计某类文件等），" +
        "返回它的结论。适合可独立完成、不需要改文件的子任务。",
      parameters: {
        type: "object",
        properties: { task: { type: "string", description: "交给子助手的完整任务描述（越具体越好）" } },
        required: ["task"],
        additionalProperties: false,
      },
    },
  };

  const manyTool = {
    type: "function",
    function: {
      name: "spawn_agents",
      description:
        "一次派多个只读子助手【并行】完成一组互不依赖的调查子任务，全部跑完后汇总返回各自结论。" +
        "当一个调查可以拆成几块同时进行时用它，比逐个 spawn_agent 更快。",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 4,
            description: "若干个互相独立的子任务描述，会被同时执行",
          },
        },
        required: ["tasks"],
        additionalProperties: false,
      },
    },
  };

  const handlers = {
    async spawn_agent({ task }) {
      return runOne(task);
    },
    async spawn_agents({ tasks }) {
      const list = Array.isArray(tasks) ? tasks : [];
      if (!list.length) return "(没有提供子任务)";
      if (list.length > 4) throw new Error("一次最多并行 4 个子任务，请拆分后再调用");
      // Promise.all 同时跑所有子助手 —— 真正的并行
      const results = await Promise.all(list.map((t, i) => runOne(t, `#${i + 1}`)));
      return list.map((t, i) => `### 子任务 ${i + 1}：${t}\n${results[i]}`).join("\n\n");
    },
  };

  const policies = new Map([
    ["spawn_agent", { sideEffect: "none", requiresApproval: false, parallelSafe: true, idempotent: true, timeoutMs: 120_000, maxRetries: 1 }],
    ["spawn_agents", { sideEffect: "none", requiresApproval: false, parallelSafe: false, idempotent: true, timeoutMs: 120_000, maxRetries: 1 }],
  ]);

  return { tools: [singleTool, manyTool], handlers, policies };
}
