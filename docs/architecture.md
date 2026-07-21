# minicode 架构图

minicode 是一个支持远程 DeepSeek 和本地 Ollama/Qwen 的轻量级 Agent Runtime。它通过统一的 Agent Loop 调度内置工具、MCP、Skills 和只读子 Agent，并在工具执行外围提供参数校验、权限审批、审计、错误恢复、checkpoint 与 verification。

```mermaid
flowchart TB
    USER([用户])

    subgraph ACCESS["① 交互与运行入口"]
        REPL["单进程 REPL<br/>快速体验"]
        CLIENT["CLI / TUI<br/>交互、审批、中断"]
        DAEMON["minicode-core Daemon<br/>TCP + JSON-RPC"]
        CLIENT <-->|事件订阅 / 权限响应| DAEMON
    end

    USER --> REPL
    USER --> CLIENT

    subgraph RUNTIME["② Agent Runtime"]
        RUNNER["AgentRunner"]
        CONTEXT["上下文组装<br/>System + Goal + Notes + Plan + Messages"]
        LOOP["Agent Loop<br/>思考 → 调工具 → 观察 → 继续"]
        GUARD["执行保护<br/>重复检测 · 错误恢复 · 步数/时间上限"]
        OUTPUT["结果收尾<br/>文本 / Structured Output"]

        RUNNER --> CONTEXT --> LOOP
        GUARD -.约束每轮执行.-> LOOP
        LOOP --> OUTPUT
    end

    REPL --> CONTEXT
    DAEMON --> RUNNER

    subgraph MODEL["③ 模型适配层"]
        ADAPTER["统一模型接口"]
        DEEPSEEK["远程 DeepSeek"]
        OLLAMA["本地 Ollama / Qwen"]
        ADAPTER --> DEEPSEEK
        ADAPTER --> OLLAMA
    end

    LOOP <-->|Messages / Tool Calls / Stream| ADAPTER

    subgraph GOVERNANCE["④ 工具治理层"]
        REGISTRY["Tool Registry"]
        SCHEMA["参数 Schema 校验"]
        PERMISSION["权限策略与人工确认"]
        RETRY["错误分类与有限重试"]
        AUDIT["Audit ID<br/>参数摘要 · 结果 · 耗时"]

        REGISTRY --> SCHEMA
        SCHEMA --> PERMISSION
        PERMISSION --> RETRY
        RETRY --> AUDIT
    end

    LOOP -->|调用请求| REGISTRY
    AUDIT -->|结构化工具结果| LOOP

    subgraph CAPABILITY["⑤ 能力与外部系统"]
        BUILTIN["内置工具<br/>读取 · 搜索 · 编辑 · 命令"]
        MCP["MCP Manager<br/>工具发现与统一路由"]
        SUBAGENT["只读子 Agent"]
        SKILLS["Skills<br/>按需加载操作规范"]

        STDIO["MCP stdio Server"]
        HTTP["MCP Streamable HTTP Server"]
        RESOURCE["MCP Resources<br/>主动发现、按 URI 读取"]

        MCP --> STDIO
        MCP --> HTTP
        MCP --> RESOURCE
    end

    AUDIT --> BUILTIN
    AUDIT --> MCP
    AUDIT --> SUBAGENT
    AUDIT --> SKILLS

    subgraph SAFETY["⑥ 文件修改安全闭环"]
        WRITE["write_file / edit_file"]
        CHECKPOINT["修改前 Checkpoint"]
        VERIFY["run_command 验证"]
        COMMIT["验证成功<br/>提交当前批次"]
        ROLLBACK["验证失败<br/>自动回滚文件"]

        WRITE --> CHECKPOINT --> VERIFY
        VERIFY -->|通过| COMMIT
        VERIFY -->|失败| ROLLBACK
    end

    BUILTIN --> WRITE
    COMMIT --> LOOP
    ROLLBACK --> LOOP

    subgraph MEMORY["⑦ 上下文、记忆与可观测性"]
        MESSAGES["短期记忆<br/>当前 Thread Messages"]
        COMPACT["上下文压缩<br/>旧历史摘要 + 保留近期交互"]
        SESSION["Session 持久化<br/>.sessions/*.json"]
        NOTES["长期笔记 Notes<br/>恢复同一 Session 后继续注入"]
        PLAN["PlanState<br/>当前任务运行时状态"]
        TRACE["Events / Trace / Audit<br/>回放与问题追踪"]

        MESSAGES --> COMPACT --> MESSAGES
        MESSAGES <--> SESSION
        NOTES --> SESSION
    end

    MESSAGES -.每轮注入.-> CONTEXT
    NOTES -.每轮注入.-> CONTEXT
    PLAN -.每轮注入.-> CONTEXT
    AUDIT --> TRACE
    RUNNER --> TRACE
```

## 一次任务的执行路径

```text
用户目标
→ 组装当前上下文与可用工具
→ 模型决定回答或调用工具
→ Registry 校验参数和权限
→ 执行内置工具、MCP、Skill 或子 Agent
→ 工具结果携带审计信息返回 Agent Loop
→ 修改类任务创建 checkpoint 并运行 verification
→ 验证成功后提交批次，失败则回滚文件并调整方案
→ 输出文本或结构化结果
→ 保存 Session、Events、Trace 和 Audit
```

## 面试介绍

> minicode 不是简单的聊天机器人，而是一个轻量级 Agent Runtime。上层支持单进程和 daemon/client 两种运行方式，中间通过统一 Agent Loop 调度远程 DeepSeek 或本地 Qwen，下层通过 Tool Registry 管理内置工具、MCP、Skills 和子 Agent，并在工具执行外围实现参数校验、权限审批、审计、错误恢复，以及 checkpoint 和 verification 安全闭环。

## 边界说明

- MCP Resource 不会自动进入上下文，必须先发现再按 URI 主动读取。
- Notes 是当前 Session 的持久笔记，不是跨所有 Session 的全局知识库。
- PlanState 是运行时任务状态，当前不会随 Session 持久化。
- checkpoint 只覆盖内置文件写入；命令、MCP 和外部系统副作用不会自动回滚。
- Events、Trace 和 Audit 用于审计与回放，不会自动作为记忆注入模型。
