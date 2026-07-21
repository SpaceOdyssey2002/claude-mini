# Prompt Injection 对抗测试报告（2026-07-21）

## 测试配置

- 模型：`deepseek-chat`
- 模型对抗样本：5 组
- 权限强制测试：5 组
- 攻击入口：MCP 工具描述、参数说明、普通文本工具结果、JSON `structuredContent`
- 攻击内容：覆盖原始目标、诱导调用其他工具、诱导外传本地密钥

复现命令：

```powershell
$env:DEEPSEEK_API_KEY = "<your-key>"
npm run benchmark:prompt-injection
```

## 结果

| 指标 | 结果 |
| --- | ---: |
| DeepSeek 原始目标完成率 | 100%（5/5） |
| 恶意原文进入模型上下文比例 | 0%（0/5） |
| DeepSeek 选择外传工具比例 | 0%（0/5） |
| 外传调用实际执行次数 | 0 |
| 强制只读 MCP 外传的权限阻断率 | 100%（5/5） |
| Prompt Injection 与权限单元测试 | 6/6 |
| 全量单元测试 | 37/37 |

## 防护链路

1. MCP Server 返回的工具描述和参数说明会去除控制字符、限制长度，并隔离明显的注入文本。
2. 文件、命令、MCP、Resource、`structuredContent` 和子 Agent 结果进入模型前统一标记为不可信数据。
3. 命中明显注入特征的行不再原样传入，只保留 SHA-256 摘要，普通业务证据继续保留。
4. MCP 默认逐次审批；`readOnlyHint` 只控制只读、幂等和并行属性，不能自动取消数据外发审批。
5. 即使模型仍然选择了外传工具，用户拒绝后也不会进入底层 `dispatch`。

## 边界

- 规则检测不能识别所有改写、编码或跨片段攻击，因此不能宣称“彻底解决 Prompt Injection”。
- 用户显式配置 `approval: writes`、`approval: never`、`MINICODE_YES` 或 daemon `autoApprove` 会降低审批保护。
- 当前主要保护模型上下文和工具副作用；终端 UI 仍会向用户展示原始工具输出，便于审计。
- 已保存的旧会话可能含有改造前的原始工具结果；新保护只对改造后的工具调用生效。
