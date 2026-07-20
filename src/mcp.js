// mcp.js —— MCP（Model Context Protocol）客户端管理器。
//
// MCP 让 agent 能用上"别人写好的工具服务器"——文件系统、数据库、GitHub、Slack 等等。
// 流程：
//   1. 读 mcp.json，知道要连哪些服务器
//   2. 用 stdio 把每个服务器当子进程拉起来并握手
//   3. 问每个服务器"你有哪些工具"（listTools）
//   4. 把这些工具转成 OpenAI function 格式，连同内置工具一起交给模型
//   5. 模型调用 mcp 工具时，路由回对应的服务器执行
//
// 工具命名沿用真 Claude Code 的约定：mcp__<服务器名>__<工具名>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// 项目根目录（src 的上一级），用于定位 mcp.json 和解析相对路径
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 读取 mcp.json：优先当前工作目录，其次项目根目录。没有就返回空配置。
export function loadMcpConfig() {
  for (const dir of [process.cwd(), PROJECT_ROOT]) {
    const file = path.join(dir, "mcp.json");
    if (fs.existsSync(file)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
        return { servers: cfg.mcpServers || {}, dir };
      } catch (e) {
        console.error(`mcp.json 解析失败：${e.message}`);
        return { servers: {}, dir };
      }
    }
  }
  return { servers: {}, dir: PROJECT_ROOT };
}

export class McpManager {
  constructor() {
    this.clients = new Map();   // serverName -> Client
    this.routes = new Map();    // 命名工具名 -> { server, originalName }
    this.tools = [];            // OpenAI function 格式，喂给模型
    this.policies = new Map();  // 工具运行策略：审批/并发/幂等/超时
    this.status = [];           // 给 /mcp 命令展示的状态
  }

  // 连接所有配置的服务器并收集工具
  async init() {
    const { servers, dir } = loadMcpConfig();
    for (const [name, conf] of Object.entries(servers)) {
      try {
        const transport = new StdioClientTransport({
          command: conf.command,
          args: conf.args || [],
          env: { ...process.env, ...(conf.env || {}) },
          cwd: dir, // 让 mcp.json 里的相对路径相对项目根目录解析
        });
        const client = new Client({ name: "minicode", version: "0.2.0" });
        await client.connect(transport);

        const { tools } = await client.listTools();
        this.clients.set(name, client);

        for (const t of tools) {
          const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
          const fqName = `mcp__${safe}__${t.name}`;
          this.routes.set(fqName, { server: name, originalName: t.name });
          const readOnly = t.annotations?.readOnlyHint === true;
          const idempotent = readOnly || t.annotations?.idempotentHint === true;
          this.policies.set(fqName, {
            sideEffect: readOnly ? "external-read" : "external-unknown",
            requiresApproval: true,
            parallelSafe: readOnly,
            idempotent,
            timeoutMs: 60_000,
            maxRetries: idempotent ? 2 : 0,
          });
          this.tools.push({
            type: "function",
            function: {
              name: fqName,
              description: `[MCP:${name}] ${t.description || t.name}`,
              parameters: t.inputSchema || { type: "object", properties: {} },
            },
          });
        }
        this.status.push({ name, ok: true, toolCount: tools.length, tools: tools.map((t) => t.name) });
      } catch (e) {
        this.status.push({ name, ok: false, error: e.message });
      }
    }
    return this.tools;
  }

  isMcpTool(name) {
    return this.routes.has(name);
  }

  // 路由一次 MCP 工具调用，返回字符串结果
  async callTool(name, args, context = {}) {
    const route = this.routes.get(name);
    if (!route) throw new Error(`未知的 MCP 工具：${name}`);
    const client = this.clients.get(route.server);
    const policy = this.policies.get(name) || {};
    const res = await client.callTool(
      { name: route.originalName, arguments: args || {} },
      undefined,
      { signal: context.signal, timeout: policy.timeoutMs || 60_000 }
    );
    // 把返回的 content 块拼成文本
    const text = (res.content || [])
      .map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
      .join("\n");
    if (res.isError) throw new Error(text || "MCP 工具返回错误");
    return text || "(无输出)";
  }

  async closeAll() {
    for (const client of this.clients.values()) {
      try {
        await client.close();
      } catch {
        /* 忽略关闭错误 */
      }
    }
  }
}
