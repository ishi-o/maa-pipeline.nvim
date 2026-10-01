import { existsSync } from "node:fs";
import path from "node:path";

import { FsContentLoader, FsContentWatcher, InterfaceBundle } from "@nekosu/maa-pipeline-manager";
import {
  configName,
  fileExists,
  findInterface,
  inside,
  normalizePath,
  readConfig,
} from "./utils.ts";

export class OverlayLoader extends FsContentLoader {
  overlays = new Map<string, string | undefined>();
  versions = new Map<string, number>();

  set(file, text, version) {
    const key = normalizePath(file);
    if (version !== undefined && this.versions.has(key) && version < this.versions.get(key)) return;
    if (version !== undefined) this.versions.set(key, version);
    if (text === undefined) this.overlays.delete(key);
    else this.overlays.set(key, text);
  }

  async get(file) {
    const key = normalizePath(file);
    return this.overlays.has(key) ? this.overlays.get(key) : super.get(key);
  }
}

export class MaaProject {
  root: string;
  interfaceFile: string;
  maa: boolean;
  loader: any;
  watcher: any;
  bundle: any;
  onChanged?: (project: MaaProject) => void;
  dirty = new Set<string>();
  queue: Promise<void> = Promise.resolve();
  ready = false;
  lastPublishedUris = new Set<string>();
  config: any = {};
  controller = "";
  resource = "";
  locale = "";

  constructor({
    root,
    interfaceFile,
    mode = "auto",
    onChanged,
  }: {
    root: string;
    interfaceFile: string;
    mode?: string;
    onChanged?: (project: MaaProject) => void;
  }) {
    this.root = normalizePath(root);
    this.interfaceFile = normalizePath(interfaceFile);
    this.maa =
      mode === "maa" || (mode === "auto" && existsSync(path.join(this.root, "src", "MaaCore")));
    this.loader = new OverlayLoader();
    this.watcher = new FsContentWatcher();
    this.bundle = new InterfaceBundle(
      this.loader,
      this.watcher,
      this.maa,
      this.root,
      path.basename(this.interfaceFile),
    );
    this.onChanged = onChanged;
    this.dirty = new Set();
    this.queue = Promise.resolve();
    this.ready = false;
    this.lastPublishedUris = new Set();
    this.config = {};
    this.controller = "";
    this.resource = "";
    this.locale = "";
  }

  isInside(file) {
    return inside(file, this.root);
  }

  async init() {
    if (this.ready) return;
    await this.bundle.load();
    await this.selectResource();
    this.ready = true;
    for (const event of [
      "interfaceChanged",
      "importChanged",
      "slaveInterfaceChanged",
      "localeChanged",
      "pathChanged",
      "bundleReloaded",
      "pipelineChanged",
    ]) {
      this.bundle.on(event, () => this.onChanged?.(this));
    }
  }

  async selectResource() {
    await this.bundle.flush();
    const config = await readConfig(this.loader, this.root);
    this.config = config;
    const controllers = this.bundle.info.decls.filter(
      (decl) => decl.type === "interface.controller",
    );
    const resources = this.bundle.info.decls.filter((decl) => decl.type === "interface.resource");
    this.controller = configName(config.controller) || controllers[0]?.name || "";
    this.resource =
      (typeof config.resource === "string" ? config.resource : "") || resources[0]?.name || "";
    this.locale =
      typeof config.__locale === "string"
        ? config.__locale
        : (this.bundle.langBundle.langs[0]?.name ?? "");
    await this.bundle.switchActive(this.controller, this.resource);
  }

  setDocument(file, text, version) {
    const key = normalizePath(file);
    this.loader.set(key, text, version);
    this.dirty.add(key);
  }

  async refreshFile(file) {
    const key = normalizePath(file);
    if (key === normalizePath(this.bundle.file)) {
      this.bundle.content.dirty = true;
      await this.bundle.content.flush();
      return;
    }
    const imported = this.bundle.imports.find((item) => normalizePath(item.file) === key);
    if (imported) {
      imported.dirty = true;
      await imported.flush();
      return;
    }
    const language = this.bundle.langBundle.langs.find(
      (item) => normalizePath(path.join(this.root, item.file)) === key,
    );
    if (language) {
      language.content.dirty = true;
      await language.content.flush();
      return;
    }
    const located = this.bundle.locateLayer(key);
    if (!located) return;
    const resource = this.bundle.bundles.find((item) => item.layer === located[0]);
    if (resource) {
      resource.manager.changed.add(key);
      await resource.manager.flush();
    }
  }

  async refresh() {
    const task = this.queue.then(async () => {
      for (const file of this.dirty) await this.refreshFile(file);
      this.dirty.clear();
      await this.selectResource();
      await this.bundle.flush(true);
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async stop() {
    this.bundle.stop();
    await this.queue.catch(() => {});
  }
}

export class ProjectManager {
  roots: string[];
  mode: string;
  onChanged?: (project: MaaProject) => void;
  projects = new Map<string, MaaProject>();

  constructor({
    roots,
    mode,
    onChanged,
  }: {
    roots: string[];
    mode: string;
    onChanged?: (project: MaaProject) => void;
  }) {
    this.roots = roots;
    this.mode = mode;
    this.onChanged = onChanged;
    this.projects = new Map();
  }

  loaded(file) {
    return [...this.projects.values()]
      .filter((project) => project.isInside(file))
      .sort((left, right) => right.root.length - left.root.length)[0];
  }

  byRoot(root) {
    const normalized = normalizePath(root);
    return [...this.projects.values()].find((project) => project.root === normalized);
  }

  async ensure(file) {
    const existing = this.loaded(file);
    if (existing) return existing;
    const interfaceFile = await findInterface(file, this.roots);
    if (!interfaceFile) return null;
    const key = normalizePath(interfaceFile);
    if (this.projects.has(key)) return this.projects.get(key);
    const project = new MaaProject({
      root: path.dirname(interfaceFile),
      interfaceFile,
      mode: this.mode,
      onChanged: (value) => this.onChanged?.(value),
    });
    this.projects.set(key, project);
    try {
      await project.init();
      return project;
    } catch (error) {
      this.projects.delete(key);
      await project.stop();
      throw error;
    }
  }

  async stop() {
    await Promise.all([...this.projects.values()].map((project) => project.stop()));
  }
}
