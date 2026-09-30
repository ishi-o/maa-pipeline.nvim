import { access } from 'node:fs/promises'
import path from 'node:path'

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function replaceProjectDir(value, root) {
  return value.replaceAll('{PROJECT_DIR}', root)
}

async function isMaaRuntimeDirectory(directory) {
  return await exists(path.join(directory, 'MaaAgentServer.dll')) &&
    await exists(path.join(directory, 'MaaFramework.dll'))
}

async function discoverMaaRuntimeDirectories(executable, cwd) {
  if (process.platform !== 'win32') return []

  const directories = []
  const seen = new Set()
  const add = directory => {
    const key = directory.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    directories.push(directory)
  }

  const startingPoints = [path.dirname(path.resolve(executable))]
  if (cwd) startingPoints.push(path.resolve(cwd))

  for (const startingPoint of startingPoints) {
    let current = startingPoint
    while (true) {
      let found = false
      for (const candidate of [current, path.join(current, 'maafw')]) {
        if (await isMaaRuntimeDirectory(candidate)) {
          add(candidate)
          found = true
        }
      }

      if (found) break
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }

  return directories
}

export function runtimeAgents(project) {
  const value = project.bundle.content.object.agent
  const agents = value ? (Array.isArray(value) ? value : [value]) : []
  return agents.filter(agent => agent.child_exec).map(agent => ({
    child_exec: replaceProjectDir(agent.child_exec, project.root),
    child_args: agent.child_args?.map(arg => replaceProjectDir(arg, project.root)),
    identifier: agent.identifier
  }))
}

export async function resolveAgent(exec, cwd) {
  const requestedCwd = cwd ?? process.cwd()
  if (process.platform !== 'win32' || path.extname(exec)) {
    return {
      executable: exec,
      cwd: requestedCwd,
      runtimeDirectories: await discoverMaaRuntimeDirectories(exec, requestedCwd)
    }
  }

  let current = path.resolve(requestedCwd)
  let executable
  while (true) {
    const candidates = [
      path.resolve(current, `${exec}.exe`),
      path.resolve(current, 'install', `${exec}.exe`)
    ]

    for (const candidate of candidates) {
      if (await exists(candidate)) {
        executable = candidate
        break
      }
    }
    if (executable) break

    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  const resolved = executable ?? exec
  const agentCwd = executable ? path.dirname(path.dirname(executable)) : requestedCwd
  return {
    executable: resolved,
    cwd: agentCwd,
    runtimeDirectories: await discoverMaaRuntimeDirectories(resolved, requestedCwd)
  }
}
