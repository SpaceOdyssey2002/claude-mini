// core/runner.js —— AgentRunner：把 agent loop 包成「可被守护进程托管」的运行单元。
//
// 和单进程 REPL 的区别：这里 agent 不直接 console.log，而是把过程 emit 到 EventBus；
// 权限确认不再是同步问答，而是「发一个 permission_request 事件 → 等客户端通过 IPC 回 decision」。
// 这样同一个 run 可以被 CLI/TUI/Web 任意客户端订阅、审批、中断。

import path from "node:path";
import { runAgentTurn } from "../agent.js";
import { buildAgentContext } from "../setup.js";
import { compact, estimateTokens } from "../context.js";
import { ToolRegistry } from "./registry.js";
import { EventBus } from "./eventbus.js";
import { Session } from "./memory.js";
import { makeTracer } from "./trace.js";

export class AgentRunner {
  constructor({ client, model, session, autoApprove = false }) {
    this.client = client;
    this.model = model;
    this.session = session || new Session();
    this.autoApprove = autoApprove;
    this.compactAt = Number(process.env.MINICODE_COMPACT_AT) || 40000;
    this.ctxTokens = 0;

    this.currentAbort = null;
    this.sessionAllow = new Set();
    this.pending = new Map(); // 待审批的权限请求：id → resolve
    this.permSeq = 0;

    const dir = Session.dir();
    this.bus = new EventBus(path.join(dir, this.session.id + ".events.jsonl"));
    this.tracer = makeTracer(path.join(dir, this.session.id + ".trace.jsonl"));
  }

  async init() {
    const ctx = await buildAgentContext({
      client: this.client, model: this.model,
      getSignal: () => this.currentAbort?.signal,
      onSubStep: (n, a, label) => this.bus.emit({ type: "sub_step", name: n, label, arg: a.pattern || a.path || "" }),
    });
    this.mcp = ctx.mcp;
    this.skills = ctx.skills;
    this.baseConfirmNeeded = ctx.baseConfirmNeeded;
    this.systemPrompt = ctx.systemPrompt;
    this.statePrompt = ctx.statePrompt;
    this.planState = ctx.planState;

    // notes 工具：让 agent 能把信息记进「跨话题持久笔记」
    const noteTool = {
      type: "function",
      function: {
        name: "take_note",
        description: "把一条需要长期记住的信息记进笔记（跨会话/话题保留，下次也能看到）。",
        parameters: {
          type: "object",
          properties: { text: { type: "string", minLength: 1, maxLength: 2000, description: "要记的内容" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    };
    const baseDispatch = ctx.dispatch;
    const rawDispatch = async (name, args, context = {}) =>
      name === "take_note" ? (this.session.addNote(args.text), "已记入笔记") : baseDispatch(name, args, context);

    this.allTools = [...ctx.allTools, noteTool];
    this.toolPolicies = new Map(ctx.toolPolicies);
    this.toolPolicies.set("take_note", {
      sideEffect: "memory-write", requiresApproval: false, parallelSafe: false,
      idempotent: false, timeoutMs: 5_000, maxRetries: 0,
    });
    this.isParallelSafe = (name) => this.toolPolicies.get(name)?.parallelSafe === true;
    // 工具统一经 ToolRegistry：参数校验 + 失败分类 + 重试
    this.registry = new ToolRegistry({
      dispatch: rawDispatch, tools: this.allTools, policies: this.toolPolicies,
      onEvent: (ev) => this.bus.emit(ev),
    });

    // ui 适配器：agent loop 的回调 → EventBus 事件
    let buf = "";
    this.ui = {
      onWaitStart: () => this.bus.emit({ type: "status", state: "thinking" }),
      onWaitEnd: () => {},
      onToken: (t) => { buf += t; this.bus.emit({ type: "token", text: t }); },
      onTextEnd: () => { if (buf) this.bus.emit({ type: "message", text: buf }); buf = ""; },
      onToolUse: (name, args) => this.bus.emit({ type: "tool_use", name, args }),
      onToolResult: (name, result, { isError }) =>
        this.bus.emit({ type: "tool_result", name, ok: !isError, preview: String(result).slice(0, 600) }),
      confirm: (name, args) => this.requestPermission(name, args),
    };

    // EventBus → trace（eventbus 层）
    this.bus.subscribe((e) => this.tracer("eventbus", "", e));
    if (!this.session.threads.length) this.session.newThread();
    return this;
  }

  confirmNeeded(name) {
    if (this.autoApprove) return false;
    if (this.sessionAllow.has(name)) return false;
    return this.baseConfirmNeeded(name);
  }

  // 发起一次权限请求，返回一个 Promise，等客户端通过 respondPermission 回复
  requestPermission(name, args) {
    const id = `perm-${++this.permSeq}`;
    const detail = name === "run_command" ? args.command : args.path ?? JSON.stringify(args);
    this.bus.emit({ type: "permission_request", id, name, detail });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.bus.emit({ type: "permission_response", id, decision: "timeout" });
        resolve(false);
      }, Number(process.env.MINICODE_PERMISSION_TIMEOUT) || 300_000);
      this.pending.set(id, (decision) => {
        clearTimeout(timer);
        if (decision === "a") this.sessionAllow.add(name);
        resolve(decision === "y" || decision === "a");
      });
    });
  }
  respondPermission(id, decision) {
    const r = this.pending.get(id);
    if (!r) return false;
    this.pending.delete(id);
    this.bus.emit({ type: "permission_response", id, decision });
    r(decision);
    return true;
  }

