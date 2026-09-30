import { randomUUID } from 'node:crypto'
import { access, mkdir } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import pacote from 'pacote'
import { x as extractTar } from 'tar'
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

import { resolveAgent, runtimeAgents } from './agent.mjs'

const runtimeScript = fileURLToPath(new URL('./maa-runtime.mjs', import.meta.url))

export class RuntimeSetupError extends Error {
  constructor(code) {
    super(code)
    this.code = code
    this.name = 'RuntimeSetupError'
  }
}

class NpmConfigVersionManager extends MaaVersionManager {
  async extract(packageSpec, destination, registry) {
    await mkdir(destination, { recursive: true })
    await pacote.tarball.stream(packageSpec, async stream => {
      let downloaded = 0
      let reported = 0
      stream.on('data', chunk => {
        downloaded += chunk.length
        if (downloaded - reported >= 1024 * 1024) {
          reported = downloaded
          this.downloadProgress?.(downloaded)
        }
      })
      await pipeline(stream, extractTar({
        cwd: destination,
        strip: 1,
        noMtime: true,
        preserveOwner: false,
        filter: (_, entry) => !/Link$/.test(entry.type)
      }))
    }, { registry })
  }

  async fetchLatest() {
    return pacote.manifest('@maaxyz/maa-node@latest')
  }
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64')
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
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

function pngSize(image) {
  const buffer = Buffer.from(image, 'base64')
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('Maa server returned a non-PNG screenshot')
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  }
}

