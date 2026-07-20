# minicode

`minicode` 是一个从零手写的命令行编程 agent，用来学习 Claude Code 这类工具背后的核心机制：模型如何发起工具调用、程序如何执行工具、权限如何审批、上下文如何保存和压缩、MCP/Skills/子 agent 如何接入。

当前项目已经不只是早期的单进程 demo。它有两种运行方式：

- `npm start`：单进程 REPL，逻辑集中在 `src/index.js`，适合快速体验和理解 agent loop。
- `npm run core` + `npm run cli`/`npm run tui`：daemon/client 架构，agent 在 `minicode-core` 中运行，客户端通过 TCP + JSON-RPC 订阅事件、审批权限、发起中断，适合学习 IPC 和可观测运行时。

后端默认使用 DeepSeek 的 OpenAI 兼容接口。

## 功能

- 流式对话：边生成边输出，支持中途 Ctrl+C 中断。
- 内置工具：读文件、列目录、搜索、glob、写文件、精确编辑、执行命令。
- 工具治理：更严格的嵌套参数约束、逐工具超时、结构化错误，以及仅对幂等操作执行 transient 重试。
- 错误恢复：重复调用、连续失败或无进展时自动回到已验证事实并限次重规划。
- 文件检查点：同一批 `write_file`/`edit_file` 在验证命令失败时恢复原文件或删除新建文件；回滚前用 SHA-256 检测并发修改冲突。
- LoopGuard：限制模型迭代、工具总数、重复观察、连续错误和单轮总时长，触发后受控收尾。
- Plan 模式：复杂任务通过 `update_plan` 保存结构化步骤、验收条件和证据。
- 结构化结果：CLI/TUI 可选择预定义输出契约，任务完成后使用 `response_format` 收尾，并执行本地 Schema 校验和限次修复。
- 工作目录沙箱：文件工具只能访问 `MINICODE_WORKSPACE` 内部路径。
- 权限审批：按工具副作用和 MCP annotations 区分只读/写入；高风险工具不能会话级永久放行。
- MCP：支持 stdio 与 Streamable HTTP、分页工具发现、Resources 发现/读取，并保留 `structuredContent`。
- 子 agent：`spawn_agent` / `spawn_agents` 使用只读工具做独立调查，支持并行。
- Skills：从 `skills/<name>/SKILL.md` 加载技能索引，模型需要时再用 `use_skill` 读取完整说明。
- 会话持久化：保存到 `.sessions/`，支持恢复、列表和 replay。
- 上下文压缩：历史太长时可把旧对话压缩成摘要。
- 漂移控制：每轮固定注入原始目标和当前计划；长任务可在执行中压缩，摘要保留失败方案和验证证据。
- 审计链路：工具调用通过 `executionId` 关联调用、审批、重试和结果，参数写盘前会脱敏；daemon 写入 `.events.jsonl`，单进程入口写入 `.audit.jsonl`。
- trace 回放：记录 IPC / EventBus / LLM 三层时间线，方便复盘。



## 目录结构

```text
minicode/
  src/
    index.js              # 旧单进程 REPL 入口：界面、斜杠命令、权限确认、会话保存
    agent.js              # 核心 agent loop：流式模型调用、工具调用累积、执行工具、回喂结果
    setup.js              # 组装工具、MCP、Skills、子 agent，供 index 和 daemon 共用
    tools.js              # 内置工具和工作目录沙箱
    mcp.js                # MCP client 管理：连接 server、收集工具、路由调用
    subagent.js           # spawn_agent / spawn_agents
    skills.js             # Skills 加载与 use_skill 工具
    context.js            # token 粗估与上下文压缩
    plan.js               # 结构化 Plan 状态、步骤验收条件和证据约束
    output.js             # 最终输出契约、JSON Schema 校验和结构化收尾重试
    session.js            # 旧单进程 REPL 的扁平会话存储
    ui.js                 # ANSI 终端渲染

    core/
      daemon.js           # minicode-core：TCP JSON-RPC daemon
      runner.js           # AgentRunner：把 agent loop 包成 daemon 中的运行单元
      rpc.js              # JSON-RPC over NDJSON 分帧与分发
      eventbus.js         # 结构化事件总线与 events.jsonl
      registry.js         # 工具参数校验、错误分类、短暂错误重试
      checkpoint.js       # 文件 pre-image 检查点、验证失败回滚和哈希冲突保护
      memory.js           # daemon 模式的分层会话：session / thread / notes
      trace.js            # IPC / EventBus / LLM 三层 trace

    clients/
      client.js           # 客户端公共逻辑：连接 daemon、REPL、权限响应、中断
      cli.js              # 朴素 CLI 渲染
      tui.js              # 盒子/卡片风格 TUI 渲染
      replay.js           # 读取 trace/events 回放一次会话

  test/
    core.test.js          # 核心模块单元测试
    ipc-permission.test.js # IPC 权限审批联调测试

  skills/                 # 本地 Skills
  mcp-servers/            # 示例 MCP server
  playground/             # 演示工作目录
  .sessions/              # 运行时会话、事件、trace 输出
  mcp.json                # MCP server 配置
```



