import type { CodeAction, CodeActionParams } from "vscode-languageserver";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { LayerInfo } from "@nekosu/maa-pipeline-manager";

import type { MaaProject } from "./project.ts";

export type ProviderContext = {
  params: CodeActionParams;
  project: MaaProject;
  document: TextDocument;
  layer: LayerInfo;
  normalizedFile: string;
  isDefault: boolean;
  begin: number;
  end: number;
};

export type CodeActionProvider = (ctx: ProviderContext) => CodeAction[];
