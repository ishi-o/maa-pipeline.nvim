import path from "node:path";

import type { AgentProject, ResolvedAgent, RuntimeAgent } from "./types.ts";
import { fileExists, replaceProjectDir } from "./utils.ts";

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
      if (await fileExists(candidate)) {
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
