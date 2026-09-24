import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { MaaVersionManager } from '@nekosu/maa-version-manager'
import {
  buildControllerRuntime,
  buildResourceRuntime
} from '@nekosu/maa-pipeline-manager'
import {
  hostToSubReq,
  initNoti,
  logNoti,
  shutdownNoti,
  subToHostReq
} from '@nekosu/maa-server-proto'
import { createMessageConnection } from 'vscode-jsonrpc/node'

const runtimeScript = fileURLToPath(new URL('./maa-runtime.mjs', import.meta.url))

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64')
}

function replaceProjectDir(value, root) {
  return value.replaceAll('{PROJECT_DIR}', root)
}

function runtimeAgents(project) {
  const value = project.bundle.content.object.agent
  const agents = value ? (Array.isArray(value) ? value : [value]) : []
  return agents.filter(agent => agent.child_exec).map(agent => ({
    child_exec: replaceProjectDir(agent.child_exec, project.root),
    child_args: agent.child_args?.map(arg => replaceProjectDir(arg, project.root)),
    identifier: agent.identifier
  }))
}

function runtimeConfig(project, constants) {
  const data = project.bundle.content.object
  const controller = buildControllerRuntime(data, project.config, constants)
  if (typeof controller === 'string') throw new Error(controller)
  const resource = buildResourceRuntime(data, project.config)
  if (typeof resource === 'string') throw new Error(resource)
  return {
    root: project.root,
    controller,
    resource,
    task: { tasks: [] },
    agent: runtimeAgents(project)
  }
}

export class RuntimeClient {
  constructor(connection, options = {}) {
    options ??= {}
    this.connection = connection
    this.options = {
      dataDir: options.data_dir,
      version: options.version ?? '5.13.0',
      registry: options.registry ?? MaaVersionManager.registries.npm,
      timeout: options.timeout ?? 60_000,
      debugMode: options.debug_mode ?? true,
      saveDraw: options.save_draw ?? false,
      saveOnError: options.save_on_error ?? true,
      locale: options.locale === 'zh' ? 'zh' : 'en'
    }
    this.manager = null
    this.rpc = null
    this.server = null
    this.process = null
    this.active = null
    this.running = null
    this.agents = new Map()
  }

  notify(level, message, task) {
    this.connection.sendNotification('maa-pipeline/runtimeLog', { level, message, task })
  }

  async prepare() {
    if (!this.options.dataDir) throw new Error('init_options.runtime.data_dir is required')
    if (!this.manager) {
      this.manager = new MaaVersionManager(path.join(this.options.dataDir, 'native'), this.options.registry)
      await this.manager.init()
    }
    const labels = {
      'prepare-folder': 'Preparing MaaFramework',
      'download-scripts': `Downloading MaaFramework ${this.options.version}`,
      'download-binary': 'Downloading MaaFramework native library',
      'move-folders': 'Installing MaaFramework',
      finish: 'MaaFramework is ready'
    }
    const prepared = await this.manager.prepare(this.options.version, step => this.notify('info', labels[step]))
    if (!prepared) throw new Error(`Failed to prepare MaaFramework ${this.options.version}`)
  }

