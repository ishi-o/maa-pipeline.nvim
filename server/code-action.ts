import type { TaskRefInfo, TaskCanLocaleRefInfo } from "@nekosu/maa-pipeline-manager";
import { type CodeAction, type CodeActionParams, CodeActionKind } from "vscode-languageserver";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { t } from "@nekosu/maa-locale";

import type { MaaProject } from "./project.ts";
import { commands } from "./commands.ts";
import { fileUriPath } from "./project.ts";
import type { CodeActionProvider, ProviderContext } from "./types.ts";

export function screenShotProvider(ctx: ProviderContext) {
  const title = "ScreenShot";
  return [
    {
      title,
      command: {
        title,
        command: commands.screenShot,
        arguments: [ctx.project.root],
      },
    },
  ];
}

export function selectControllerProvider(ctx: ProviderContext) {
  const result: CodeAction[] = [];
  for (const decl of ctx.project.bundle.info.decls) {
    if (decl.file !== ctx.normalizedFile || decl.type !== "interface.controller") continue;
    if (decl.location.offset > ctx.end || decl.location.offset + decl.location.length < ctx.begin)
      continue;
    const title = `Select Maa controller: ${decl.name}`;
    result.push({
      title,
      command: {
        title,
        command: commands.selectController,
        arguments: [ctx.project.root, decl.name],
      },
    });
  }
  return result;
}

export function runTaskProvider(ctx: ProviderContext) {
  if (ctx.project.bundle.maa || ctx.isDefault) return [];
  const result: CodeAction[] = [];
  for (const [task, infos] of Object.entries(ctx.layer.tasks)) {
    const info = infos.find(
      (item) =>
        item.file === ctx.normalizedFile &&
        item.prop.offset <= ctx.end &&
        item.prop.offset + item.prop.length >= ctx.begin,
    );
    if (!info) continue;
    const title = `Run Maa task: ${task}`;
    result.push({
      title,
      command: {
        title,
        command: commands.runTask,
        arguments: [ctx.project.root, task],
      },
    });
  }
  return result;
}

export function extractLocaleProvider(ctx: ProviderContext) {
  const ref = ctx.layer.mergedRefs.find(
    (info): info is TaskRefInfo & TaskCanLocaleRefInfo =>
      info.file === ctx.normalizedFile &&
      info.type === "task.can_locale" &&
      info.location.offset <= ctx.end &&
      info.location.offset + info.location.length >= ctx.begin,
  );
  if (!ref) return [];
  const title = t("maa.pipeline.codeaction.extract-locale");
  return [
    {
      title,
      kind: CodeActionKind.RefactorExtract,
      command: {
        title,
        command: commands.extractLocale,
        arguments: [
          {
            root: ctx.project.root,
            uri: ctx.document.uri,
            offset: ref.location.offset,
            length: ref.location.length,
            value: ref.target,
          },
        ],
      },
    },
  ];
}

export const providers: CodeActionProvider[] = [
  screenShotProvider,
  selectControllerProvider,
  runTaskProvider,
  extractLocaleProvider,
];

export function codeActions(
  project: MaaProject,
  document: TextDocument,
  params: CodeActionParams,
): CodeAction[] {
  const file = fileUriPath(document.uri);
  if (!file) return [];
  const located = project.bundle.locateLayer(file);
  if (!located) return [];
  const [layer, normalizedFile, isDefault] = located;

  const ctx: ProviderContext = {
    params,
    project,
    document,
    layer,
    normalizedFile,
    isDefault,
    begin: document.offsetAt(params.range.start),
    end: document.offsetAt(params.range.end),
  };

  return providers.flatMap((provider) => provider(ctx));
}
