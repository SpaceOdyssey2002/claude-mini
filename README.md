# minicode

`minicode` 是一个从零手写的命令行编程 agent，用来学习 Claude Code 这类工具背后的核心机制：模型如何发起工具调用、程序如何执行工具、权限如何审批、上下文如何保存和压缩、MCP/Skills/子 agent 如何接入。

当前项目已经不只是早期的单进程 demo。它有两种运行方式：

- `npm start`：单进程 REPL，逻辑集中在 `src/index.js`，适合快速体验和理解 agent loop。
- `npm run core` + `npm run cli`/`npm run tui`：daemon/client 架构，agent 在 `minicode-core` 中运行，客户端通过 TCP + JSON-RPC 订阅事件、审批权限、发起中断，适合学习 IPC 和可观测运行时。

后端默认使用 DeepSeek 的 OpenAI 兼容接口。

## 功能

- 流式对话：边生成边输出，支持中途 Ctrl+C 中断。
- 内置工具：读文件、列目录、搜索、glob、写文件、精确编辑、执行命令。
- 工作目录沙箱：文件工具只能访问 `MINICODE_WORKSPACE` 内部路径。
- 权限审批：写文件、改文件、执行命令、MCP 工具执行前需要确认；支持本会话放行和自动批准模式。
- MCP：读取 `mcp.json`，连接本地或外部 MCP server，并把 MCP 工具转成模型可调用的 function tool。
- 子 agent：`spawn_agent` / `spawn_agents` 使用只读工具做独立调查，支持并行。
- Skills：从 `skills/<name>/SKILL.md` 加载技能索引，模型需要时再用 `use_skill` 读取完整说明。
- 会话持久化：保存到 `.sessions/`，支持恢复、列表和 replay。
- 上下文压缩：历史太长时可把旧对话压缩成摘要。
- daemon 事件流：把 token、工具调用、权限请求、重试、usage、错误等都结构化成事件。
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
    session.js            # 旧单进程 REPL 的扁平会话存储
    ui.js                 # ANSI 终端渲染

    core/
      daemon.js           # minicode-core：TCP JSON-RPC daemon
      runner.js           # AgentRunner：把 agent loop 包成 daemon 中的运行单元
      rpc.js              # JSON-RPC over NDJSON 分帧与分发
      eventbus.js         # 结构化事件总线与 events.jsonl
      registry.js         # 工具参数校验、错误分类、短暂错误重试
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
exit / quit       退出客户端
Ctrl+C            任务运行中为中断；空闲时为退出
```

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

`mcp.json` 使用类似 Claude Desktop/Code 的配置格式：

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

启动时 `src/mcp.js` 会连接这些 server，调用 `listTools()`，并把工具命名成：

```text
mcp__<server>__<tool>
```

所有 MCP 工具默认需要权限审批。

## 测试

```powershell
npm test
npm run typecheck
```

当前测试覆盖：

- JSON-RPC 分帧和分发。
- 工具参数校验。
- 错误分类。
- EventBus。
- daemon 模式 Session。
- 工作目录沙箱。
- IPC 权限审批联调：假模型触发 `write_file`，客户端通过 `permission.respond` 批准，runner 继续写入文件。



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




## 学习路线

建议按这个顺序读代码：

1. `src/agent.js`：先理解 agent loop。
2. `src/tools.js`：看工具定义、handler 和沙箱。
3. `src/setup.js`：看工具、MCP、Skills、子 agent 如何被组装。
4. `src/index.js`：看单进程 REPL 如何把这些能力接起来。
5. `src/core/runner.js`、`src/core/daemon.js`、`src/clients/client.js`：看 daemon/client 的 IPC 权限审批和事件流。
6. `src/mcp.js`、`src/subagent.js`、`src/skills.js`：看扩展能力。
7. `src/context.js`、`src/core/memory.js`、`src/core/trace.js`：看长对话、记忆和可观测性。