  async ensure() {
    if (this.rpc) return this.rpc
    await this.prepare()
    await mkdir(path.join(this.options.dataDir, 'logs'), { recursive: true })

    const server = net.createServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    this.server = server
    const id = randomUUID()
    const address = server.address()
    let rejectConnection
    let connectionTimer
    const connected = new Promise((resolve, reject) => {
      rejectConnection = reject
      connectionTimer = setTimeout(() => reject(new Error('Maa server connection timed out')), 60_000)
      server.once('connection', socket => {
        const rpc = createMessageConnection(socket, socket)
        rpc.onNotification(initNoti, clientId => {
          if (clientId !== id) return
          clearTimeout(connectionTimer)
          this.rpc = rpc
          this.bind(rpc)
          resolve(rpc)
        })
        rpc.listen()
      })
    })

    const child = spawn(process.execPath, [runtimeScript, encode({
      id,
      port: address.port,
      module: this.manager.moduleFolder(this.options.version),
      maaLog: path.join(this.options.dataDir, 'logs'),
      debugMode: this.options.debugMode,
      saveDraw: this.options.saveDraw,
      saveOnError: this.options.saveOnError
    })], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.process = child
    child.stdout.on('data', data => this.notify('info', data.toString().trim()))
    child.stderr.on('data', data => this.notify('error', data.toString().trim()))
    child.once('error', error => {
      clearTimeout(connectionTimer)
      rejectConnection(error)
    })
    child.once('exit', code => {
      if (this.process !== child) return
      this.notify(code === 0 ? 'info' : 'error', `Maa server exited with code ${code}`)
      if (!this.rpc) {
        clearTimeout(connectionTimer)
        rejectConnection(new Error(`Maa server exited with code ${code}`))
      }
      this.process = null
      this.rpc = null
      this.active = null
    })
    try {
      return await connected
    } catch (error) {
      if (this.process === child) {
        child.kill()
        this.process = null
      }
      if (this.server === server) {
        server.close()
        this.server = null
      }
      throw error
    }
  }

  bind(rpc) {
    rpc.onNotification(logNoti, (level, message) => this.notify(level, message))
    rpc.onRequest(subToHostReq, async (method, args) => {
      if (method === 'pushNotify') {
        this.notify('info', JSON.stringify(args[1]), this.active?.task)
        return null
      }
      if (method === 'startTask') return this.startAgent(...args)
      if (method === 'stopAgent') return this.stopAgent(args[0])
      if (method === 'startDebugSession') {
        this.notify('error', 'Debug-session agents require VS Code and are not supported')
        return null
      }
      if (method === 'quickPick') {
        const actions = args[0].map(title => ({ title }))
        const selected = await this.connection.window.showInformationMessage('Select a Maa item', ...actions)
        return selected?.title ?? null
      }
      return null
    })
  }

  request(method, ...args) {
    if (!this.rpc) throw new Error('Maa server is not connected')
    return this.rpc.sendRequest(hostToSubReq, method, args)
  }

  startAgent(exec, args, cwd, env) {
    const id = randomUUID()
    const child = spawn(exec, args, {
      cwd,
      env: {
        ...process.env,
        ...env,
        PI_INTERFACE_VERSION: 'v2.5.0',
        PI_CLIENT_NAME: 'Neovim',
        PI_CLIENT_VERSION: '0.1.0',
        PI_CLIENT_LANGUAGE: this.options.locale,
        PI_CLIENT_MAAFW_VERSION: this.options.version,
        PI_VERSION: '',
        PI_CONTROLLER: '{}',
        PI_RESOURCE: '{}'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.agents.set(id, child)
    child.stdout.on('data', data => this.notify('info', data.toString().trim()))
    child.stderr.on('data', data => this.notify('error', data.toString().trim()))
    const stopped = () => {
      if (!this.agents.delete(id) || !this.rpc) return
      void this.request('agentStopped', id).catch(() => {})
    }
    child.once('error', error => {
      this.notify('error', `Agent failed to start: ${error.message}`)
      stopped()
    })
    child.once('exit', stopped)
    return id
  }

  stopAgent(id) {
    const child = this.agents.get(id)
    if (!child) return
    this.agents.delete(id)
    child.kill()
  }

  async run(project, task) {
    if (this.running) throw new Error(`Task ${this.running} is already running`)
    this.running = task
    this.notify('info', `Starting task ${task}`, task)
    try {
      await this.ensure()
      const constants = await this.request('fetchConstants')
      const setup = await this.request('setupInstance', runtimeConfig(project, constants), this.options.timeout)
      if (!setup?.handle) throw new Error(setup?.error ?? 'Failed to create Maa instance')
      this.active = { handle: setup.handle, task }
      try {
        const succeeded = await this.request('postTask', setup.handle, task, [])
        this.notify(succeeded ? 'info' : 'error', `Task ${task} ${succeeded ? 'finished' : 'failed'}`, task)
      } finally {
        await this.request('destroyInstance', setup.handle).catch(() => {})
        if (this.active?.handle === setup.handle) this.active = null
      }
    } finally {
      this.running = null
    }
  }

  async stop() {
    if (!this.active) {
      this.notify('warn', this.running ? `Task ${this.running} is still starting` : 'No Maa task is running')
      return
    }
    this.notify('info', `Stopping task ${this.active.task}`, this.active.task)
    await this.request('postStop', this.active.handle)
  }

  async shutdown() {
    if (this.active) await this.stop().catch(() => {})
    for (const id of this.agents.keys()) this.stopAgent(id)
    this.rpc?.sendNotification(shutdownNoti)
    this.rpc?.dispose()
    this.process?.kill()
    this.server?.close()
    this.rpc = null
  }
}
