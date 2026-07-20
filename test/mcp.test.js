import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";

import { McpManager } from "../src/mcp.js";

async function withConfig(config, run) {
  const previous = process.cwd();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mcp-"));
  try {
    await fs.writeFile(path.join(temp, "mcp.json"), JSON.stringify(config), "utf8");
    process.chdir(temp);
    await run();
  } finally {
    process.chdir(previous);
    await fs.rm(temp, { recursive: true, force: true });
  }
}

test("stdio MCP 保留 structuredContent，并暴露 Resources 发现/读取工具", async () => {
  const demo = path.resolve("mcp-servers/demo-server.js");
  await withConfig({
    mcpServers: { demo: { command: process.execPath, args: [demo] } },
  }, async () => {
    const manager = new McpManager();
    try {
      await manager.init();
      assert.ok(manager.tools.some((tool) => tool.function.name === "list_mcp_resources"));
      assert.ok(manager.tools.some((tool) => tool.function.name === "read_mcp_resource"));

      const sum = await manager.callTool("mcp__demo__add", { a: 2, b: 5 });
      assert.deepEqual(sum.structuredContent, { a: 2, b: 5, sum: 7 });
      assert.equal(manager.policies.get("mcp__demo__add").requiresApproval, false);

      const listed = await manager.listResources("demo");
      assert.equal(listed.resources[0].uri, "demo://minicode/mcp-guide");
      const read = await manager.readResource("demo", "demo://minicode/mcp-guide");
      assert.match(read.contents[0].text, /Resources 发现/);
    } finally {
      await manager.closeAll();
    }
  });
});

function makeHttpMcpServer() {
  const server = new McpServer({ name: "http-fixture", version: "1.0.0" });
  server.registerTool("echo", {
    description: "结构化回显",
    inputSchema: { text: z.string() },
    outputSchema: { echoed: z.string() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ text }) => ({
    content: [{ type: "text", text }],
    structuredContent: { echoed: text },
  }));
  return server;
}

test("Streamable HTTP MCP 支持 header 环境变量和工具发现", async () => {
  const app = createMcpExpressApp();
  let seenAuthorization = "";
  app.post("/mcp", async (req, res) => {
    seenAuthorization = req.headers.authorization || "";
    const server = makeHttpMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => { transport.close(); server.close(); });
  });
  const httpServer = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = httpServer.address();
  const oldToken = process.env.TEST_MCP_HTTP_TOKEN;
  process.env.TEST_MCP_HTTP_TOKEN = "test-token";
  try {
    await withConfig({
      mcpServers: {
        remote: {
          url: `http://127.0.0.1:${address.port}/mcp`,
          headers: { Authorization: "Bearer ${TEST_MCP_HTTP_TOKEN}" },
        },
      },
    }, async () => {
      const manager = new McpManager();
      try {
        await manager.init();
        assert.equal(manager.status[0].transport, "http");
        assert.ok(manager.tools.some((tool) => tool.function.name === "mcp__remote__echo"));
        const result = await manager.callTool("mcp__remote__echo", { text: "hello" });
        assert.deepEqual(result.structuredContent, { echoed: "hello" });
        assert.equal(seenAuthorization, "Bearer test-token");
      } finally {
        await manager.closeAll();
      }
    });
  } finally {
    if (oldToken === undefined) delete process.env.TEST_MCP_HTTP_TOKEN;
    else process.env.TEST_MCP_HTTP_TOKEN = oldToken;
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("MCP 权限默认放行只读工具、审批未知写工具，并支持显式覆盖", () => {
  const manager = new McpManager();
  manager.registerDiscoveredTool("svc", "svc", {}, {
    name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true },
  });
  manager.registerDiscoveredTool("svc", "svc", {}, {
    name: "write", inputSchema: { type: "object" }, annotations: { readOnlyHint: false, destructiveHint: true },
  });
  manager.registerDiscoveredTool("svc", "svc", { toolApproval: { forced: "never" } }, {
    name: "forced", inputSchema: { type: "object" }, annotations: { readOnlyHint: false },
  });
  assert.equal(manager.policies.get("mcp__svc__read").requiresApproval, false);
  assert.equal(manager.policies.get("mcp__svc__write").requiresApproval, true);
  assert.equal(manager.policies.get("mcp__svc__write").allowSessionApproval, false);
  assert.equal(manager.policies.get("mcp__svc__forced").requiresApproval, false);
});
