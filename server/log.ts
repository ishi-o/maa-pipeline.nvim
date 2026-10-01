import type {
  ActionDetails,
  LogCategory,
  LogEntry,
  LogFamily,
  Filter,
  LogPhase,
  NextListEntry,
  RecognitionDetails,
  RuntimeLogPayload,
  Source,
} from "./types.ts";

const LINE_PATTERN = /^\[([^\]]+)\]\s?(.*)$/s;
const LEVELS = new Set<string>(["error", "warn", "info", "http", "verbose", "debug", "silly"]);

const FAMILY_BY_PREFIX: Record<string, LogFamily> = {
  Task: "Task",
  PipelineNode: "Node",
  NextList: "Next",
  Recognition: "Reco",
  Action: "Action",
  Loading: "Loading",
  WaitFreezes: "Freeze",
  Controller: "Ctrl",
};

const PHASES = new Set<LogPhase>(["Starting", "Succeeded", "Failed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function box(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "number")
    ? value
    : undefined;
}

function level(value: string): LogCategory {
  const normalized = value.toLowerCase();
  return LEVELS.has(normalized) ? (normalized as LogCategory) : "info";
}

function familyAndPhase(msg: string): { family?: LogFamily; phase?: LogPhase } {
  const [prefix, phase] = msg.split(".");
  return {
    family: FAMILY_BY_PREFIX[prefix],
    phase: PHASES.has(phase as LogPhase) ? (phase as LogPhase) : undefined,
  };
}

function bestScore(detail: unknown): number | undefined {
  if (!isRecord(detail)) return undefined;
  const best = detail.best;
  if (isRecord(best)) return number(best.score);
  const all = detail.all;
  if (Array.isArray(all) && all.length) {
    return all.reduce((acc, item) => Math.max(acc, number(item?.score) ?? 0), 0);
  }
  return undefined;
}

function bestBox(detail: unknown): number[] | undefined {
  if (!isRecord(detail)) return undefined;
  const best = detail.best;
  if (isRecord(best)) return box(best.box);
  const all = detail.all;
  if (Array.isArray(all) && all.length) return box(all[0]?.box);
  return undefined;
}

function firstText(detail: unknown): string | undefined {
  if (!isRecord(detail)) return undefined;
  const best = detail.best;
  if (isRecord(best)) {
    const value = text(best.text);
    if (value) return value;
  }
  const all = detail.all;
  if (Array.isArray(all)) {
    for (const item of all) {
      const value = text(item?.text);
      if (value) return value;
    }
  }
  return undefined;
}

function recognition(value: unknown): RecognitionDetails | undefined {
  if (!isRecord(value)) return undefined;
  const detail = value.detail;
  return {
    algorithm: text(value.algorithm),
    box: box(value.box) ?? bestBox(detail),
    score: number(value.score) ?? bestScore(detail),
    text: text(value.text) ?? firstText(detail),
    detail,
  } as RecognitionDetails;
}

function action(value: unknown): ActionDetails | undefined {
  if (!isRecord(value)) return undefined;
  return {
    action: text(value.action),
    success: typeof value.success === "boolean" ? value.success : undefined,
    box: box(value.box),
    detail: value.detail,
  } as ActionDetails;
}

function nested(detail: unknown, parent: LogEntry): LogEntry[] | undefined {
  if (!Array.isArray(detail)) return undefined;
  return detail.map((value) => ({
    kind: "event",
    level: parent.level,
    source: parent.source,
    family: "Reco",
    phase: parent.phase,
    msg: parent.msg,
    ids: {},
    name: text(value?.name),
    reco: recognition(value),
    raw: JSON.stringify(value),
    details: value,
  }));
}

function nextList(value: unknown): NextListEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) =>
    typeof item === "string" ? item : isRecord(item) ? item : String(item),
  );
}

function unchangedNextList(body: Record<string, unknown>): boolean {
  const info = body.info;
  if (typeof info === "string" && /unchanged/i.test(info)) return true;
  const list = body.list;
  const entry = body.entry;
  if (!Array.isArray(list) || list.length !== 1) return false;
  const item = list[0];
  if (item === entry) return true;
  return isRecord(item) && text(item.name) === entry;
}

function startupNoise(value: string): boolean {
  return /(?:^|\W)(?:sonic|ast)(?:\W|$)|agent bootstrap/i.test(value);
}