## 安装

```powershell
npm install
$env:DEEPSEEK_API_KEY = "sk-..."
```

可选：

```powershell
$env:DEEPSEEK_MODEL = "deepseek-chat"
$env:MINICODE_WORKSPACE = "E:\minicode"
```



## 运行：单进程模式

```powershell
npm start
```

这个模式直接启动 `src/index.js`。它在同一个进程里完成：

- 读取用户输入。
- 调用模型。
- 执行工具。
- 询问权限。
- 保存会话。

常用命令：

```text
/help       查看命令
/tools      查看工具
/mcp        查看 MCP 连接状态
/skills     查看 Skills
/usage      查看 token 用量
/compact    手动压缩上下文
/sessions   查看旧会话
/resume     恢复会话
/save       保存当前会话
/clear      清空当前上下文
exit        退出
```



## 运行：daemon/client 模式

先开一个终端启动核心进程：

```powershell
$env:DEEPSEEK_API_KEY = "sk-..."
npm run core
```

再开另一个终端连接客户端：

```powershell
npm run cli
# 或
npm run tui
```

这个模式下，真正运行任务的是 `minicode-core`。CLI/TUI 只是客户端，通过 TCP + JSON-RPC 做三件事：

- 调用 `run` 发起任务。
- 接收 `event` notification 渲染过程。
- 调用 `permission.respond` 回复权限审批。

CLI/TUI 支持的本地命令：

```text
/help             显示帮助
/tools            查看工具
/mcp              查看 MCP 连接状态
/skills           查看 Skills
/usage            查看 token 用量
/compact          手动压缩上下文
/sessions         查看旧会话
/resume [id]      恢复会话；不传 id 时恢复最近一次
/save [title]     保存当前会话，可选标题
/clear            清空当前上下文
/format [模式]    查看或设置最终输出：text / json / task_result
exit / quit       退出客户端
Ctrl+C            任务运行中为中断；空闲时为退出
```

### 结构化最终输出

`/format` 只改变后续任务的最终交付格式，不影响中间工具调用。当前支持：

| 模式 | 最终结果 | 适用场景 |
| --- | --- | --- |
| `text` | 普通流式自然语言 | 日常交互和人工阅读 |
| `json` | 字段不限的 JSON 对象 | 临时 JSON 输出 |
| `task_result` | 固定任务结果 Schema | 脚本、流水线和其他程序消费 |

例如：

```text
/format task_result
修复登录接口并运行测试
```

最终得到固定字段：

```json
{
  "status": "completed",
  "summary": "修复登录接口并完成验证",
  "changed_files": ["src/login.js"],
  "verification": ["npm test：23 项测试通过"],
  "remaining": []
}
```

这里不是把“请输出 JSON”拼进用户 Prompt。Client 会把格式名称作为独立控制字段发送：

```json
{
  "goal": "修复登录接口并运行测试",
  "outputFormat": "task_result"
}
```

真正的 Schema 预定义在 `src/output.js`，调用方传的是契约名称，不需要手写 JSON Schema。
处理流程如下：

