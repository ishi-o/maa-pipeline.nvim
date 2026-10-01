import {
  createConnection,
  DiagnosticSeverity,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node";
import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { TextDocument } from "vscode-languageserver-textdocument";
import { parse, printParseErrorCode } from "jsonc-parser";
import { setLocale } from "@nekosu/maa-locale";
import { buildDiagnosticMessage, performDiagnostic } from "@nekosu/maa-pipeline-manager";

import {
  completion,
  definition,
  documentColors,
  documentLinks,
  hover,
  references,
  resolveCompletion,
  symbols,
  syntaxDiagnostics,
} from "./features.ts";
import {
  codeActions,
  codeLenses,
  commands,
  configWorkspaceEdit,
  evaluatedTask,
  inlayHints,
  localeWorkspaceEdit,
  notifications,
} from "./interactive.ts";
import { ProjectManager } from "./project.ts";
import { findImageCropper, runImageCropper } from "./image.ts";
import { RuntimeClient, RuntimeSetupError } from "./client.ts";
import { commandRoot, fileUriPath, moveFile, pathUri, sourceDocument } from "./utils.ts";

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);
let projects;
let runtime;
const pendingScreenshots = new Map();

function isControllerSetupFailure(error) {
  return error instanceof RuntimeSetupError && error.code === "maa.debug.init-controller-failed";
}

function requestControllerSelection(project, task?: string) {
  runtime.notify("warn", "The selected controller is no longer available; select it again", task);
  connection.sendNotification(notifications.configureController, {
    root: project.root,
    controller: project.controller,
    task,
  });
}