function lowValue(
  body: Record<string, unknown>,
  family: LogFamily | undefined,
  phase: LogPhase | undefined,
  level: LogCategory,
  raw: string,
): boolean {
  // if (family === "Next" && unchangedNextList(body)) return true;
  // if (family === "Action" && phase === "Starting" && body.action === "DoNothing") return true;
  // if ((level === "warn" || level === "error") && startupNoise(raw)) return true;
  return false;
}

export function parseLogLine(line: string, defaultSource?: Source): LogEntry | null {
  if (!line.trim()) return null;
  const match = LINE_PATTERN.exec(line);
  const parsedLevel = level(match?.[1] ?? "info");
  const bodyText = match?.[2] ?? line;
  const parsed = parseJson(bodyText);
  const record = isRecord(parsed) ? parsed : undefined;

  if (!record) {
    if ((parsedLevel === "warn" || parsedLevel === "error") && startupNoise(line)) return null;
    return {
      kind: "plain",
      level: parsedLevel,
      source: defaultSource ?? "unknown",
      ids: {},
      raw: line,
      details: parsed,
    };
  }

  const source: Source = text(record.source) ?? defaultSource ?? "unknown";
  const msg = text(record.msg);
  if (!msg) {
    if ((parsedLevel === "warn" || parsedLevel === "error") && startupNoise(line)) return null;
    return {
      kind: "plain",
      level: parsedLevel,
      source,
      ids: {},
      raw: line,
      details: parsed,
    };
  }

  const { family, phase } = familyAndPhase(msg);
  if (!family) {
    return {
      kind: "plain",
      level: parsedLevel,
      source,
      ids: {},
      raw: `[${parsedLevel}] ${msg}`,
      details: record,
    };
  }
  if (lowValue(record, family, phase, parsedLevel, line)) return null;

  const reco = recognition(record.reco_details);
  const parent: LogEntry = {
    kind: "event",
    level: parsedLevel,
    source,
    family,
    phase,
    msg,
    ids: {},
    raw: line,
  };
  return {
    ...parent,
    ids: {
      taskId: number(record.task_id),
      nodeId: number(record.node_id),
      recoId: number(record.reco_id),
      actionId: number(record.action_id),
      wfId: number(record.wf_id),
    },
    name: text(record.name),
    entry: text(record.entry),
    action: text(record.action),
    reco,
    actionDetails: action(record.action_details),
    roi: box(record.roi),
    elapsed: number(record.elapsed),
    list: nextList(record.list),
    nested: nested(reco?.detail, parent),
    details: record,
  };
}

function matchesList<T extends string>(value: T | undefined, filter: T[] | undefined): boolean {
  if (!filter?.length) return true;
  return value !== undefined && filter.includes(value);
}

export function matches(entry: LogEntry, filter: Filter): boolean {
  if (!matchesList(entry.source, filter.source)) return false;
  if (entry.kind !== "plain" && !matchesList(entry.family, filter.family)) return false;
  if (entry.kind !== "plain" && !matchesList(entry.phase, filter.phase)) return false;
  if (entry.kind !== "plain" && !matchesList(entry.reco?.algorithm, filter.algorithm)) return false;
  if (!matchesList(entry.level, filter.level)) return false;
  if (filter.taskId !== undefined && entry.ids.taskId !== filter.taskId) return false;
  if (filter.name && !entry.name?.toLowerCase().includes(filter.name.toLowerCase())) return false;
  if (filter.text && !entry.raw.toLowerCase().includes(filter.text.toLowerCase())) return false;
  return true;
}

export function defaultLogFilter(): Filter {
  return { phase: ["Starting", "Succeeded", "Failed"] };
}

export function formatRuntimeLogLine(payload: RuntimeLogPayload): string {
  const source = payload.source ?? "maa-runtime";
  const body: Record<string, unknown> = {
    source,
    msg: payload.message,
  };
  if (payload.taskId !== undefined) body.task_id = payload.taskId;
  if (payload.nodeId !== undefined) body.node_id = payload.nodeId;
  if (payload.recoId !== undefined) body.reco_id = payload.recoId;
  if (payload.actionId !== undefined) body.action_id = payload.actionId;
  if (payload.name !== undefined) body.name = payload.name;
  if (payload.details !== undefined) body.details = payload.details;
  try {
    return `[${payload.level}] ${JSON.stringify(body)}`;
  } catch {
    return `[${payload.level}] ${JSON.stringify({ source, msg: payload.message })}`;
  }
}
