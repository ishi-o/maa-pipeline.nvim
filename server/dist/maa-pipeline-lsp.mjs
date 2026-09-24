// server/index.mjs
import { createConnection, DiagnosticSeverity as DiagnosticSeverity2, ProposedFeatures, TextDocuments, TextDocumentSyncKind } from "vscode-languageserver/node";
import { TextDocument as TextDocument2 } from "vscode-languageserver-textdocument";
import { parse as parse2, printParseErrorCode } from "jsonc-parser";
import { setLocale } from "@nekosu/maa-locale";
import { buildDiagnosticMessage, performDiagnostic } from "@nekosu/maa-pipeline-manager";

// server/features.mjs
import path2 from "node:path";
import {
  CompletionItemKind,
  DiagnosticSeverity,
  MarkupKind,
  SymbolKind
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  extractTaskRef,
  findDeclRef,
  findMaaDeclRef,
  isAnchorRef,
  normalizeImageFolder
} from "@nekosu/maa-pipeline-manager";

// server/project.mjs
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import {
  FsContentLoader,
  FsContentWatcher,
  InterfaceBundle
} from "@nekosu/maa-pipeline-manager";
function normalizePath(file) {
  return path.normalize(path.resolve(file));
}
function fileUriPath(uri) {
  if (!uri || !uri.startsWith("file://")) return null;
  try {
    return normalizePath(fileURLToPath(uri));
  } catch {
    return null;
  }
}
function pathUri(file) {
  return pathToFileURL(normalizePath(file)).toString();
}
function inside(file, root) {
  const relative = path.relative(normalizePath(root), normalizePath(file));
  return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
async function fileExists(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}
var OverlayLoader = class extends FsContentLoader {
  constructor() {
    super();
    this.overlays = /* @__PURE__ */ new Map();
    this.versions = /* @__PURE__ */ new Map();
  }
  set(file, text, version) {
    const key = normalizePath(file);
    if (version !== void 0 && this.versions.has(key) && version < this.versions.get(key)) return;
    if (version !== void 0) this.versions.set(key, version);
    if (text === void 0) this.overlays.delete(key);
    else this.overlays.set(key, text);
  }
  async get(file) {
    const key = normalizePath(file);
    return this.overlays.has(key) ? this.overlays.get(key) : super.get(key);
  }
};
async function readConfig(loader, root) {
  const text = await loader.get(path.join(root, "config", "maa_pi_config.json"));
  if (!text) return {};
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  return errors.length === 0 && value && typeof value === "object" ? value : {};
}
function configName(value) {
  return typeof value === "string" ? value : value?.name ?? "";
}
var MaaProject = class {
  constructor({ root, interfaceFile: interfaceFile2, mode = "auto", onChanged }) {
    this.root = normalizePath(root);
    this.interfaceFile = normalizePath(interfaceFile2);
    this.maa = mode === "maa" || mode === "auto" && existsSync(path.join(this.root, "src", "MaaCore"));
    this.loader = new OverlayLoader();
    this.watcher = new FsContentWatcher();
    this.bundle = new InterfaceBundle(
      this.loader,
      this.watcher,
      this.maa,
      this.root,
      path.basename(this.interfaceFile)
    );
    this.onChanged = onChanged;
    this.dirty = /* @__PURE__ */ new Set();
    this.queue = Promise.resolve();
    this.ready = false;
    this.lastPublishedUris = /* @__PURE__ */ new Set();
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
    for (const event of ["interfaceChanged", "importChanged", "slaveInterfaceChanged", "localeChanged", "pathChanged", "bundleReloaded", "pipelineChanged"]) {
      this.bundle.on(event, () => this.onChanged?.(this));
    }
  }
  async selectResource() {
    await this.bundle.flush();
    const config = await readConfig(this.loader, this.root);
    this.config = config;
    const controllers = this.bundle.info.decls.filter((decl) => decl.type === "interface.controller");
    const resources = this.bundle.info.decls.filter((decl) => decl.type === "interface.resource");
    this.controller = configName(config.controller) || controllers[0]?.name || "";
    this.resource = (typeof config.resource === "string" ? config.resource : "") || resources[0]?.name || "";
    this.locale = typeof config.__locale === "string" ? config.__locale : this.bundle.langBundle.langs[0]?.name ?? "";
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
    const imported = this.bundle.imports.find((item2) => normalizePath(item2.file) === key);
    if (imported) {
      imported.dirty = true;
      await imported.flush();
      return;
    }
    const language = this.bundle.langBundle.langs.find((item2) => normalizePath(path.join(this.root, item2.file)) === key);
    if (language) {
      language.content.dirty = true;
      await language.content.flush();
      return;
    }
    const located = this.bundle.locateLayer(key);
    if (!located) return;
    const resource = this.bundle.bundles.find((item2) => item2.layer === located[0]);
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
    this.queue = task.catch(() => {
    });
    return task;
  }
  async stop() {
    this.bundle.stop();
    await this.queue.catch(() => {
    });
  }
};
async function findInterface(file, roots) {
  let current = normalizePath(path.dirname(file));
  while (true) {
    for (const name of ["interface.json", "interface.jsonc"]) {
      const candidate = path.join(current, name);
      if (await fileExists(candidate)) return candidate;
    }
    if (roots.some((root) => normalizePath(root) === current)) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
var ProjectManager = class {
  constructor({ roots, mode, onChanged }) {
    this.roots = roots;
    this.mode = mode;
    this.onChanged = onChanged;
    this.projects = /* @__PURE__ */ new Map();
  }
  loaded(file) {
    return [...this.projects.values()].filter((project) => project.isInside(file)).sort((left, right) => right.root.length - left.root.length)[0];
  }
  byRoot(root) {
    const normalized = normalizePath(root);
    return [...this.projects.values()].find((project) => project.root === normalized);
  }
  async ensure(file) {
    const existing = this.loaded(file);
    if (existing) return existing;
    const interfaceFile2 = await findInterface(file, this.roots);
    if (!interfaceFile2) return null;
    const key = normalizePath(interfaceFile2);
    if (this.projects.has(key)) return this.projects.get(key);
    const project = new MaaProject({
      root: path.dirname(interfaceFile2),
      interfaceFile: interfaceFile2,
      mode: this.mode,
      onChanged: (value) => this.onChanged?.(value)
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
};

// server/features.mjs
function textDocument(file, text) {
  const uri = pathUri(file);
  return TextDocument.create(uri, "jsonc", 0, text);
}
async function sourceDocument(project, file) {
  return textDocument(file, await project.loader.get(file) ?? "");
}
function range(document, offset, length) {
  return { start: document.positionAt(offset), end: document.positionAt(offset + length) };
}
function nodeRange(document, node, startDelta = 0, endDelta = 0) {
  return range(document, Math.max(0, node.offset + startDelta), Math.max(0, node.length + endDelta));
}
function interfaceFile(project, file) {
  const rel = path2.relative(project.root, normalizePath(file)).replaceAll(path2.sep, "/");
  return normalizePath(file) === normalizePath(project.bundle.file) || project.bundle.importFiles.includes(rel) || project.bundle.langBundle.langs.some((lang) => lang.file === rel);
}
function context(project, document, position) {
  const file = fileUriPath(document.uri);
  if (!file) return null;
  const located = project.bundle.locateLayer(file);
  if (!located) return null;
  const offset = document.offsetAt(position);
  const layer = located[0];
  const isInterface = interfaceFile(project, file);
  return {
    file,
    layer,
    isDefault: located[2],
    interface: isInterface,
    offset,
    decl: findDeclRef(layer.mergedDecls.filter((item2) => item2.file === file), offset),
    ref: findDeclRef(layer.mergedRefs.filter((item2) => item2.file === file), offset),
    interfaceDecl: isInterface ? findDeclRef(project.bundle.info.decls.filter((item2) => item2.file === file), offset) : null,
    interfaceRef: isInterface ? findDeclRef(project.bundle.info.refs.filter((item2) => item2.file === file), offset) : null
  };
}
function infoLocation(project, info) {
  return sourceDocument(project, info.file).then((document) => ({
    uri: pathUri(info.file),
    range: nodeRange(document, info.location)
  }));
}
function uniqueInfos(infos) {
  const seen = /* @__PURE__ */ new Set();
  return infos.filter((info) => {
    const location = info.location ?? info;
    const key = `${info.file}\0${location.offset}\0${location.length}\0${info.type ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function infoLocations(project, infos) {
  return Promise.all(uniqueInfos(infos).map((info) => infoLocation(project, info)));
}
function interfaceMatches(index, decl, ref, wantRefs) {
  const source = wantRefs ? index.refs : index.decls;
  if (decl) {
    if (["interface.controller", "interface.resource", "interface.group", "interface.task", "interface.option"].includes(decl.type)) {
      return source.filter((item2) => item2.type === decl.type && (wantRefs ? item2.target === decl.name : item2.name === decl.name));
    }
    if (decl.type === "interface.case" || decl.type === "interface.input") {
      return source.filter((item2) => item2.type === decl.type && (wantRefs ? item2.target === decl.name : item2.name === decl.name) && item2.option === decl.option);
    }
  }
  if (ref) {
    if (["interface.controller", "interface.resource", "interface.group", "interface.task", "interface.option"].includes(ref.type)) {
      return source.filter((item2) => item2.type === ref.type && (wantRefs ? item2.target === ref.target : item2.name === ref.target));
    }
    if (ref.type === "interface.case" || ref.type === "interface.input") {
      return source.filter((item2) => item2.type === ref.type && (wantRefs ? item2.target === ref.target : item2.name === ref.target) && item2.option === ref.option);
    }
  }
  return [];
}
function pipelineDecls(decls, decl, ref) {
  if (decl?.type === "task.decl") return decls.filter((item2) => item2.type === "task.decl" && item2.task === decl.task);
  if (decl?.type === "task.anchor") return decls.filter((item2) => item2.type === "task.anchor" && item2.anchor === decl.anchor);
  if (decl?.type === "task.sub_reco") return decls.filter((item2) => item2.type === "task.sub_reco" && item2.name === decl.name && item2.task === decl.task);
  if (decl?.type === "task.locale") return decls.filter((item2) => item2.type === "task.locale" && item2.key === decl.key);
  if (ref && extractTaskRef(ref)) return decls.filter((item2) => item2.type === "task.decl" && item2.task === ref.target);
  if (ref && isAnchorRef(ref)) return decls.filter((item2) => item2.type === "task.anchor" && item2.anchor === ref.target);
  if (ref?.type === "task.roi") return decls.filter((item2) => item2.type === "task.sub_reco" && item2.name === ref.target && item2.task === ref.task);
  if (ref?.type === "task.locale") return decls.filter((item2) => item2.type === "task.locale" && item2.key === ref.target);
  return [];
}
function pipelineRefs(refs, decl, ref) {
  const taskRefs = (task2) => refs.filter((item2) => {
    if (["task.anchor", "task.reco", "task.color_filter", "task.custom_task", "task.entry"].includes(item2.type)) return item2.target === task2;
    if (item2.type === "task.next" || item2.type === "task.target") return item2.target === task2 && !item2.attrs?.attrs?.Anchor;
    if (item2.type === "task.roi" && !item2.attrs?.attrs?.Anchor) {
      return item2.target === task2 && !item2.prev?.some((value) => value.value === item2.target);
    }
    return false;
  });
  if (decl?.type === "task.decl") return taskRefs(decl.task);
  if (decl?.type === "task.anchor") return refs.filter((item2) => isAnchorRef(item2) && item2.target === decl.anchor);
  if (decl?.type === "task.sub_reco") return refs.filter((item2) => item2.type === "task.roi" && item2.target === decl.name && item2.task === decl.task);
  if (decl?.type === "task.locale") return refs.filter((item2) => item2.type === "task.locale" && item2.target === decl.key);
  const task = ref && extractTaskRef(ref);
  if (task) return taskRefs(task);
  if (ref && isAnchorRef(ref)) return refs.filter((item2) => isAnchorRef(item2) && item2.target === ref.target);
  if (ref?.type === "task.locale") return refs.filter((item2) => item2.type === "task.locale" && item2.target === ref.target);
  return [];
}
function maaTaskRef(context2) {
  if (context2.decl?.type === "task.decl") return findMaaDeclRef(context2.decl.tasks, context2.offset - context2.decl.location.offset);
  if (context2.ref && ["task.maa.base_task", "task.maa.expr"].includes(context2.ref.type)) return findMaaDeclRef(context2.ref.tasks, context2.offset - context2.ref.location.offset);
  return null;
}
function maaLocations(infos, task) {
  const result = [];
  const prefix = `${task}@`;
  for (const info of infos) {
    if (!["task.decl", "task.maa.base_task", "task.maa.expr"].includes(info.type)) continue;
    for (const ref of info.tasks) {
      if (ref.taskSuffix === task || ref.taskSuffix.startsWith(prefix)) {
        result.push({ file: info.file, offset: info.location.offset + 1 + ref.offset, length: task.length });
      }
    }
  }
  return result;
}
async function definition(project, document, position) {
  const current = context(project, document, position);
  if (!current) return null;
  const bundle = project.bundle;
  if (current.interfaceDecl || current.interfaceRef) {
    const decls2 = interfaceMatches(bundle.info, current.interfaceDecl, current.interfaceRef, false);
    const refs = current.interfaceDecl ? interfaceMatches(bundle.info, current.interfaceDecl, current.interfaceRef, true) : [];
    return infoLocations(project, [...decls2, ...refs]);
  }
  if (bundle.maa) {
    const task = maaTaskRef(current);
    if (!task) return null;
    const names = task.taskSuffix !== task.task ? [task.task, task.taskSuffix] : [task.task];
    const infos = names.flatMap((name) => maaLocations(bundle.topLayer.mergedAllDecls, name));
    if (current.decl) {
      infos.push(...names.flatMap((name) => maaLocations(bundle.topLayer.mergedAllRefs, name)));
    }
    return Promise.all(uniqueInfos(infos).map(async (info) => ({
      uri: pathUri(info.file),
      range: range(await sourceDocument(project, info.file), info.offset, info.length)
    })));
  }
  if (current.isDefault && current.decl?.type === "task.decl") return null;
  const decls = pipelineDecls(bundle.topLayer.mergedAllDecls, current.decl, current.ref);
  if (current.decl) decls.push(...pipelineRefs(bundle.topLayer.mergedAllRefs, current.decl, current.ref));
  return infoLocations(project, decls);
}
async function references(project, document, position) {
  const current = context(project, document, position);
  if (!current) return [];
  const bundle = project.bundle;
  if (current.interfaceDecl || current.interfaceRef) {
    return infoLocations(project, [
      ...interfaceMatches(bundle.info, current.interfaceDecl, current.interfaceRef, false),
      ...interfaceMatches(bundle.info, current.interfaceDecl, current.interfaceRef, true)
    ]);
  }
  if (bundle.maa) {
    const task = maaTaskRef(current);
    if (!task) return [];
    const names = task.taskSuffix !== task.task ? [task.task, task.taskSuffix] : [task.task];
    const infos = names.flatMap((name) => [
      ...maaLocations(bundle.topLayer.mergedAllDecls, name),
      ...maaLocations(bundle.topLayer.mergedAllRefs, name)
    ]);
    return Promise.all(uniqueInfos(infos).map(async (info) => ({ uri: pathUri(info.file), range: range(await sourceDocument(project, info.file), info.offset, info.length) })));
  }
  if (current.isDefault && current.decl?.type === "task.decl") return [];
  return infoLocations(project, [
    ...pipelineDecls(bundle.topLayer.mergedAllDecls, current.decl, current.ref),
    ...pipelineRefs(bundle.topLayer.mergedAllRefs, current.decl, current.ref)
  ]);
}
function offsetRange(document, location, deltaRight = 0, deltaLeft = 0) {
  const start = Math.max(0, location.offset + deltaLeft);
  const end = Math.max(start, location.offset + location.length + deltaRight);
  return { start: document.positionAt(start), end: document.positionAt(end) };
}
function escaped(value) {
  const encoded = JSON.stringify(value);
  return encoded.slice(1, -1);
}
function item(label, kind, editRange, extra = {}) {
  const { newText = label, ...rest } = extra;
  return {
    label,
    kind,
    textEdit: { range: editRange, newText },
    ...rest
  };
}
function taskItem(project, task, editRange, sortText = `1_${task}`, current) {
  return item(task, CompletionItemKind.Class, editRange, {
    sortText,
    data: { type: "task", root: project.root, task, current }
  });
}
function interfaceCompletion(project, document, ref) {
  let values = [];
  if (["interface.controller", "interface.resource", "interface.task", "interface.group", "interface.option"].includes(ref.type)) {
    values = project.bundle.info.decls.filter((decl) => decl.type === ref.type).map((decl) => decl.name);
  } else if (ref.type === "interface.case") {
    values = project.bundle.info.decls.filter((decl) => decl.type === ref.type && decl.option === ref.option).map((decl) => decl.name);
  } else if (ref.type === "interface.input" && ref.offset === void 0) {
    values = project.bundle.info.decls.filter((decl) => decl.type === ref.type && decl.option === ref.option).map((decl) => decl.name);
  }
  const editRange = offsetRange(document, ref.location, -1, 1);
  return [...new Set(values)].map((value) => item(value, CompletionItemKind.Reference, editRange, {
    newText: escaped(value)
  }));
}
var maaVirtualKeys = [
  "none",
  "self",
  "next",
  "sub",
  "exceeded_next",
  "on_error_next",
  "reduce_other_times"
];
function maaCompletion(project, document, position, current, ref) {
  if (!["task.maa.base_task", "task.maa.expr"].includes(ref.type)) return null;
  const items = [];
  const relative = current.offset - ref.location.offset - 2;
  const lastChar = ref.target[relative];
  const cursor = document.offsetAt(position);
  const wordRange = () => {
    if (!/[a-zA-Z0-9_-]/.test(lastChar ?? "")) return null;
    let length = 0;
    let index = relative;
    while (index >= 0 && /[a-zA-Z0-9_-]/.test(ref.target[index])) {
      length += 1;
      index -= 1;
    }
    return { start: document.positionAt(cursor - length), end: position };
  };
  if (ref.type === "task.maa.base_task") {
    if (current.offset === ref.location.offset + 1 || /[@a-zA-Z0-9_-]/.test(lastChar ?? "")) {
      const editRange = wordRange() ?? offsetRange(document, ref.location, current.offset - ref.location.offset, 1);
      return current.layer.getTaskList().map((task) => taskItem(project, task, editRange, `1_${task}`, ref.belong));
    }
    return [];
  }
  const emptyRange = { start: position, end: position };
  if (current.offset === ref.location.offset + 1 || /[ @+^(a-zA-Z0-9_-]/.test(lastChar ?? "")) {
    const editRange = wordRange() ?? emptyRange;
    items.push(...current.layer.getTaskList().map((task) => taskItem(project, task, editRange, `1_${task}`, ref.belong)));
    if (lastChar !== "@") {
      items.push(...maaVirtualKeys.map((name) => item(`#${name}`, CompletionItemKind.EnumMember, emptyRange)));
    }
  } else if (lastChar === "#") {
    items.push(...maaVirtualKeys.map((name) => item(name, CompletionItemKind.EnumMember, emptyRange)));
  } else {
    items.push(...maaVirtualKeys.map((name) => item(`#${name}`, CompletionItemKind.EnumMember, emptyRange)));
  }
  return items;
}
function completion(project, document, position) {
  const current = context(project, document, position);
  if (!current) return null;
  if (current.interfaceRef) return interfaceCompletion(project, document, current.interfaceRef);
  const layer = current.layer;
  const decls = layer.mergedDecls.filter((decl) => decl.file === current.file);
  if (current.decl?.type === "task.anchor") {
    const declared = decls.filter((decl) => decl.type === "task.anchor" && decl.belong === current.decl.belong).map((decl) => decl.anchor);
    const editRange = offsetRange(document, current.decl.location, -1, 1);
    return [...new Set(layer.getAnchorList().map(([anchor]) => anchor))].filter((anchor) => !declared.includes(anchor)).map((anchor) => item(anchor, CompletionItemKind.Variable, editRange, { sortText: anchor }));
  }
  const ref = current.ref;
  if (!ref) return null;
  if (project.bundle.maa) return maaCompletion(project, document, position, current, ref);
  const taskRange = offsetRange(document, ref.location, -1, 1);
  const tasks = () => layer.getTaskList().map((task) => taskItem(project, task, taskRange));
  const anchors = (editRange) => [...new Set(layer.getAnchorList().map(([anchor]) => anchor))].map((anchor) => item(anchor, CompletionItemKind.Variable, editRange, { sortText: anchor }));
  if (ref.type === "task.next" && ref.objMode || ["task.anchor", "task.reco", "task.color_filter", "task.custom_task", "task.entry"].includes(ref.type)) {
    if (ref.type === "task.next" && ref.attrs.attrs.Anchor) return anchors(taskRange);
    if (ref.type === "task.color_filter") {
      return layer.getTaskList().filter((task) => layer.getTaskBriefInfo(task).reco === "ColorMatch").map((task) => taskItem(project, task, taskRange));
    }
    return tasks();
  }
  if (ref.type === "task.custom_anchor") return anchors(taskRange);
  if (ref.type === "task.next" && !ref.objMode || ref.type === "task.roi" || ref.type === "task.target") {
    const editRange = offsetRange(document, ref.location, -1, 1 + ref.attrs.offset);
    const prefixRange = { start: editRange.start, end: editRange.start };
    const result = [];
    if (ref.type === "task.next" && !ref.attrs.attrs.JumpBack) {
      result.push(item("[JumpBack]", CompletionItemKind.Property, prefixRange, {
        sortText: "0_JumpBack",
        command: { title: "trigger completion", command: "maa-pipeline.triggerCompletion" }
      }));
    }
    if (!ref.attrs.attrs.Anchor) {
      result.push(item("[Anchor]", CompletionItemKind.Property, prefixRange, {
        sortText: "2_Anchor",
        command: { title: "trigger completion", command: "maa-pipeline.triggerCompletion" }
      }));
      result.push(...layer.getTaskList().map((task) => taskItem(project, task, editRange)));
    } else {
      result.push(...anchors(editRange).map((entry) => ({ ...entry, sortText: `1_${entry.label}` })));
    }
    if (ref.type === "task.roi") {
      result.push(...ref.prev.map((value) => item(value.value, CompletionItemKind.Reference, editRange, {
        sortText: `0_${value.value}`
      })));
    }
    return result;
  }
  if (ref.type === "task.template" || ref.type === "task.custom_template") {
    const result = [];
    for (const folder of layer.getImageFolders().keys()) {
      result.push(item(`${folder}/`, CompletionItemKind.Folder, taskRange, { sortText: `0_${folder}/` }));
    }
    for (const image of layer.getImageList()) {
      result.push(item(image, CompletionItemKind.File, taskRange, { sortText: `1_${image}` }));
    }
    return result;
  }
  if (ref.type === "task.locale") {
    const editRange = offsetRange(document, ref.location, -1, 2);
    return project.bundle.langBundle.allKeys().map((key) => item(key, CompletionItemKind.Constant, editRange, {
      newText: escaped(key),
      data: { type: "locale", root: project.root, key }
    }));
  }
  return null;
}
function markdownText(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}
async function localeHover(project, key) {
  const bundle = project.bundle.langBundle;
  if (bundle.langs.length === 0) return null;
  const entries = bundle.queryKey(key);
  const rows = await Promise.all(entries.map(async (entry, index) => {
    const lang = bundle.langs[index];
    if (!entry) return `| ${lang?.name ?? index} | <missing> |`;
    const file = path2.join(project.root, lang.file);
    const source = await sourceDocument(project, file);
    const line = source.positionAt(entry.keyNode.offset).line + 1;
    return `| [${lang.name}](${pathUri(file)}#L${line}) | ${markdownText(entry.value)} |`;
  }));
  return `| locale | value |
| --- | --- |
${rows.join("\n")}`;
}
function taskBrief(project, task, current) {
  const layer = project.bundle.topLayer;
  let evaluated = null;
  try {
    evaluated = project.bundle.maa ? project.bundle.maaEvalTask(current ? `${current}@${task}` : task)?.task : project.bundle.evalTask(task);
  } catch {
  }
  if (project.bundle.maa) {
    return `Algo: ${evaluated?.algorithm ?? "MatchTemplate"}

Act: ${evaluated?.action ?? "DoNothing"}`;
  }
  const doc = layer.getTaskDoc(task);
  return [
    doc,
    `Reco: ${evaluated?.recognition ?? "DirectHit"}`,
    `Act: ${evaluated?.action ?? "DoNothing"}`
  ].filter(Boolean).join("\n\n");
}
function imageHover(project, layer, image) {
  const content = [];
  if (!project.bundle.maa && !image.endsWith(".png")) {
    const normalized = normalizeImageFolder(image);
    for (const sourceLayer of layer.getImageFolders().get(normalized) ?? []) {
      const count = [...sourceLayer.images].filter((value) => value.startsWith(`${normalized}/`)).length;
      const folder = path2.join(sourceLayer.root, "image", normalized);
      content.push(`[${path2.relative(project.root, folder) || "."}](${pathUri(folder)}) \u2014 ${count} images`);
    }
  } else {
    for (const [sourceLayer, full, relative] of layer.getImage(image)) {
      const label = path2.relative(project.root, sourceLayer.root) || ".";
      content.push(`${label} \u2014 [${relative}](${pathUri(full)})

![](${pathUri(full)})`);
    }
  }
  return content.join("\n\n");
}
async function taskHover(project, layer, task, current) {
  if (!task) return "";
  const content = [`### ${task}`];
  const seen = /* @__PURE__ */ new Set();
  for (const source of layer.getTask(task)) {
    for (const info of source.infos) {
      const key = `${info.file}\0${info.prop.offset}\0${info.prop.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const document = await sourceDocument(project, info.file);
      const text = document.getText().slice(info.prop.offset, info.data.offset + info.data.length);
      content.push(`${path2.relative(project.root, source.layer.root) || "."}

\`\`\`jsonc
${text}
\`\`\``);
    }
  }
  let evaluated = null;
  try {
    evaluated = project.bundle.maa ? project.bundle.maaEvalTask(current ? `${current}@${task}` : task)?.task : project.bundle.evalTask(task);
  } catch {
  }
  if (evaluated) {
    const algorithm = project.bundle.maa ? evaluated.algorithm ?? "MatchTemplate" : evaluated.recognition ?? "DirectHit";
    if (["MatchTemplate", "TemplateMatch", "FeatureMatch"].includes(algorithm)) {
      let templates = evaluated.template;
      if (typeof templates === "string") templates = [templates];
      if (!templates && project.bundle.maa) {
        const full = current ? `${current}@${task}` : task;
        templates = [`${layer.maaFindTaskDecl(full)}.png`];
      }
      for (const template of templates ?? []) {
        const image = imageHover(project, layer, template);
        if (image) content.push(image);
      }
    }
    content.push(`merged

\`\`\`json
${JSON.stringify(evaluated, null, 2)}
\`\`\``);
  }
  return content.join("\n\n");
}
async function resolveCompletion(project, completionItem) {
  const data = completionItem.data;
  if (!data || data.root !== project.root) return completionItem;
  if (data.type === "task") {
    completionItem.documentation = { kind: MarkupKind.Markdown, value: taskBrief(project, data.task, data.current) };
  } else if (data.type === "locale") {
    const value = await localeHover(project, data.key);
    if (value) completionItem.documentation = { kind: MarkupKind.Markdown, value };
  }
  return completionItem;
}
async function hover(project, document, position) {
  const current = context(project, document, position);
  if (!current) return null;
  const locale = current.decl?.type === "task.locale" ? current.decl.key : current.ref?.type === "task.locale" ? current.ref.target : null;
  if (locale) {
    const value = await localeHover(project, locale);
    return value ? { contents: { kind: MarkupKind.Markdown, value } } : null;
  }
  if (current.decl?.type === "task.decl") {
    if (current.isDefault) return null;
    return { contents: { kind: MarkupKind.Markdown, value: await taskHover(project, project.bundle.topLayer, current.decl.task) } };
  }
  if (project.bundle.maa) {
    const task2 = maaTaskRef(current);
    if (task2) {
      return { contents: { kind: MarkupKind.Markdown, value: await taskHover(project, project.bundle.topLayer, task2.taskSuffix, current.ref?.belong) } };
    }
  }
  const task = current.ref ? extractTaskRef(current.ref) : null;
  if (task) {
    return { contents: { kind: MarkupKind.Markdown, value: await taskHover(project, project.bundle.topLayer, task) } };
  }
  if (current.ref?.type === "task.template" || current.ref?.type === "task.custom_template") {
    const value = imageHover(project, project.bundle.topLayer, current.ref.target);
    return value ? { contents: { kind: MarkupKind.Markdown, value } } : null;
  }
  return null;
}
function documentLinks(project, document) {
  const current = context(project, document, { line: 0, character: 0 });
  if (!current) return [];
  const result = [];
  if (current.interface) {
    for (const ref of project.bundle.info.refs.filter((item2) => item2.file === current.file)) {
      if (["interface.language_path", "interface.resource_path", "interface.import_path"].includes(ref.type)) {
        result.push({ range: nodeRange(document, ref.location), target: pathUri(path2.join(project.root, ref.target)) });
      }
    }
  }
  for (const ref of current.layer.mergedRefs.filter((item2) => item2.file === current.file)) {
    if (["task.can_locale", "task.locale_text"].includes(ref.type) && /\.(md|png)$/.test(ref.target)) {
      result.push({ range: nodeRange(document, ref.location), target: pathUri(path2.join(project.bundle.topLayer.root, ref.target)) });
      continue;
    }
    if (!["task.template", "task.custom_template"].includes(ref.type)) continue;
    if (!ref.target.endsWith(".png")) {
      if (project.bundle.maa) continue;
      const normalized = normalizeImageFolder(ref.target);
      const sourceLayer = project.bundle.topLayer.getImageFolders().get(normalized)?.[0];
      if (sourceLayer) {
        result.push({
          range: nodeRange(document, ref.location),
          target: pathUri(path2.join(sourceLayer.root, "image", normalized))
        });
      }
      continue;
    }
    const image = project.bundle.topLayer.getImage(ref.target)[0];
    if (image) result.push({ range: nodeRange(document, ref.location), target: pathUri(image[1]) });
  }
  return result;
}
function symbols(project, query) {
  const q = query.toLowerCase();
  return Promise.all(uniqueInfos(project.bundle.info.layer.mergedAllDecls).filter((decl) => decl.type === "task.decl" && !decl.task.startsWith("$") && decl.task.toLowerCase().includes(q)).map(async (decl) => {
    const location = await infoLocation(project, decl);
    return {
      name: decl.task,
      kind: SymbolKind.Class,
      location,
      containerName: `${path2.basename(decl.file)}:${location.range.start.line + 1}`
    };
  }));
}
function hsv2rgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(h / 60 % 2 - 1));
  const m = v - c;
  let rgb = [0, 0, 0];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((value) => (value + m) * 255);
}
function documentColors(project, document) {
  const current = context(project, document, { line: 0, character: 0 });
  if (!current) return [];
  return current.layer.mergedRefs.filter((ref) => ref.file === current.file && ref.type === "task.color").map((ref) => {
    const rgb = ref.method === "hsv" ? hsv2rgb(ref.color[0], ref.color[1], ref.color[2]) : ref.color;
    return {
      range: nodeRange(document, ref.location),
      color: {
        red: rgb[0] / 255,
        green: rgb[1] / 255,
        blue: rgb[2] / 255,
        alpha: 1
      }
    };
  });
}
function syntaxDiagnostics(document, parse3, printParseErrorCode2) {
  const errors = [];
  parse3(document.getText(), errors, { allowTrailingComma: true, disallowComments: false });
  return errors.map((error) => ({
    range: range(document, error.offset, Math.max(error.length, 1)),
    severity: DiagnosticSeverity.Error,
    source: "maa-pipeline",
    code: `json-${error.error}`,
    message: printParseErrorCode2(error.error)
  }));
}

// server/interactive.mjs
import path3 from "node:path";
import { CodeActionKind } from "vscode-languageserver/node";
import { modify } from "jsonc-parser";
import { t } from "@nekosu/maa-locale";
import { extractTaskRef as extractTaskRef2 } from "@nekosu/maa-pipeline-manager";
var commands = {
  noop: "maa-pipeline.noop",
  triggerCompletion: "maa-pipeline.triggerCompletion",
  showReferences: "maa-pipeline.showReferences",
  evaluateTask: "maa-pipeline.evaluateTask",
  launchTask: "maa-pipeline.launchTask",
  switchConfig: "maa-pipeline.switchConfig",
  extractLocale: "maa-pipeline.extractLocale"
};
var notifications = {
  triggerCompletion: "maa-pipeline/triggerCompletion",
  showReferences: "maa-pipeline/showReferences",
  showText: "maa-pipeline/showText",
  launchTask: "maa-pipeline/launchTask",
  requestInput: "maa-pipeline/requestInput"
};
function lens(range2, title, command = commands.noop, args = []) {
  return { range: range2, command: { title, command, arguments: args } };
}
function codeLenses(project, document) {
  const file = fileUriPath(document.uri);
  if (!file) return [];
  const located = project.bundle.locateLayer(file);
  if (!located) return [];
  const [layer, normalizedFile, isDefault] = located;
  const result = [];
  for (const decl of project.bundle.info.decls.filter((info) => info.file === normalizedFile)) {
    const range2 = nodeRange(document, decl.location);
    if (decl.type === "interface.resource") {
      const active = decl.name === project.resource;
      const disabled = decl.controller && !decl.controller.includes(project.controller);
      if (active) result.push(lens(range2, t("maa.pipeline.codelens.resource-activated")));
      else if (disabled) result.push(lens(range2, t("maa.pipeline.codelens.resource-disabled")));
      else result.push(lens(range2, t("maa.pipeline.codelens.resource-switch"), commands.switchConfig, [project.root, "resource", decl.name]));
    } else if (decl.type === "interface.language") {
      const active = decl.name === project.locale;
      if (active) result.push(lens(range2, t("maa.pipeline.codelens.language-activated")));
      else result.push(lens(range2, t("maa.pipeline.codelens.language-switch"), commands.switchConfig, [project.root, "__locale", decl.name]));
    }
  }
  if (isDefault) return result;
  const counts = /* @__PURE__ */ new Map();
  const counted = /* @__PURE__ */ new Set();
  for (const ref of project.bundle.topLayer.mergedAllRefs) {
    const task = extractTaskRef2(ref);
    const key = task && `${task}\0${ref.file}\0${ref.location.offset}\0${ref.location.length}`;
    if (task && !counted.has(key)) {
      counted.add(key);
      counts.set(task, (counts.get(task) ?? 0) + 1);
    }
  }
  for (const [task, infos] of Object.entries(layer.tasks)) {
    for (const info of infos) {
      if (info.file !== normalizedFile) continue;
      const range2 = nodeRange(document, info.prop);
      const position = document.positionAt(info.prop.offset + 1);
      if (project.bundle.maa) {
        result.push(lens(range2, t("maa.pipeline.codelens.eval-task"), commands.evaluateTask, [project.root, task]));
      } else {
        result.push(lens(range2, t("maa.pipeline.codelens.launch"), commands.launchTask, [project.root, task]));
        result.push(lens(range2, t("maa.pipeline.codelens.refs", `${counts.get(task) ?? 0}`), commands.showReferences, [project.root, document.uri, position]));
      }
    }
  }
  return result;
}
function inlayHints(project, document, requestedRange) {
  const current = context(project, document, requestedRange.start);
  if (!current) return [];
  const begin = document.offsetAt(requestedRange.start);
  const end = document.offsetAt(requestedRange.end);
  const refs = current.layer.mergedRefs.filter(
    (ref) => ref.file === current.file && ref.location.offset >= begin && ref.location.offset + ref.location.length <= end
  );
  const result = [];
  const preferred = project.bundle.langBundle.queryName(project.locale);
  for (const ref of refs) {
    const position = document.positionAt(ref.location.offset + ref.location.length);
    if (ref.type === "task.locale") {
      const entry = project.bundle.langBundle.queryKey(ref.target)[preferred];
      if (entry) result.push({ position, label: entry.value });
    }
    const task = extractTaskRef2(ref);
    if (task) {
      const doc = current.layer.getTaskDoc(task);
      if (doc) result.push({ position, label: doc });
    }
  }
  return result;
}
function codeActions(project, document, requestedRange) {
  const file = fileUriPath(document.uri);
  if (!file) return [];
  const located = project.bundle.locateLayer(file);
  if (!located) return [];
  const [layer, normalizedFile] = located;
  const begin = document.offsetAt(requestedRange.start);
  const end = document.offsetAt(requestedRange.end);
  const ref = layer.mergedRefs.find(
    (info) => info.file === normalizedFile && info.type === "task.can_locale" && info.location.offset <= end && info.location.offset + info.location.length >= begin
  );
  if (!ref) return [];
  const title = t("maa.pipeline.codeaction.extract-locale");
  return [{
    title,
    kind: CodeActionKind.RefactorExtract,
    command: {
      title,
      command: commands.extractLocale,
      arguments: [{
        root: project.root,
        uri: document.uri,
        offset: ref.location.offset,
        length: ref.location.length,
        value: ref.target
      }]
    }
  }];
}
async function localeWorkspaceEdit(project, request, key) {
  if (!key || project.bundle.langBundle.allKeys().includes(key)) return null;
  const sourceFile = fileUriPath(request.uri);
  if (!sourceFile) return null;
  const documentChanges = [];
  const source = await sourceDocument(project, sourceFile);
  documentChanges.push({
    textDocument: { uri: request.uri, version: null },
    edits: [{
      range: {
        start: source.positionAt(request.offset),
        end: source.positionAt(request.offset + request.length)
      },
      newText: JSON.stringify(`$${key}`)
    }]
  });
  for (const action of project.bundle.langBundle.addPair(key, request.value)) {
    const uri = pathUri(action.file);
    if (action.type === "replace") {
      const document = textDocument(action.file, "");
      documentChanges.push({ kind: "create", uri, options: { overwrite: true } });
      documentChanges.push({
        textDocument: { uri, version: null },
        edits: [{
          range: { start: document.positionAt(0), end: document.positionAt(document.getText().length) },
          newText: action.content
        }]
      });
    } else {
      const document = await sourceDocument(project, action.file);
      const position = document.positionAt(action.offset);
      documentChanges.push({
        textDocument: { uri, version: null },
        edits: [{ range: { start: position, end: position }, newText: action.content }]
      });
    }
  }
  return { documentChanges };
}
async function configWorkspaceEdit(project, key, value) {
  const file = path3.join(project.root, "config", "maa_pi_config.json");
  const previous = await project.loader.get(file);
  const text = previous ?? "{}\n";
  const document = textDocument(file, text);
  const edits = modify(text, [key], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" }
  }).map((edit) => ({
    range: {
      start: document.positionAt(edit.offset),
      end: document.positionAt(edit.offset + edit.length)
    },
    newText: edit.content
  }));
  const uri = pathUri(file);
  return previous === void 0 ? {
    documentChanges: [
      { kind: "create", uri },
      { textDocument: { uri, version: null }, edits }
    ]
  } : { changes: { [uri]: edits } };
}
function evaluatedTask(project, task) {
  const value = project.bundle.maa ? project.bundle.maaEvalTask(task)?.task : project.bundle.evalTask(task);
  return value ? JSON.stringify(value, null, 2) : null;
}

// server/index.mjs
var connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
var documents = new TextDocuments(TextDocument2);
var projects;
function report(error) {
  connection.console.error(error instanceof Error ? error.stack ?? error.message : String(error));
}
async function forDocument(document) {
  const file = fileUriPath(document.uri);
  if (!file || !projects) return null;
  const project = await projects.ensure(file);
  if (project) await project.refresh();
  return project;
}
async function publish(project) {
  try {
    await project.refresh();
    const byUri = /* @__PURE__ */ new Map();
    for (const diagnostic of performDiagnostic(project.bundle, {})) {
      const message = await buildDiagnosticMessage(project.root, diagnostic, async (file, offset) => {
        const document = await sourceDocument(project, file);
        const position = document.positionAt(offset);
        return [position.line, position.character];
      }, {});
      const uri = pathUri(diagnostic.file);
      const list = byUri.get(uri) ?? [];
      list.push({
        range: {
          start: { line: message[0][0], character: message[0][1] },
          end: { line: message[1][0], character: message[1][1] }
        },
        severity: diagnostic.level === "warning" ? DiagnosticSeverity2.Warning : DiagnosticSeverity2.Error,
        source: "maa-pipeline",
        code: diagnostic.type,
        message: message[2]
      });
      byUri.set(uri, list);
    }
    for (const document of documents.all()) {
      const file = fileUriPath(document.uri);
      if (!file || !project.isInside(file)) continue;
      const diagnostics = syntaxDiagnostics(document, parse2, printParseErrorCode);
      if (diagnostics.length) byUri.set(document.uri, [...byUri.get(document.uri) ?? [], ...diagnostics]);
    }
    for (const uri of project.lastPublishedUris) {
      if (!byUri.has(uri)) connection.sendDiagnostics({ uri, diagnostics: [] });
    }
    for (const [uri, diagnostics] of byUri) connection.sendDiagnostics({ uri, diagnostics });
    project.lastPublishedUris = new Set(byUri.keys());
  } catch (error) {
    report(error);
  }
}
connection.onInitialize((params) => {
  const options = params.initializationOptions ?? {};
  const roots = (params.workspaceFolders ?? []).map((item2) => fileUriPath(item2.uri)).filter(Boolean);
  if (!roots.length && params.rootUri) {
    const root = fileUriPath(params.rootUri);
    if (root) roots.push(root);
  }
  setLocale(options.locale === "zh" ? "zh" : "en");
  projects = new ProjectManager({ roots, mode: options.mode ?? "auto", onChanged: publish });
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        triggerCharacters: ['"', "[", "]", "$", "@", "#", "+", "^", "("],
        resolveProvider: true
      },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      codeLensProvider: { resolveProvider: false },
      inlayHintProvider: true,
      codeActionProvider: { codeActionKinds: ["refactor.extract"] },
      documentLinkProvider: { resolveProvider: false },
      workspaceSymbolProvider: true,
      colorProvider: true,
      executeCommandProvider: { commands: Object.values(commands) }
    },
    serverInfo: { name: "maa-pipeline-lsp", version: "0.1.0" }
  };
});
documents.onDidOpen(async (event) => {
  try {
    const file = fileUriPath(event.document.uri);
    const project = file && await projects?.ensure(file);
    if (!project) return;
    project.setDocument(file, event.document.getText(), event.document.version);
    await publish(project);
  } catch (error) {
    report(error);
  }
});
documents.onDidChangeContent((event) => {
  void (async () => {
    const file = fileUriPath(event.document.uri);
    const project = file && await projects?.ensure(file);
    if (!project) return;
    project.setDocument(file, event.document.getText(), event.document.version);
    await publish(project);
  })().catch(report);
});
documents.onDidClose((event) => {
  void (async () => {
    const file = fileUriPath(event.document.uri);
    const project = file && projects?.loaded(file);
    if (!project) return;
    project.setDocument(file, void 0, event.document.version);
    await publish(project);
  })().catch(report);
});
connection.onCompletion(async (params) => {
  const document = documents.get(params.textDocument.uri);
  const project = document && await forDocument(document);
  return project ? completion(project, document, params.position) : null;
});
connection.onCompletionResolve(async (item2) => {
  const project = item2.data?.root && projects?.byRoot(item2.data.root);
  if (!project) return item2;
  await project.refresh();
  return resolveCompletion(project, item2);
});
connection.onHover(async (params) => {
  const document = documents.get(params.textDocument.uri);
  const project = document && await forDocument(document);
  return project ? hover(project, document, params.position) : null;
});
connection.onDefinition(async (params) => {
  const document = documents.get(params.textDocument.uri);
  const project = document && await forDocument(document);
  return project ? definition(project, document, params.position) : null;
});
connection.onReferences(async (params) => {
  const document = documents.get(params.textDocument.uri);
  const project = document && await forDocument(document);
  return project ? references(project, document, params.position) : [];
});
connection.onCodeLens(async (params) => {
  const document = documents.get(params.textDocument.uri);
  const project = document && await forDocument(document);
  return project ? codeLenses(project, document) : [];
});
connection.languages.inlayHint.on(async (params) => {
  const document = documents.get(params.textDocument.uri);
  const project = document && await forDocument(document);
  return project ? inlayHints(project, document, params.range) : [];
});
connection.onCodeAction(async (params) => {
  const document = documents.get(params.textDocument.uri);
  const project = document && await forDocument(document);
  return project ? codeActions(project, document, params.range) : [];
});
connection.onDocumentLinks(async (params) => {
  const document = documents.get(params.textDocument.uri);
  const project = document && await forDocument(document);
  return project ? documentLinks(project, document) : [];
});
connection.onWorkspaceSymbol(async (params) => {
  if (!projects) return [];
  return Promise.all([...projects.projects.values()].map((project) => project.refresh())).then(() => Promise.all([...projects.projects.values()].map((project) => symbols(project, params.query)))).then((results) => results.flat());
});
connection.onDocumentColor(async (params) => {
  const document = documents.get(params.textDocument.uri);
  const project = document && await forDocument(document);
  return project ? documentColors(project, document) : [];
});
connection.onColorPresentation(() => []);
connection.onExecuteCommand(async (params) => {
  const args = params.arguments ?? [];
  if (params.command === commands.noop) return null;
  if (params.command === commands.triggerCompletion) {
    connection.sendNotification(notifications.triggerCompletion);
    return null;
  }
  const root = typeof args[0] === "string" ? args[0] : args[0]?.root;
  const project = root && projects?.byRoot(root);
  if (!project) return null;
  await project.refresh();
  if (params.command === commands.showReferences) {
    const [, uri, position] = args;
    const file = fileUriPath(uri);
    if (!file || !position) return null;
    const document = documents.get(uri) ?? await sourceDocument(project, file);
    const locations = await references(project, document, position);
    connection.sendNotification(notifications.showReferences, { uri, position, locations });
  } else if (params.command === commands.evaluateTask) {
    const value = evaluatedTask(project, args[1]);
    if (value) connection.sendNotification(notifications.showText, { title: args[1], content: value });
  } else if (params.command === commands.launchTask) {
    connection.sendNotification(notifications.launchTask, { root: project.root, task: args[1] });
  } else if (params.command === commands.switchConfig) {
    const [, key, value] = args;
    const edit = await configWorkspaceEdit(project, key, value);
    const result = await connection.workspace.applyEdit(edit);
    if (result.applied) {
      project.config[key] = value;
      if (key === "resource") project.resource = value;
      if (key === "__locale") project.locale = value;
      await project.bundle.switchActive(project.controller, project.resource);
      await publish(project);
    }
  } else if (params.command === commands.extractLocale) {
    const [request, key] = args;
    if (!key) {
      connection.sendNotification(notifications.requestInput, {
        title: "Localization key",
        command: params.command,
        arguments: [request]
      });
      return null;
    }
    const edit = await localeWorkspaceEdit(project, request, key);
    if (edit) await connection.workspace.applyEdit(edit);
  }
  return null;
});
connection.onShutdown(async () => projects?.stop());
documents.listen(connection);
connection.listen();