function report(error) {
  connection.console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

async function forDocument(document) {
  const file = fileUriPath(document.uri);
  if (!file || !projects) return null;
  const project = await projects.ensure(file);
  if (project) await project.refresh();
  return project;
}

async function publish(project) {
  try {
    await project.refresh();
    const byUri = new Map();
    for (const diagnostic of performDiagnostic(project.bundle, {})) {
      const message = await buildDiagnosticMessage(
        project.root,
        diagnostic,
        async (file, offset) => {
          const document = await sourceDocument(project, file);
          const position = document.positionAt(offset);
          return [position.line, position.character];
        },
        {},
      );
      const uri = pathUri(diagnostic.file);
      const list = byUri.get(uri) ?? [];
      list.push({
        range: {
          start: { line: message[0][0], character: message[0][1] },
          end: { line: message[1][0], character: message[1][1] },
        },
        severity:
          diagnostic.level === "warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
        source: "maa-pipeline",
        code: diagnostic.type,
        message: message[2],
      });
      byUri.set(uri, list);
    }
    for (const document of documents.all()) {
      const file = fileUriPath(document.uri);
      if (!file || !project.isInside(file)) continue;
      const diagnostics = syntaxDiagnostics(document, parse, printParseErrorCode);
      if (diagnostics.length)
        byUri.set(document.uri, [...(byUri.get(document.uri) ?? []), ...diagnostics]);
    }
    for (const uri of project.lastPublishedUris) {
      if (!byUri.has(uri)) connection.sendDiagnostics({ uri, diagnostics: [] });
    }
    for (const [uri, diagnostics] of byUri) connection.sendDiagnostics({ uri, diagnostics });
    project.lastPublishedUris = new Set(byUri.keys());
  } catch (error) {
    report(error);
  }
}

function activeResourceRoot(project) {
  const relative = project.bundle.paths.at(-1) ?? ".";
  return path.resolve(project.root, relative.replaceAll("{PROJECT_DIR}", "."));
}

async function saveScreenshot(project, token, name) {
  const screenshot = pendingScreenshots.get(token);
  pendingScreenshots.delete(token);
  if (!screenshot) throw new Error("Screenshot request was not found or has expired");
  if (
    !name ||
    path.basename(name) !== name ||
    name === "." ||
    name === ".." ||
    name.includes("\0")
  ) {
    throw new Error("Screenshot name must be a file name");
  }

  const directory = path.join(activeResourceRoot(project), "debug", "screenshot");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${name}.png`);
  await moveFile(screenshot.file, file);
  return { path: file, roi: screenshot.roi };
}

connection.onInitialize((params) => {
  const options = params.initializationOptions ?? {};
  const roots = (params.workspaceFolders ?? [])
    .map((item) => fileUriPath(item.uri))
    .filter(Boolean);
  if (!roots.length && params.rootUri) {
    const root = fileUriPath(params.rootUri);
    if (root) roots.push(root);
  }
  setLocale(options.locale === "zh" ? "zh" : "en");
  projects = new ProjectManager({
    roots,
    mode: options.mode ?? "auto",
    onChanged: publish,
  });
  runtime = new RuntimeClient(connection, {
    ...options.runtime,
    locale: options.locale,
  });
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        triggerCharacters: ['"', "[", "]", "$", "@", "#", "+", "^", "("],
        resolveProvider: true,
      },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      codeLensProvider: { resolveProvider: false },
      inlayHintProvider: true,
      codeActionProvider: true,
      documentLinkProvider: { resolveProvider: false },
      workspaceSymbolProvider: true,
      colorProvider: true,
      executeCommandProvider: { commands: Object.values(commands) },
    },
    serverInfo: { name: "maa-pipeline-lsp", version: "0.1.0" },
  };
});

documents.onDidOpen(async (event) => {
  try {
    const file = fileUriPath(event.document.uri);
    const project = file && (await projects?.ensure(file));
    if (!project) return;
    project.setDocument(file, event.document.getText(), event.document.version);
    await publish(project);
  } catch (error) {
    report(error);
  }
});

documents.onDidChangeContent((event) => {
  void (async () => {
    const file = fileUriPath(event.document.uri);
    const project = file && (await projects?.ensure(file));
    if (!project) return;
    project.setDocument(file, event.document.getText(), event.document.version);
    await publish(project);
  })().catch(report);
});

documents.onDidClose((event) => {
  void (async () => {
    const file = fileUriPath(event.document.uri);
    const project = file && projects?.loaded(file);
    if (!project) return;
    project.setDocument(file, undefined, event.document.version);
    await publish(project);
  })().catch(report);
});

connection.onCompletion(async (params) => {
  const document = documents.get(params.textDocument.uri);
  const project = document && (await forDocument(document));
  return project ? completion(project, document, params.position) : null;
});
connection.onCompletionResolve(async (item) => {
  const project = item.data?.root && projects?.byRoot(item.data.root);
  if (!project) return item;
  await project.refresh();
  return resolveCompletion(project, item);
});
connection.onHover(async (params) => {
  const document = documents.get(params.textDocument.uri);
  const project = document && (await forDocument(document));
  return project ? hover(project, document, params.position) : null;
});
connection.onDefinition(async (params) => {
  const document = documents.get(params.textDocument.uri);
  const project = document && (await forDocument(document));
  return project ? definition(project, document, params.position) : null;
});
connection.onReferences(async (params) => {
  const document = documents.get(params.textDocument.uri);
  const project = document && (await forDocument(document));
  return project ? references(project, document, params.position) : [];
});
connection.onCodeLens(async (params) => {
  const document = documents.get(params.textDocument.uri);
  const project = document && (await forDocument(document));
  return project ? codeLenses(project, document) : [];
});
connection.languages.inlayHint.on(async (params) => {
  const document = documents.get(params.textDocument.uri);
  const project = document && (await forDocument(document));
  return project ? inlayHints(project, document, params.range) : [];
});
connection.onCodeAction(async (params) => {
  const document = documents.get(params.textDocument.uri);
  const project = document && (await forDocument(document));
  return project ? codeActions(project, document, params) : [];
});
connection.onDocumentLinks(async (params) => {
  const document = documents.get(params.textDocument.uri);
  const project = document && (await forDocument(document));
  return project ? documentLinks(project, document) : [];
});
connection.onWorkspaceSymbol(async (params) => {
  if (!projects) return [];
  return Promise.all([...projects.projects.values()].map((project) => project.refresh()))
    .then(() =>
      Promise.all([...projects.projects.values()].map((project) => symbols(project, params.query))),
    )
    .then((results) => results.flat());
});
connection.onDocumentColor(async (params) => {
  const document = documents.get(params.textDocument.uri);
  const project = document && (await forDocument(document));
  return project ? documentColors(project, document) : [];
});
connection.onColorPresentation(() => []);

const globalCommandHandlers: Record<string, (args: any[]) => unknown> = {
  [commands.noop]: () => null,
  [commands.triggerCompletion]: () => {
    connection.sendNotification(notifications.triggerCompletion);
    return null;
  },
  [commands.stopTask]: async () => {
    await runtime.stop();
    return null;
  },
};

const projectCommandHandlers = {
  [commands.listControllers]: async ({ project }) => {
    const controllers = (project.bundle.content.object.controller ?? []).map((controller) => ({
      name: controller.name,
      type: controller.type,
      current: controller.name === project.config.controller,
    }));
    controllers.push({
      name: "$fixed",
      type: "Fixed Image",
      current: project.config.controller === "$fixed",
    });
    return controllers;
  },
  [commands.discoverController]: ({ project, args }) =>
    runtime.discoverController(project, args[1]),
  [commands.screenShot]: async ({ project }) => {
    let screenshot;
    try {
      screenshot = await runtime.screenshot(project);
    } catch (error) {
      if (isControllerSetupFailure(error)) {
        requestControllerSelection(project as any);
        return null;
      }
      throw error;
    }

    const cropped = await runImageCropper(await findImageCropper(project.root), screenshot.image);
    const token = randomUUID();
    if (cropped.file) pendingScreenshots.set(token, cropped);
    connection.sendNotification(notifications.saveScreenshot, {
      root: project.root,
      token,
      roi: cropped.roi,
      image: Boolean(cropped.file),
    });
    return true;
  },
  [commands.saveScreenshot]: ({ project, args }) => saveScreenshot(project, args[1], args[2]),
  [commands.cancelScreenshot]: async ({ args }) => {
    const screenshot = pendingScreenshots.get(args[1]);
    pendingScreenshots.delete(args[1]);
    if (screenshot?.file) await unlink(screenshot.file).catch(() => {});
    return true;
  },
  [commands.configureController]: async ({ project, args }) => {
    const controller = args[1];
    const resources = project.bundle.content.object.resource ?? [];
    const compatible = (resource) =>
      controller === "$fixed" || !resource.controller || resource.controller.includes(controller);
    const resource =
      resources.find((item) => item.name === project.resource && compatible(item)) ??
      resources.find(compatible);
    if (!resource) throw new Error(`No resource supports controller ${controller}`);
    const values = { controller, resource: resource.name, ...(args[2] ?? {}) };
    const edit = await configWorkspaceEdit(project, values);
    const result = await connection.workspace.applyEdit(edit as any);
    if (!result.applied) return false;
    Object.assign(project.config, values);
    project.controller = controller;
    project.resource = resource.name;
    await project.bundle.switchActive(project.controller, project.resource);
    await publish(project);
    return true;
  },
  [commands.selectController]: ({ project, args }) => {
    connection.sendNotification(notifications.configureController, {
      root: project.root,
      controller: args[1],
    });
    return null;
  },
  [commands.showReferences]: async ({ project, args }) => {
    const [, uri, position] = args;
    const file = fileUriPath(uri);
    if (!file || !position) return null;
    const document = documents.get(uri) ?? (await sourceDocument(project, file));
    const locations = await references(project, document, position);
    connection.sendNotification(notifications.showReferences, {
      uri,
      position,
      locations,
    });
    return null;
  },
  [commands.evaluateTask]: ({ project, args }) => {
    const value = evaluatedTask(project, args[1]);
    if (value)
      connection.sendNotification(notifications.showText, {
        title: args[1],
        content: value,
      });
    return null;
  },
  [commands.runTask]: ({ project, args }) => {
    if (!runtime.controllerReady(project)) {
      connection.sendNotification(notifications.configureController, {
        root: project.root,
        task: args[1],
      });
      return null;
    }
    void runtime.run(project, args[1]).catch((error) => {
      if (isControllerSetupFailure(error)) {
        requestControllerSelection(project, args[1]);
        return;
      }
      runtime.notify("error", error instanceof Error ? error.message : String(error), args[1]);
    });
    return null;
  },
  [commands.switchConfig]: async ({ project, args }) => {
    const [, key, value] = args;
    const edit = await configWorkspaceEdit(project, key, value);
    const result = await connection.workspace.applyEdit(edit as any);
    if (result.applied) {
      project.config[key] = value;
      if (key === "resource") project.resource = value;
      if (key === "__locale") project.locale = value;
      await project.bundle.switchActive(project.controller, project.resource);
      await publish(project);
    }
    return null;
  },
  [commands.extractLocale]: async ({ project, args, command }) => {
    const [request, key] = args;
    if (!key) {
      connection.sendNotification(notifications.requestInput, {
        title: "Localization key",
        command,
        arguments: [request],
      });
      return null;
    }
    const edit = await localeWorkspaceEdit(project, request, key);
    if (edit) await connection.workspace.applyEdit(edit as any);
    return null;
  },
};

connection.onExecuteCommand(async (params) => {
  const args = (params.arguments as any[]) ?? [];
  const globalHandler = globalCommandHandlers[params.command];
  if (globalHandler) return globalHandler(args);

  const root = commandRoot(args);
  const project = root && projects?.byRoot(root);
  if (!project) return null;
  await project.refresh();
  const handler = projectCommandHandlers[params.command];
  return handler ? handler({ project, args, command: params.command } as any) : null;
});
connection.onShutdown(async () => {
  await runtime?.shutdown();
  await projects?.stop();
});

documents.listen(connection);
connection.listen();