```text
CLI/TUI 选择 outputFormat
  -> Agent 正常调用文件、命令和 MCP 工具
  -> 验证完成并结算文件检查点
  -> 无工具的收尾调用使用 response_format 生成 JSON
  -> 本地按预定义 Schema 校验
     -> 合法：发出 structured_output 事件并返回解析后的 result
     -> 非法：携带具体错误修复，最多重试两次
```

执行和收尾分离，避免最终 JSON Schema 干扰中间 Tool Calling。结构化模式会多一次模型调用；
DeepSeek 的 `json_object` 保证 JSON 语法，字段完整性由本地 Schema 校验保证，但两者都不能
保证内容在语义上真实，所以文件修改和测试结果仍以工具证据为准。使用 `/format text` 可恢复
普通流式输出。该命令目前只接入 daemon/client 模式，旧的 `npm start` 单进程入口尚未支持。

任务运行时，CLI/TUI 会在等待模型或工具链路时显示旋转处理图标；一旦开始流式输出、调用工具、进入审批或结束，会自动清掉 spinner。

如果想回放最近一次 daemon 会话：

```powershell
npm run replay
```

也可以指定 session id：

```powershell
npm run replay sess-20260625-212012
```

`npm run replay` 同时支持两种会话：

- daemon/client 模式：优先读取 `.events.jsonl` 和 `.trace.jsonl`，回放事件流和 IPC/LLM 时间线。
- 单进程模式：没有事件文件时，读取 `.sessions/<id>.json` 里的 `messages`，按用户、助手、工具结果回放对话。



## MCP

`mcp.json` 支持本地 stdio 和远程 Streamable HTTP。stdio 示例：

```json
{
  "mcpServers": {
    "demo": {
      "command": "node",
      "args": ["mcp-servers/demo-server.js"]
    },
    "filesystem": {
      "command": "node",
      "args": [
        "node_modules/@modelcontextprotocol/server-filesystem/dist/index.js",
        "playground"
      ]
    }
  }
}
```

HTTP 示例（`${MCP_TOKEN}` 在运行时从环境变量展开）：

```json
{
  "mcpServers": {
    "knowledge": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN}"
      },
      "timeoutMs": 60000,
      "approval": "writes",
      "toolApproval": {
        "publish_document": "always"
      }
    }
  }
}
```

`approval` 和单工具覆盖 `toolApproval` 可取：

- `writes`：默认值；`readOnlyHint: true` 直接执行，写入或未知工具审批。
- `always`：所有工具审批。
- `never`：宿主不审批；只应对已经由服务端权限系统充分保护的 Server 使用。

启动时 `src/mcp.js` 会按游标分页调用 `listTools()`，并把发现的工具命名成：

```text
mcp__<server>__<tool>
```

工具返回会保留原始 `content`、`structuredContent` 和 `_meta`，再由统一 Registry 序列化后交给模型。

如果 Server 声明 Resources 能力，minicode 额外提供两个只读桥接工具：

- `list_mcp_resources({server})`：动态列出 Resources 和 Resource Templates。
- `read_mcp_resource({server, uri})`：读取真实 URI 对应的内容。

Resources 不会整批塞进系统 Prompt；Agent 需要时先发现、再按 URI 读取。当前 HTTP 支持静态 Header/Bearer Token；需要浏览器交互的 OAuth 授权流程尚未实现。

本项目默认发现并暴露 Server 返回的全部工具，没有静态 `allowedTools`。如果未来需要减少上下文，应实现运行时工具目录和动态启用；部署级禁用则应通过 Server 自身 toolset、账号权限或独立配置控制，不应把“工具发现”和“永久 allowlist”混为一谈。

## 测试

```powershell
npm test
npm run typecheck
```

文件回滚采用受限事务语义：第一次 `write_file`/`edit_file` 打开一个内存检查点，后续文件修改
加入同一批次；`run_command` 成功即提交，失败则回滚整批。回合中断、LoopGuard 停止或模型调用
异常时也回滚未提交批次。命令自身、MCP、数据库和网络等外部副作用不在回滚范围内；如果文件
在 Agent 写入后又被用户或其他进程修改，哈希冲突检测会拒绝覆盖。

