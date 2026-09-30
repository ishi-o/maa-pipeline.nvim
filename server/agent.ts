import { access } from "node:fs/promises";
import path from "node:path";

export interface AgentConfig {
  child_exec?: string;
  child_args?: string[];
  identifier?: string;
}

export interface RuntimeAgent extends Required<Pick<AgentConfig, "child_exec">> {
  child_args?: string[];
  identifier?: string;
}

interface AgentProject {
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

async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function replaceProjectDir(value: string, root: string) {
  return value.replaceAll("{PROJECT_DIR}", root);
}

export function runtimeAgents(project: AgentProject): RuntimeAgent[] {
  const value = project.bundle.content.object.agent;
  const agents = Array.isArray(value) ? value : value ? [value] : [];
  return agents.flatMap((agent) =>
    agent.child_exec
      ? [
          {
            ...agent,
            child_exec: replaceProjectDir(agent.child_exec, project.root),
            ...(agent.child_args
              ? {
                  child_args: agent.child_args.map((arg) => replaceProjectDir(arg, project.root)),
                }
              : {}),
          },
        ]
      : [],
  );
}

export async function resolveAgent(exec: string, cwd?: string): Promise<ResolvedAgent> {
  const requestedCwd = cwd ?? process.cwd();
  const execName = process.platform === "win32" && !path.extname(exec) ? `${exec}.exe` : exec;

  let current = path.resolve(requestedCwd);
  let executable: string | undefined;
  while (true) {
    for (const candidate of [
      path.resolve(current, execName),
      path.resolve(current, "install", execName),
    ]) {
      if (await exists(candidate)) {
        executable = candidate;
        break;
      }
    }
    if (executable) break;

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return executable
    ? { executable, cwd: path.dirname(path.dirname(executable)) }
    : { executable: execName, cwd: requestedCwd };
}
