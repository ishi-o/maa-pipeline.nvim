import type { CodeAction, CodeActionParams } from "vscode-languageserver";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { LayerInfo } from "@nekosu/maa-pipeline-manager";
import type { ChildProcess } from "node:child_process";

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

export type RuntimeLogLevel = "info" | "warn" | "error";

export interface RuntimeOptions {
  data_dir?: string;
  version?: string;
  timeout?: number;
  debug_mode?: boolean;
  save_draw?: boolean;
  save_on_error?: boolean;
  locale?: string;
  daemon?: boolean;
}

export interface RuntimeProject {
  root: string;
  config: Record<string, any>;
  bundle: {
    content: {
      object: Record<string, any>;
    };
  };
}

export interface RuntimeConnection {
  sendNotification(method: string, params?: unknown): void;
  window: {
    showInformationMessage(
      message: string,
      ...actions: { title: string }[]
    ): Promise<{ title: string } | undefined>;
  };
}

export interface AgentProcess {
  name: string;
  child: ChildProcess;
  daemon: boolean;
}

export interface ActiveTask {
  handle: string;
  task: string;
}

export interface RuntimeSetupResult {
  handle?: string;
  error?: string;
}

export interface AgentConfig {
  child_exec?: string;
  child_args?: string[];
  identifier?: string;
}

export interface RuntimeAgent extends Required<Pick<AgentConfig, "child_exec">> {
  child_args?: string[];
  identifier?: string;
}

export interface AgentProject {
  root: string;
  bundle: {
    content: {
      object: {
        agent?: AgentConfig | AgentConfig[];
      };
    };
  };
}

export interface ResolvedAgent {
  executable: string;
  cwd: string;
}

export interface CroppedScreenshot {
  file?: string;
  roi?: string;
}

export type { MaaProject, OverlayLoader, ProjectManager } from "./project.ts";
export type { RuntimeClient, RuntimeSetupError } from "./runtime-client.ts";