## 端到端 Benchmark

基准包含 12 项隔离工作区任务，使用文件内容、JSON、修改范围和测试退出码做机器验收，
统计任务完成率、参数合法率、工具选择/执行成功率、错误恢复率、平均工具调用数和 token。

```powershell
# 离线自检评测链路（不能作为模型成绩）
npm run benchmark:mock

# 真实模型，每项重复 3 次
$env:DEEPSEEK_API_KEY = "sk-..."
npm run benchmark
```

报告写入 `benchmark/results/*.json` 和 `*.md`。简历只能引用 `real` 模式结果。

当前测试覆盖：

- JSON-RPC 分帧和分发。
- 工具参数校验。
- 错误分类。
- 幂等 transient 重试与非幂等禁止重试。
- 文件批次回滚、创建文件撤销、验证成功提交和 SHA-256 冲突保护。
- 主 Agent 重复观察后的自动恢复和 LoopGuard 收尾。
- Plan 状态约束。
- 单回合上下文压缩。
- glob 的 `**/` 零层/多层匹配。
- 命令非零退出码错误语义。
- EventBus。
- daemon 模式 Session。
- 工作目录沙箱。
- IPC 权限审批联调：假模型触发 `write_file`，客户端通过 `permission.respond` 批准，runner 继续写入文件。
- stdio/Streamable HTTP MCP 发现与调用、HTTP Header 环境变量、Resources 发现/读取和 `structuredContent` 保留。
- MCP annotations 权限策略，以及审计 ID 在工具调用、审批和结果之间的关联。



## 环境变量


| 变量                    | 作用                                 |
| --------------------- | ---------------------------------- |
| `DEEPSEEK_API_KEY`    | DeepSeek API key，必填                |
| `DEEPSEEK_MODEL`      | 模型名，默认 `deepseek-chat`             |
| `MINICODE_WORKSPACE`  | 工作目录沙箱根，默认当前目录                     |
| `MINICODE_YES`        | 自动批准所有需确认操作，谨慎使用                   |
| `MINICODE_PORT`       | daemon/client 模式 TCP 端口，默认 `47800` |
| `MINICODE_COMPACT_AT` | 超过多少 prompt token 后自动压缩，默认 `40000` |
| `MINICODE_TOOL_CAP`   | 单个工具结果回喂模型的最大字符数，默认 `8000`         |
| `MINICODE_MAX_ITERATIONS` | 单轮最多模型迭代数，默认 `12` |
| `MINICODE_MAX_TOOL_CALLS` | 单轮最多工具调用数，默认 `30` |
| `MINICODE_MAX_SAME_CALL` | 相同工具与参数的触发阈值，默认 `3` |
| `MINICODE_MAX_SAME_RESULT` | 相同工具结果的无进展阈值，默认 `3` |
| `MINICODE_MAX_CONSECUTIVE_ERRORS` | 连续工具错误阈值，默认 `3` |
| `MINICODE_MAX_RECOVERY_ATTEMPTS` | 自动恢复/重规划次数，默认 `2` |
| `MINICODE_RUN_TIMEOUT` | 单轮总时长上限（毫秒），默认 `600000` |
| `MINICODE_PERMISSION_TIMEOUT` | daemon 权限审批等待上限（毫秒），默认 `300000` |




## 学习路线

建议按这个顺序读代码：

1. `src/agent.js`：先理解 agent loop。
2. `src/tools.js`：看工具定义、handler 和沙箱。
3. `src/setup.js`：看工具、MCP、Skills、子 agent 如何被组装。
4. `src/index.js`：看单进程 REPL 如何把这些能力接起来。
5. `src/core/runner.js`、`src/core/daemon.js`、`src/clients/client.js`：看 daemon/client 的 IPC 权限审批和事件流。
6. `src/mcp.js`、`src/subagent.js`、`src/skills.js`：看扩展能力。
7. `src/context.js`、`src/core/memory.js`、`src/core/trace.js`：看长对话、记忆和可观测性。
