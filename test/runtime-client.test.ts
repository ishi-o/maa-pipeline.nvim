import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const root = process.cwd();

async function loadRuntimeClient(t: any) {
  const output = path.join(root, "server", "dist", "runtime-client.test.mjs");
  t.after(async () => rm(output, { force: true }));
  await esbuild.build({
    entryPoints: [
      {
        in: path.join(root, "server", "runtime-client.ts"),
        out: "runtime-client.test",
      },
    ],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    mainFields: ["module", "main"],
    external: ["pacote", "tar"],
    banner: {
      js: `
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const maa = new Proxy({}, {
  get(_, prop) { return globalThis.maa?.[prop]; },
  set(_, prop, value) { globalThis.maa[prop] = value; return true; },
  has(_, prop) { return prop in (globalThis.maa || {}); },
});
`,
    },
  });
  return (await import(pathToFileURL(output).href)).RuntimeClient;
}

function testProject() {
  return {
    root: "/maa/project",
    config: {
      controller: "controller",
      resource: "resource",
      playcover: { address: "127.0.0.1:1" },
    },
    bundle: {
      content: {
        object: {
          agent: [{ child_exec: "agent" }],
          controller: [
            {
              name: "controller",
              type: "PlayCover",
              playcover: { address: "127.0.0.1:1" },
            },
          ],
          resource: [{ name: "resource", path: ["."] }],
        },
      },
    },
  };
}

test("does not retry setup after an external agent fails", async (t) => {
  const RuntimeClient = await loadRuntimeClient(t);
  const logs = [];
  const calls = [];
  const client = new RuntimeClient({
    sendNotification: (_method: string, params: any) => logs.push(params),
  } as any);
  (client as any).request = async (method, ..._args) => {
    calls.push(method);
    if (method === "setupInstance") return { error: "maa.debug.init-resource-failed" };
    return undefined;
  };
  client.failedAgents.add("agent");

  const setup = await client.setup(testProject());

  assert.equal(setup.handle, undefined);
  assert.deepEqual(calls, ["fetchConstants", "setupInstance"]);
  assert.ok(logs.some((log) => log.level === "error" && log.message.includes("agent")));
  assert.equal(client.failedAgents.size, 0);
});

test("logs failed external agents and reports them stopped to the runtime", async (t) => {
  const RuntimeClient = await loadRuntimeClient(t);
  const logs = [];
  const requests = [];
  const client = new RuntimeClient({
    sendNotification: (_method: string, params: any) => logs.push(params),
  } as any);
  (client as any).rpc = { sendRequest: async (...args) => requests.push(args) };
  client.agentOptions.set(process.execPath, false);

  await client.startAgent(process.execPath, ["-e", ""]);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.ok(
    logs.some((log) => log.level === "error" && /failed: exited with code 0/.test(log.message)),
  );
  assert.equal(requests.at(-1)?.[1], "agentStopped");
});

test("allows daemon agent launchers to exit without treating them as failures", async (t) => {
  const RuntimeClient = await loadRuntimeClient(t);
  const logs = [];
  const requests = [];
  const client = new RuntimeClient(
    {
      sendNotification: (_method: string, params: any) => logs.push(params),
    } as any,
    { daemon: true },
  );
  (client as any).rpc = { sendRequest: async (...args) => requests.push(args) };
  client.agentOptions.set(process.execPath, true);

  await client.startAgent(process.execPath, ["-e", ""]);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.ok(
    logs.some((log) => log.level === "info" && log.message.includes("daemon agent launcher")),
  );
  assert.equal(client.failedAgents.size, 0);
  assert.equal(requests.length, 0);
});

test("reuses a daemon instance while the controller type is unchanged", async (t) => {
  const RuntimeClient = await loadRuntimeClient(t);
  const calls = [];
  const client = new RuntimeClient({ sendNotification: () => {} } as any, { daemon: true });
  (client as any).request = async (method, ...args) => {
    calls.push(method);
    if (method === "setupInstance") return { handle: "handle" };
    return undefined;
  };

  const first = await client.setup(testProject());
  const second = await client.setup(testProject());

  assert.equal(first.handle, "handle");
  assert.equal(second.handle, "handle");
  assert.deepEqual(calls, ["fetchConstants", "setupInstance"]);
});
