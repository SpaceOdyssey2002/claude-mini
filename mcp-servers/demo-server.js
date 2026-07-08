// demo-server.js —— 一个最小的本地 MCP 服务器（用于离线演示 MCP 接入）。
// 它通过 stdio 和客户端通信，对外暴露两个工具：get_current_time 和 add。
//
// 真实世界里，MCP 服务器可以是别人写好的（文件系统、数据库、GitHub、Slack…），
// minicode 只要在 mcp.json 里配置它，就能让模型用上这些工具。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "demo-server", version: "1.0.0" });

// 工具一：返回当前时间（无参数）
server.registerTool(
  "get_current_time",
  {
    title: "获取当前时间",
    description: "返回服务器当前的日期和时间。",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: new Date().toLocaleString("zh-CN") }],
  })
);

// 工具二：把两个数字相加（演示带参数的工具）
server.registerTool(
  "add",
  {
    title: "加法",
    description: "计算两个数字之和。",
    inputSchema: { a: z.number().describe("第一个数"), b: z.number().describe("第二个数") },
  },
  async ({ a, b }) => ({
    content: [{ type: "text", text: `${a} + ${b} = ${a + b}` }],
  })
);

// 通过 stdio 启动（父进程会用管道和我们通信）
const transport = new StdioServerTransport();
await server.connect(transport);
