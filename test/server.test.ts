import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  completion,
  definition,
  nodeRange,
  syntaxDiagnostics,
  textDocument,
} from "#server/features.ts";
import { parse, printParseErrorCode } from "jsonc-parser";
import { codeActions, codeLenses, configWorkspaceEdit } from "#server/interactive.ts";
import { resolveAgent, runtimeAgents } from "#server/agent.ts";
import { parseImageCropperOutput } from "#server/image-cropper.ts";
import { MaaProject, normalizePath, pathUri } from "#server/project.ts";

test("converts upstream parser offsets to LSP ranges", () => {
  const document = textDocument("/tmp/pipeline.jsonc", '{\n  "Task": {}\n}\n');
  assert.deepEqual(nodeRange(document, { offset: 4, length: 6 }), {
    start: { line: 1, character: 2 },
    end: { line: 1, character: 8 },
  });
});

test("normalizes project paths and emits file URIs", () => {
  const raw = path.join(os.tmpdir(), "maa", "..", "maa", "project.json");
  const file = normalizePath(raw);
  assert.equal(file, path.normalize(path.resolve(raw)));
  assert.equal(pathUri(file), pathToFileURL(file).toString());
});

test("resolves agents from ancestor install directories", {}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maa-agent-test-"));
  const project = path.join(root, "assets");
  const executable = path.join(
    root,
    "install",
    "agent",
    `go-service${process.platform === "win32" ? ".exe" : ""}`,
  );
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(executable, "");
  t.after(async () => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await resolveAgent("agent/go-service", project), {
    executable,
    cwd: path.join(root, "install"),
  });
});

test("parses ImageCropper output", () => {
  assert.deepEqual(
    parseImageCropperOutput(
      "dst: D:\\tools\\ImageCropper\\dst\\screenshot_1_2_3_4__0_0_10_10.png\n" +
        "original roi: [1, 2, 3, 4]\n" +
        "amplified roi: [0, 0, 10, 10]\n",
    ),
    {
      file: "D:\\tools\\ImageCropper\\dst\\screenshot_1_2_3_4__0_0_10_10.png",
      roi: "[1, 2, 3, 4]",
    },
  );
});

test("treats every supported file extension as JSONC", () => {
  const document = textDocument("/tmp/pipeline.json", '{\n  // comment\n  "Task": {},\n}\n');
  assert.equal(document.languageId, "jsonc");
  assert.deepEqual(syntaxDiagnostics(document, parse, printParseErrorCode), []);
});

test("uses the upstream manager for MaaFramework language features", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maa-pipeline-test-"));
  const pipelineDir = path.join(root, "resource", "pipeline");
  await mkdir(pipelineDir, { recursive: true });
  await writeFile(
    path.join(root, "interface.json"),
    JSON.stringify({
      controller: [{ name: "Default", attach_resource_path: ["resource"] }],
      resource: [{ name: "Default", path: ["resource"] }],
      task: [{ name: "Run", entry: "Start" }],
    }),
  );
  const file = path.join(pipelineDir, "main.json");
  const source = '{\n  "Start": { "next": ["End"] },\n  "End": {}\n}\n';
  await writeFile(file, source);

  const project = new MaaProject({
    root,
    interfaceFile: path.join(root, "interface.json"),
    mode: "framework",
  });
  t.after(async () => {
    await project.stop();
    await rm(root, { recursive: true, force: true });
  });
  await project.init();

  const document = textDocument(file, source);
  const offset = source.indexOf('"End"') + 2;
  const position = document.positionAt(offset);
  assert.deepEqual(project.bundle.topLayer.getTaskList(), ["Start", "End"]);
  assert.ok(completion(project, document, position).some((item) => item.label === "End"));
  assert.equal((await definition(project, document, position)).length, 1);
  assert.deepEqual(
    codeLenses(project, document).map((item) => item.command.command),
    ["maa-pipeline.showReferences", "maa-pipeline.showReferences"],
  );
  const actionPosition = document.positionAt(source.indexOf('"Start"') + 2);
  assert.equal(
    codeActions(project, document, {
      start: actionPosition,
      end: actionPosition,
    })[0].command.command,
    "maa-pipeline.runTask",
  );

  const interfaceFile = path.join(root, "interface.json");
  const interfaceSource = await readFile(interfaceFile, "utf8");
  const interfaceDocument = textDocument(interfaceFile, interfaceSource);
  const controllerPosition = interfaceDocument.positionAt(interfaceSource.indexOf("Default") + 2);
  assert.ok(
    codeActions(project, interfaceDocument, {
      start: controllerPosition,
      end: controllerPosition,
    }).some((action) => action.command.command === "maa-pipeline.selectController"),
  );

  const createConfig = await configWorkspaceEdit(project, {
    controller: "Default",
    resource: "Default",
  });
  assert.equal(createConfig.documentChanges[0].kind, "create");
  assert.deepEqual(createConfig.documentChanges[1].edits[0].range, {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  });
});

function testRuntimeProject(agents) {
  return {
    root: "/maa/project",
    config: { controller: "controller", resource: "resource" },
    bundle: {
      content: {
        object: {
          agent: agents,
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