  interrupt() {
    this.currentAbort?.abort();
    for (const [id, decide] of this.pending) {
      this.pending.delete(id);
      decide("n");
    }
    return true;
  }

  toolSummaries() {
    return (this.allTools || []).map((t) => {
      const name = t.function.name;
      return {
        name,
        kind: this.mcp?.isMcpTool(name) ? "mcp" : "local",
        needsConfirm: this.confirmNeeded(name),
        description: t.function.description || "",
      };
    });
  }

  mcpStatus() {
    return this.mcp?.status || [];
  }

  skillSummaries() {
    return this.skills || [];
  }

  usageSummary() {
    return {
      in: this.session.usage.in,
      out: this.session.usage.out,
      ctx: this.ctxTokens,
      threads: this.session.threads.length,
      notes: this.session.notes.length,
      msgs: this.session.messages.length,
    };
  }

  async compactNow(reason = "auto") {
    const newMsgs = await compact(this.client, this.model, this.session.messages, { keepTurns: 2 });
    if (!newMsgs) return { changed: false, before: this.session.messages.length, after: this.session.messages.length };
    const t = this.session.active();
    const before = t.messages.length;
    t.messages.length = 0;
    t.messages.push(...newMsgs);
    this.ctxTokens = 0;
    this.bus.emit({ type: "compaction", reason, before, after: t.messages.length });
    this.session.save();
    return { changed: true, before, after: t.messages.length };
  }

  save(title = "") {
    if (title) this.session.active().title = title;
    this.session.save();
    return { id: this.session.id, title: this.session.active().title || "" };
  }

  clear() {
    const t = this.session.active();
    const before = t.messages.length;
    t.messages.length = 0;
    this.ctxTokens = 0;
    this.planState?.clear();
    this.session.save();
    this.bus.emit({ type: "status", state: "idle", stop_reason: "cleared" });
    return { before, after: 0 };
  }

  // 跑一次任务：goal → loop → idle
  async run(goal) {
    if (this.currentAbort) return { ok: false, error: "该会话已有任务正在运行" };
    const msgs = this.session.messages;
    msgs.push({ role: "user", content: goal });
    this.bus.emit({ type: "run_start", goal });
    this.currentAbort = new AbortController();
    let usage;
    try {
      usage = await runAgentTurn(this.client, msgs, {
        model: this.model,
        tools: this.allTools,
        dispatch: (n, a, context) => this.registry.run(n, a, context),
        confirmNeeded: (n) => this.confirmNeeded(n),
        parallelSafe: (n) => this.isParallelSafe(n),
        statePrompt: this.statePrompt,
        compactIfNeeded: async () => {
          if (estimateTokens(msgs) <= this.compactAt) return false;
          return (await this.compactNow("单轮执行中超阈值")).changed;
        },
        ui: this.ui,
        signal: this.currentAbort.signal,
        system: this.systemPrompt + this.session.notesText(),
      });
    } catch (e) {
      this.bus.emit({ type: "error", message: e.message });
      if (msgs.at(-1)?.role === "user") msgs.pop();
      this.bus.emit({ type: "status", state: "idle", stop_reason: "error" });
      this.currentAbort = null;
      return { ok: false, error: e.message };
    }
    this.currentAbort = null;
    if (usage) {
      this.session.usage.in += usage.turnInput || 0;
      this.session.usage.out += usage.turnOutput || 0;
      this.ctxTokens = usage.lastPromptTokens || this.ctxTokens;
      this.bus.emit({ type: "usage", in: this.session.usage.in, out: this.session.usage.out, ctx: this.ctxTokens });
    }
    this.tracer("llm", "out", { event: "turn", in: usage?.turnInput, out: usage?.turnOutput, tools: this.allTools.length });
    if (this.ctxTokens > this.compactAt) await this.compactNow("超阈值自动");
    this.session.save();
    this.bus.emit({
      type: "status", state: "idle",
      stop_reason: usage?.aborted ? "aborted" : usage?.stopped || "end_turn",
    });
    this.bus.emit({ type: "run_end" });
    return {
      ok: true,
      aborted: !!usage?.aborted,
      stopped: usage?.stopped || "",
      usage: { in: this.session.usage.in, out: this.session.usage.out, ctx: this.ctxTokens },
    };
  }

  async close() { await this.mcp?.closeAll(); }
}
