import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { connect, permissionResponseParams } from "../src/clients/client.js";
import { AgentRunner } from "../src/core/runner.js";
import { Session } from "../src/core/memory.js";
import { frame, createLineParser, rpc, dispatchRpc } from "../src/core/rpc.js";
import { setWorkspace } from "../src/tools.js";

function stream(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function fakeClient() {
  let calls = 0;
  return {
    chat: {
      completions: {
        async create() {
          calls++;
          if (calls === 1) {
            return stream([
              {
                choices: [{
                  delta: {
                    tool_calls: [{
                      index: 0,
                      id: "call-write",
                      function: {
                        name: "write_file",
                        arguments: JSON.stringify({ path: "approved.txt", content: "ok" }),
                      },
                    }],
                  },
                }],
              },
              { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } },
            ]);
          }
          return stream([
            { choices: [{ delta: { content: "done" } }] },
            { choices: [], usage: { prompt_tokens: 20, completion_tokens: 2 } },
          ]);
        },
      },
    },
  };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("IPC permission approval uses event sessionId and resumes the run", async () => {
  const oldCwd = process.cwd();
  const oldWorkspace = oldCwd;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-ipc-"));
  await fs.writeFile(path.join(temp, "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf8");
  process.chdir(temp);
  setWorkspace(temp);

  const runners = new Map();
  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    const send = (obj) => sock.write(frame(obj));
    const methods = {
      async run({ sessionId, goal, autoApprove }) {
        const id = sessionId || `test-ipc-${Date.now()}`;
        let runner = runners.get(id);
        if (!runner) {
          runner = await new AgentRunner({
            client: fakeClient(),
            model: "fake-model",
            session: new Session(id),
            autoApprove: !!autoApprove,
          }).init();
          runners.set(runner.session.id, runner);
        }
        const unsub = runner.bus.subscribe((ev) => send(rpc.notify("event", { sessionId: runner.session.id, ...ev })));
        try {
          const res = await runner.run(goal);
          return { sessionId: runner.session.id, ...res };
        } finally {
          unsub();
        }
      },
      "permission.respond": ({ sessionId, id, decision }) => {
        const runner = runners.get(sessionId);
        return runner ? runner.respondPermission(id, decision) : false;
      },
    };
    const parse = createLineParser((msg) => dispatchRpc(msg, methods, send));
    sock.on("data", parse);
  });

  await new Promise((resolve) => server.listen({ port: 0, host: "127.0.0.1" }, () => resolve()));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  const port = address.port;
  const conn = connect(port);
  await conn.ready();

  let sessionId = null;
  const events = [];
  let sawPermissionResolve;
  let sawPermissionReject;
  const sawPermission = new Promise((resolve, reject) => {
    sawPermissionResolve = resolve;
    sawPermissionReject = reject;
  });

  conn.onEvent((ev) => {
    events.push(ev);
    if (ev.type !== "permission_request") return;
    const params = permissionResponseParams(sessionId, ev, "y");
    conn.call("permission.respond", params)
      .then((ok) => {
        assert.equal(ok, true);
        sawPermissionResolve(params);
      })
      .catch(sawPermissionReject);
  });

  try {
    const runPromise = conn.call("run", { sessionId, goal: "write a file", autoApprove: false });
    const res = await withTimeout(runPromise, 3000, "run");
    sessionId = res.sessionId;
    const approvalParams = await withTimeout(sawPermission, 3000, "permission approval");

    assert.equal(res.ok, true);
    assert.equal(approvalParams.sessionId, res.sessionId);
    assert.equal(await fs.readFile(path.join(temp, "approved.txt"), "utf8"), "ok");
    assert.ok(events.some((ev) => ev.type === "permission_request"));
    assert.ok(events.some((ev) => ev.type === "permission_response" && ev.decision === "y"));
  } finally {
    conn.close();
    for (const runner of runners.values()) {
      await runner.close();
      for (const suffix of [".json", ".events.jsonl", ".trace.jsonl"]) {
        await fs.rm(path.join(Session.dir(), runner.session.id + suffix), { force: true });
      }
    }
    await closeServer(server);
    process.chdir(oldCwd);
    setWorkspace(oldWorkspace);
    await fs.rm(temp, { recursive: true, force: true });
  }
});