export class RuntimeClient {
  constructor(connection, options = {}) {
    options ??= {}
    this.connection = connection
    this.options = {
      dataDir: options.data_dir,
      requestedVersion: options.version ?? 'latest',
      resolvedVersion: null,
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
    this.failedAgents = new Set()
  }

  notify(level, message, task) {
    this.connection.sendNotification('maa-pipeline/runtimeLog', { level, message, task })
  }

  async prepare() {
    if (!this.options.dataDir) throw new Error('init_options.runtime.data_dir is required')
    if (!this.manager) {
      this.manager = new NpmConfigVersionManager(path.join(this.options.dataDir, 'native'))
      await this.manager.init()
    }
    let version = this.options.resolvedVersion
    if (!version) {
      version = this.options.requestedVersion
      if (version === 'latest') {
        const latest = await this.manager.fetchLatest()
        if (!latest?.version) throw new Error('Failed to resolve the latest MaaFramework version')
        version = latest.version
      }
    }
    this.options.resolvedVersion = version

    const labels = {
      'prepare-folder': 'Preparing MaaFramework',
      'download-scripts': `Downloading MaaFramework ${version}`,
      'download-binary': 'Downloading MaaFramework native library',
      'move-folders': 'Installing MaaFramework',
      finish: 'MaaFramework is ready'
    }
    const progress = step => {
      const label = labels[step] ?? step
      if (step === 'download-scripts' || step === 'download-binary') this.manager.downloadLabel = label
      this.notify('info', label)
    }
    this.manager.downloadProgress = bytes =>
      this.notify('info', `${this.manager.downloadLabel} (${formatSize(bytes)})`)

    const prepared = await this.manager.prepare(version, progress)
    if (!prepared) throw new Error(`Failed to prepare MaaFramework ${version}`)
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
      module: this.manager.moduleFolder(this.options.resolvedVersion),
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

  controllerReady(project) {
    if (project.config.controller === '$fixed') return !!project.config.vscFixed?.image
    const controller = project.bundle.content.object.controller?.find(item => item.name === project.config.controller)
    if (!controller) return false
    if (controller.type === 'Adb') {
      const value = project.config.adb
      return !!value?.adb_path && !!value?.address && value.screencap !== undefined &&
        value.input !== undefined && value.config !== undefined
    }
    if (controller.type === 'Win32') return !!project.config.win32?.hwnd
    if (controller.type === 'Gamepad') return !!project.config.gamepad?.hwnd
    if (controller.type === 'PlayCover') return !!project.config.playcover?.address
    if (controller.type === 'Linux') return !!project.config.linux
    return false
  }

  async discoverController(project, name) {
    if (name === '$fixed') {
      return {
        config_key: 'vscFixed',
        fields: [{ key: 'image', label: 'Absolute image path', required: true }]
      }
    }
    const controller = project.bundle.content.object.controller?.find(item => item.name === name)
    if (!controller) throw new Error(`Unknown controller ${name}`)
    if (controller.type === 'Adb') {
      await this.ensure()
      const devices = await this.request('refreshAdb', project.config.adb?.adb_path)
      return {
        items: devices.map(device => ({
          label: `${device[0]} — ${device[2]}`,
          config: {
            adb: {
              adb_path: device[1],
              address: device[2],
              screencap: device[3],
              input: device[4],
              config: JSON.parse(device[5])
            }
          }
        }))
      }
    }
    if (controller.type === 'Win32' || controller.type === 'Gamepad') {
      await this.ensure()
      const desktop = controller.type === 'Win32' ? controller.win32 : controller.gamepad
      const classRegex = desktop?.class_regex ? new RegExp(desktop.class_regex) : null
      const windowRegex = desktop?.window_regex ? new RegExp(desktop.window_regex) : null
      const devices = (await this.request('refreshDesktop')).filter(device =>
        (!classRegex || classRegex.test(device[1])) && (!windowRegex || windowRegex.test(device[2])))
      const key = controller.type === 'Win32' ? 'win32' : 'gamepad'
      return {
        items: devices.map(device => ({
          label: `${device[2]} — ${device[1]}`,
          config: { [key]: { hwnd: device[0] } }
        }))
      }
    }
    if (controller.type === 'PlayCover') {
      return {
        config_key: 'playcover',
        fields: [{ key: 'address', label: 'PlayCover address (host:port)', required: true }]
      }
    }
    if (controller.type === 'Linux') {
      await this.ensure()
      const meta = controller.linux ?? {}
      const screencap = meta.screencap ?? 'Wlr'
      const input = meta.input ?? 'Wlr'
      if (screencap === 'PipeWire' && meta.pipewire_source === 'Portal') {
        throw new Error('Linux PipeWire Portal controllers are not supported by the upstream Maa server')
      }
      const fields = []
      if ((screencap === 'PipeWire' && meta.pipewire_source !== 'Portal') || input === 'Libei') {
        const instances = await this.request('refreshGamescope')
        fields.push({
          key: 'display_no',
          label: 'Gamescope display',
          items: instances.map(item => ({ label: `Display ${item[0]} — ${item[2]}`, value: item[0] }))
        })
      }
      if (screencap === 'Wlr' || input === 'Wlr') {
        const compositors = await this.request('refreshWlrCompositor')
        fields.push({
          key: 'wlr_socket_path',
          label: 'Wayland compositor',
          items: compositors.map(item => ({ label: `${item[2]} — ${item[1]}`, value: item[1] }))
        })
      }
      if (input === 'UInput') {
        fields.push(
          { key: 'uinput_screen_width', label: 'UInput screen width', number: true },
          { key: 'uinput_screen_height', label: 'UInput screen height', number: true }
        )
      }
      return { config_key: 'linux', fields }
    }
    throw new Error(`Unsupported controller type ${controller.type}`)
  }

  async startAgent(exec, args, cwd, env) {
    const id = randomUUID()
    const name = path.basename(exec, path.extname(exec))
    this.notify('info', `Starting external agent ${name}`)
    this.failedAgents.delete(name)
    const agent = await resolveAgent(exec, cwd)
    const childEnv = {
      ...process.env,
      ...env,
      PI_INTERFACE_VERSION: 'v2.5.0',
      PI_CLIENT_NAME: 'Neovim',
      PI_CLIENT_VERSION: '0.1.0',
      PI_CLIENT_LANGUAGE: this.options.locale,
      PI_CLIENT_MAAFW_VERSION: this.options.resolvedVersion,
      PI_VERSION: '',
      PI_CONTROLLER: '{}',
      PI_RESOURCE: '{}'
    }
    if (process.platform === 'win32') {
      const pluginRuntimeDirectory = this.manager?.binaryFolder(
        this.manager?.versionFolder(this.options.resolvedVersion)
      )
      const runtimeDirectories = [...agent.runtimeDirectories ?? [], pluginRuntimeDirectory]
      const pathKey = process.env.Path === undefined ? 'PATH' : 'Path'
      childEnv[pathKey] = [...new Set(runtimeDirectories.filter(Boolean)), childEnv[pathKey] ?? childEnv.PATH]
        .filter(Boolean)
        .join(path.delimiter)
    }
    const child = spawn(agent.executable, args, {
      cwd: agent.cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.agents.set(id, { name, child })
    child.once('spawn', () => {
      this.notify('info', `External agent ${name} started (${agent.executable})`)
    })
    child.stdout.on('data', data => this.notify('info', data.toString().trim()))
    child.stderr.on('data', data => this.notify('error', data.toString().trim()))
    const stopped = (code, signal) => {
      if (!this.agents.delete(id) || !this.rpc) return
      this.failedAgents.add(name)
      if (code !== 0 && code !== null) {
        this.notify('error', `External agent ${name} exited with code ${code}`)
      } else if (signal) {
        this.notify('warn', `External agent ${name} exited with signal ${signal}`)
      }
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
    const agent = this.agents.get(id)
    if (!agent) return
    this.agents.delete(id)
    this.notify('info', `Stopping external agent ${agent.name}`)
    agent.child.kill()
  }

  async setup(project) {
    const constants = await this.request('fetchConstants')
    const config = runtimeConfig(project, constants)
    let setup = await this.request('setupInstance', config, this.options.timeout)
    const unavailableAgents = []

    while (!setup?.handle && setup?.error === 'maa.debug.init-resource-failed') {
      const failedAgents = [...this.failedAgents]
      if (!failedAgents.length) break

      unavailableAgents.push(...failedAgents)
      this.failedAgents.clear()
      config.agent = config.agent.filter(agent => {
        const name = path.basename(agent.child_exec, path.extname(agent.child_exec))
        return !failedAgents.includes(name)
      })
      this.notify(
        'warn',
        `External agents failed to start; retrying without them: ${failedAgents.join(', ')}`
      )
      setup = await this.request('setupInstance', config, this.options.timeout)
    }

    return { setup, unavailableAgents }
  }

  async run(project, task) {
    if (this.running) throw new Error(`Task ${this.running} is already running`)
    this.running = task
    this.notify('info', `Starting task ${task}`, task)
    try {
      await this.ensure()
      const { setup, unavailableAgents } = await this.setup(project)
      if (!setup?.handle) throw new RuntimeSetupError(setup?.error ?? 'Failed to create Maa instance')
      this.active = { handle: setup.handle, task, unavailableAgents }
      try {
        const succeeded = await this.request('postTask', setup.handle, task, [])
        this.notify(
          succeeded ? 'info' : 'error',
          `Task ${task} ${succeeded ? 'finished' : 'failed'}` +
            (!succeeded && unavailableAgents.length > 0
              ? ` (external agents unavailable: ${unavailableAgents.join(', ')})`
              : ''),
          task
        )
      } finally {
        await this.request('destroyInstance', setup.handle).catch(() => {})
        if (this.active?.handle === setup.handle) this.active = null
      }
    } finally {
      this.running = null
    }
  }

  async screenshot(project) {
    if (this.active) {
      const image = await this.request('getScreencap', this.active.handle)
      if (!image) throw new Error('Failed to take screenshot')
      const size = pngSize(image)
      return { image, roi: [0, 0, size.width, size.height] }
    }
    if (this.running) throw new Error(`Task ${this.running} is still starting`)

    this.running = 'screenshot'
    this.notify('info', 'Taking screenshot')
    let handle
    try {
      await this.ensure()
      const { setup } = await this.setup(project)
      handle = setup?.handle
      if (!handle) throw new RuntimeSetupError(setup?.error ?? 'Failed to create Maa instance')
      const image = await this.request('getScreencap', handle)
      if (!image) throw new Error('Failed to take screenshot')
      const size = pngSize(image)
      return { image, roi: [0, 0, size.width, size.height] }
    } finally {
      if (handle) await this.request('destroyInstance', handle).catch(() => {})
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
