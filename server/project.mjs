import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'jsonc-parser'

import {
  FsContentLoader,
  FsContentWatcher,
  InterfaceBundle
} from '@nekosu/maa-pipeline-manager'

export function normalizePath(file) {
  return path.normalize(path.resolve(file))
}

export function fileUriPath(uri) {
  if (!uri || !uri.startsWith('file://')) return null
  try {
    return normalizePath(fileURLToPath(uri))
  } catch {
    return null
  }
}

export function pathUri(file) {
  return pathToFileURL(normalizePath(file)).toString()
}

function inside(file, root) {
  const relative = path.relative(normalizePath(root), normalizePath(file))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function fileExists(file) {
  try {
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}

export class OverlayLoader extends FsContentLoader {
  constructor() {
    super()
    this.overlays = new Map()
    this.versions = new Map()
  }

  set(file, text, version) {
    const key = normalizePath(file)
    if (version !== undefined && this.versions.has(key) && version < this.versions.get(key)) return
    if (version !== undefined) this.versions.set(key, version)
    if (text === undefined) this.overlays.delete(key)
    else this.overlays.set(key, text)
  }

  async get(file) {
    const key = normalizePath(file)
    return this.overlays.has(key) ? this.overlays.get(key) : super.get(key)
  }
}

async function readConfig(loader, root) {
  const text = await loader.get(path.join(root, 'config', 'maa_pi_config.json'))
  if (!text) return {}
  const errors = []
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  return errors.length === 0 && value && typeof value === 'object' ? value : {}
}

function configName(value) {
  return typeof value === 'string' ? value : value?.name ?? ''
}

export class MaaProject {
  constructor({ root, interfaceFile, mode = 'auto', onChanged }) {
    this.root = normalizePath(root)
    this.interfaceFile = normalizePath(interfaceFile)
    this.maa = mode === 'maa' || (mode === 'auto' && existsSync(path.join(this.root, 'src', 'MaaCore')))
    this.loader = new OverlayLoader()
    this.watcher = new FsContentWatcher()
    this.bundle = new InterfaceBundle(
      this.loader,
      this.watcher,
      this.maa,
      this.root,
      path.basename(this.interfaceFile)
    )
    this.onChanged = onChanged
    this.dirty = new Set()
    this.queue = Promise.resolve()
    this.ready = false
    this.lastPublishedUris = new Set()
    this.config = {}
    this.controller = ''
    this.resource = ''
    this.locale = ''
  }

  isInside(file) {
    return inside(file, this.root)
  }

  async init() {
    if (this.ready) return
    await this.bundle.load()
    await this.selectResource()
    this.ready = true
    for (const event of ['interfaceChanged', 'importChanged', 'slaveInterfaceChanged', 'localeChanged', 'pathChanged', 'bundleReloaded', 'pipelineChanged']) {
      this.bundle.on(event, () => this.onChanged?.(this))
    }
  }

  async selectResource() {
    await this.bundle.flush()
    const config = await readConfig(this.loader, this.root)
    this.config = config
    const controllers = this.bundle.info.decls.filter(decl => decl.type === 'interface.controller')
    const resources = this.bundle.info.decls.filter(decl => decl.type === 'interface.resource')
    this.controller = configName(config.controller) || controllers[0]?.name || ''
    this.resource = (typeof config.resource === 'string' ? config.resource : '') || resources[0]?.name || ''
    this.locale = typeof config.__locale === 'string' ? config.__locale : this.bundle.langBundle.langs[0]?.name ?? ''
    await this.bundle.switchActive(this.controller, this.resource)
  }

  setDocument(file, text, version) {
    const key = normalizePath(file)
    this.loader.set(key, text, version)
    this.dirty.add(key)
  }

  async refreshFile(file) {
    const key = normalizePath(file)
    if (key === normalizePath(this.bundle.file)) {
      this.bundle.content.dirty = true
      await this.bundle.content.flush()
      return
    }
    const imported = this.bundle.imports.find(item => normalizePath(item.file) === key)
    if (imported) {
      imported.dirty = true
      await imported.flush()
      return
    }
    const language = this.bundle.langBundle.langs.find(item => normalizePath(path.join(this.root, item.file)) === key)
    if (language) {
      language.content.dirty = true
      await language.content.flush()
      return
    }
    const located = this.bundle.locateLayer(key)
    if (!located) return
    const resource = this.bundle.bundles.find(item => item.layer === located[0])
    if (resource) {
      resource.manager.changed.add(key)
      await resource.manager.flush()
    }
  }

  async refresh() {
    const task = this.queue.then(async () => {
      for (const file of this.dirty) await this.refreshFile(file)
      this.dirty.clear()
      await this.selectResource()
      await this.bundle.flush(true)
    })
    this.queue = task.catch(() => {})
    return task
  }

  async stop() {
    this.bundle.stop()
    await this.queue.catch(() => {})
  }
}

async function findInterface(file, roots) {
  let current = normalizePath(path.dirname(file))
  while (true) {
    for (const name of ['interface.json', 'interface.jsonc']) {
      const candidate = path.join(current, name)
      if (await fileExists(candidate)) return candidate
    }
    if (roots.some(root => normalizePath(root) === current)) return null
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export class ProjectManager {
  constructor({ roots, mode, onChanged }) {
    this.roots = roots
    this.mode = mode
    this.onChanged = onChanged
    this.projects = new Map()
  }

  loaded(file) {
    return [...this.projects.values()]
      .filter(project => project.isInside(file))
      .sort((left, right) => right.root.length - left.root.length)[0]
  }

  byRoot(root) {
    const normalized = normalizePath(root)
    return [...this.projects.values()].find(project => project.root === normalized)
  }

  async ensure(file) {
    const existing = this.loaded(file)
    if (existing) return existing
    const interfaceFile = await findInterface(file, this.roots)
    if (!interfaceFile) return null
    const key = normalizePath(interfaceFile)
    if (this.projects.has(key)) return this.projects.get(key)
    const project = new MaaProject({
      root: path.dirname(interfaceFile),
      interfaceFile,
      mode: this.mode,
      onChanged: value => this.onChanged?.(value)
    })
    this.projects.set(key, project)
    try {
      await project.init()
      return project
    } catch (error) {
      this.projects.delete(key)
      await project.stop()
      throw error
    }
  }

  async stop() {
    await Promise.all([...this.projects.values()].map(project => project.stop()))
  }
}
