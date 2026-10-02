import type { CodeAction, CodeActionParams } from "vscode-languageserver";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { LayerInfo } from "@nekosu/maa-pipeline-manager";
import type { ChildProcess } from "node:child_process";
import type { HostToSubApis } from "@nekosu/maa-server-proto";
import type { LogCategory } from "@nekosu/maa-types";
export type { LogCategory };

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

export type RuntimeLogLevel = Extract<LogCategory, "info" | "warn" | "error">;
export type LogLevel = LogCategory;

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
export type { RuntimeClient, RuntimeSetupError } from "./client.ts";

export type Source = string;
export type LogFamily =
  "Task" | "Node" | "Next" | "Reco" | "Action" | "Loading" | "Freeze" | "Ctrl" | "Plain";
export type LogPhase = "Starting" | "Succeeded" | "Failed";

export interface LogIds {
  taskId?: number;
  nodeId?: number;
  recoId?: number;
  actionId?: number;
  wfId?: number;
}

export type RecognitionDetails = ReturnType<HostToSubApis["getRecoDetail"]>["info"];
export type ActionDetails = ReturnType<HostToSubApis["getActDetail"]>;

export interface RecognitionCandidate {
  algorithm?: string;
  box?: number[];
  score?: number;
  text?: string;
  name?: string;
}

export type NextListEntry = string | ({ name?: string } & Record<string, unknown>);

export interface LogEntry {
  kind: "event" | "plain";
  level: LogLevel;
  source: Source;
  family?: LogFamily;
  phase?: LogPhase;
  msg?: string;
  ids: LogIds;
  name?: string;
  entry?: string;
  action?: string;
  reco?: RecognitionDetails;
  actionDetails?: ActionDetails;
  roi?: number[];
  elapsed?: number;
  list?: NextListEntry[];
  nested?: LogEntry[];
  raw: string;
  details?: unknown;
}

export interface LogRender {
  render(entry: LogEntry): string;
  render_details?(entry: LogEntry): string[];
}

export interface RuntimeLogPayload {
  level: RuntimeLogLevel;
  message: string;
  source?: Source;
  taskId?: number;
  nodeId?: number;
  recoId?: number;
  actionId?: number;
  name?: string;
  details?: unknown;
}
