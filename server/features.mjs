import path from 'node:path'

import {
  CompletionItemKind,
  DiagnosticSeverity,
  MarkupKind,
  SymbolKind
} from 'vscode-languageserver/node'
import { TextDocument } from 'vscode-languageserver-textdocument'
import {
  extractTaskRef,
  findDeclRef,
  findMaaDeclRef,
  isAnchorRef,
  normalizeImageFolder
} from '@nekosu/maa-pipeline-manager'

import { fileUriPath, normalizePath, pathUri } from './project.mjs'

export function textDocument(file, text) {
  const uri = pathUri(file)
  return TextDocument.create(uri, 'jsonc', 0, text)
}

export async function sourceDocument(project, file) {
  return textDocument(file, (await project.loader.get(file)) ?? '')
}

export function range(document, offset, length) {
  return { start: document.positionAt(offset), end: document.positionAt(offset + length) }
}

export function nodeRange(document, node, startDelta = 0, endDelta = 0) {
  return range(document, Math.max(0, node.offset + startDelta), Math.max(0, node.length + endDelta))
}

function interfaceFile(project, file) {
  const rel = path.relative(project.root, normalizePath(file)).replaceAll(path.sep, '/')
  return normalizePath(file) === normalizePath(project.bundle.file)
    || project.bundle.importFiles.includes(rel)
    || project.bundle.langBundle.langs.some(lang => lang.file === rel)
}

export function context(project, document, position) {
  const file = fileUriPath(document.uri)
  if (!file) return null
  const located = project.bundle.locateLayer(file)
  if (!located) return null
  const offset = document.offsetAt(position)
  const layer = located[0]
  const isInterface = interfaceFile(project, file)
  return {
    file,
    layer,
    isDefault: located[2],
    interface: isInterface,
    offset,
    decl: findDeclRef(layer.mergedDecls.filter(item => item.file === file), offset),
    ref: findDeclRef(layer.mergedRefs.filter(item => item.file === file), offset),
    interfaceDecl: isInterface
      ? findDeclRef(project.bundle.info.decls.filter(item => item.file === file), offset)
      : null,
    interfaceRef: isInterface
      ? findDeclRef(project.bundle.info.refs.filter(item => item.file === file), offset)
      : null
  }
}

function infoLocation(project, info) {
  return sourceDocument(project, info.file).then(document => ({
    uri: pathUri(info.file),
    range: nodeRange(document, info.location)
  }))
}

function uniqueInfos(infos) {
  const seen = new Set()
  return infos.filter(info => {
    const location = info.location ?? info
    const key = `${info.file}\0${location.offset}\0${location.length}\0${info.type ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function infoLocations(project, infos) {
  return Promise.all(uniqueInfos(infos).map(info => infoLocation(project, info)))
}

function interfaceMatches(index, decl, ref, wantRefs) {
  const source = wantRefs ? index.refs : index.decls
  if (decl) {
    if (['interface.controller', 'interface.resource', 'interface.group', 'interface.task', 'interface.option'].includes(decl.type)) {
      return source.filter(item => item.type === decl.type && (wantRefs ? item.target === decl.name : item.name === decl.name))
    }
    if (decl.type === 'interface.case' || decl.type === 'interface.input') {
      return source.filter(item => item.type === decl.type && (wantRefs ? item.target === decl.name : item.name === decl.name) && item.option === decl.option)
    }
  }
  if (ref) {
    if (['interface.controller', 'interface.resource', 'interface.group', 'interface.task', 'interface.option'].includes(ref.type)) {
      return source.filter(item => item.type === ref.type && (wantRefs ? item.target === ref.target : item.name === ref.target))
    }
    if (ref.type === 'interface.case' || ref.type === 'interface.input') {
      return source.filter(item => item.type === ref.type && (wantRefs ? item.target === ref.target : item.name === ref.target) && item.option === ref.option)
    }
  }
  return []
}

function pipelineDecls(decls, decl, ref) {
  if (decl?.type === 'task.decl') return decls.filter(item => item.type === 'task.decl' && item.task === decl.task)
  if (decl?.type === 'task.anchor') return decls.filter(item => item.type === 'task.anchor' && item.anchor === decl.anchor)
  if (decl?.type === 'task.sub_reco') return decls.filter(item => item.type === 'task.sub_reco' && item.name === decl.name && item.task === decl.task)
  if (decl?.type === 'task.locale') return decls.filter(item => item.type === 'task.locale' && item.key === decl.key)
  if (ref && extractTaskRef(ref)) return decls.filter(item => item.type === 'task.decl' && item.task === ref.target)
  if (ref && isAnchorRef(ref)) return decls.filter(item => item.type === 'task.anchor' && item.anchor === ref.target)
  if (ref?.type === 'task.roi') return decls.filter(item => item.type === 'task.sub_reco' && item.name === ref.target && item.task === ref.task)
  if (ref?.type === 'task.locale') return decls.filter(item => item.type === 'task.locale' && item.key === ref.target)
  return []
}

function pipelineRefs(refs, decl, ref) {
  const taskRefs = task => refs.filter(item => {
    if (['task.anchor', 'task.reco', 'task.color_filter', 'task.custom_task', 'task.entry'].includes(item.type)) return item.target === task
    if (item.type === 'task.next' || item.type === 'task.target') return item.target === task && !item.attrs?.attrs?.Anchor
    if (item.type === 'task.roi' && !item.attrs?.attrs?.Anchor) {
      return item.target === task && !item.prev?.some(value => value.value === item.target)
    }
    return false
  })
  if (decl?.type === 'task.decl') return taskRefs(decl.task)
  if (decl?.type === 'task.anchor') return refs.filter(item => isAnchorRef(item) && item.target === decl.anchor)
  if (decl?.type === 'task.sub_reco') return refs.filter(item => item.type === 'task.roi' && item.target === decl.name && item.task === decl.task)
  if (decl?.type === 'task.locale') return refs.filter(item => item.type === 'task.locale' && item.target === decl.key)
  const task = ref && extractTaskRef(ref)
  if (task) return taskRefs(task)
  if (ref && isAnchorRef(ref)) return refs.filter(item => isAnchorRef(item) && item.target === ref.target)
  if (ref?.type === 'task.locale') return refs.filter(item => item.type === 'task.locale' && item.target === ref.target)
  return []
}

function maaTaskRef(context) {
  if (context.decl?.type === 'task.decl') return findMaaDeclRef(context.decl.tasks, context.offset - context.decl.location.offset)
  if (context.ref && ['task.maa.base_task', 'task.maa.expr'].includes(context.ref.type)) return findMaaDeclRef(context.ref.tasks, context.offset - context.ref.location.offset)
  return null
}

function maaLocations(infos, task) {
  const result = []
  const prefix = `${task}@`
  for (const info of infos) {
    if (!['task.decl', 'task.maa.base_task', 'task.maa.expr'].includes(info.type)) continue
    for (const ref of info.tasks) {
      if (ref.taskSuffix === task || ref.taskSuffix.startsWith(prefix)) {
        result.push({ file: info.file, offset: info.location.offset + 1 + ref.offset, length: task.length })
      }
    }
  }
  return result
}

export async function definition(project, document, position) {
  const current = context(project, document, position)
  if (!current) return null
  const bundle = project.bundle
  if (current.interfaceDecl || current.interfaceRef) {
    const decls = interfaceMatches(bundle.info, current.interfaceDecl, current.interfaceRef, false)
    const refs = current.interfaceDecl
      ? interfaceMatches(bundle.info, current.interfaceDecl, current.interfaceRef, true)
      : []
    return infoLocations(project, [...decls, ...refs])
  }
  if (bundle.maa) {
    const task = maaTaskRef(current)
    if (!task) return null
    const names = task.taskSuffix !== task.task ? [task.task, task.taskSuffix] : [task.task]
    const infos = names.flatMap(name => maaLocations(bundle.topLayer.mergedAllDecls, name))
    if (current.decl) {
      infos.push(...names.flatMap(name => maaLocations(bundle.topLayer.mergedAllRefs, name)))
    }
    return Promise.all(uniqueInfos(infos).map(async info => ({
      uri: pathUri(info.file),
      range: range(await sourceDocument(project, info.file), info.offset, info.length)
    })))
  }
  if (current.isDefault && current.decl?.type === 'task.decl') return null
  const decls = pipelineDecls(bundle.topLayer.mergedAllDecls, current.decl, current.ref)
  if (current.decl) decls.push(...pipelineRefs(bundle.topLayer.mergedAllRefs, current.decl, current.ref))
  return infoLocations(project, decls)
}

export async function references(project, document, position) {
  const current = context(project, document, position)
  if (!current) return []
  const bundle = project.bundle
  if (current.interfaceDecl || current.interfaceRef) {
    return infoLocations(project, [
      ...interfaceMatches(bundle.info, current.interfaceDecl, current.interfaceRef, false),
      ...interfaceMatches(bundle.info, current.interfaceDecl, current.interfaceRef, true)
    ])
  }
  if (bundle.maa) {
    const task = maaTaskRef(current)
    if (!task) return []
    const names = task.taskSuffix !== task.task ? [task.task, task.taskSuffix] : [task.task]
    const infos = names.flatMap(name => [
      ...maaLocations(bundle.topLayer.mergedAllDecls, name),
      ...maaLocations(bundle.topLayer.mergedAllRefs, name)
    ])
    return Promise.all(uniqueInfos(infos).map(async info => ({ uri: pathUri(info.file), range: range(await sourceDocument(project, info.file), info.offset, info.length) })))
  }
  if (current.isDefault && current.decl?.type === 'task.decl') return []
  return infoLocations(project, [
    ...pipelineDecls(bundle.topLayer.mergedAllDecls, current.decl, current.ref),
    ...pipelineRefs(bundle.topLayer.mergedAllRefs, current.decl, current.ref)
  ])
}

function offsetRange(document, location, deltaRight = 0, deltaLeft = 0) {
  const start = Math.max(0, location.offset + deltaLeft)
  const end = Math.max(start, location.offset + location.length + deltaRight)
  return { start: document.positionAt(start), end: document.positionAt(end) }
}

function escaped(value) {
  const encoded = JSON.stringify(value)
  return encoded.slice(1, -1)
}

function item(label, kind, editRange, extra = {}) {
  const { newText = label, ...rest } = extra
  return {
    label,
    kind,
    textEdit: { range: editRange, newText },
    ...rest
  }
}

function taskItem(project, task, editRange, sortText = `1_${task}`, current) {
  return item(task, CompletionItemKind.Class, editRange, {
    sortText,
    data: { type: 'task', root: project.root, task, current }
  })
}

function interfaceCompletion(project, document, ref) {
  let values = []
  if (['interface.controller', 'interface.resource', 'interface.task', 'interface.group', 'interface.option'].includes(ref.type)) {
    values = project.bundle.info.decls.filter(decl => decl.type === ref.type).map(decl => decl.name)
  } else if (ref.type === 'interface.case') {
    values = project.bundle.info.decls
      .filter(decl => decl.type === ref.type && decl.option === ref.option)
      .map(decl => decl.name)
  } else if (ref.type === 'interface.input' && ref.offset === undefined) {
    values = project.bundle.info.decls
      .filter(decl => decl.type === ref.type && decl.option === ref.option)
      .map(decl => decl.name)
  }
  const editRange = offsetRange(document, ref.location, -1, 1)
  return [...new Set(values)].map(value => item(value, CompletionItemKind.Reference, editRange, {
    newText: escaped(value)
  }))
}

const maaVirtualKeys = [
  'none',
  'self',
  'next',
  'sub',
  'exceeded_next',
  'on_error_next',
  'reduce_other_times'
]

function maaCompletion(project, document, position, current, ref) {
  if (!['task.maa.base_task', 'task.maa.expr'].includes(ref.type)) return null
  const items = []
  const relative = current.offset - ref.location.offset - 2
  const lastChar = ref.target[relative]
  const cursor = document.offsetAt(position)
  const wordRange = () => {
    if (!/[a-zA-Z0-9_-]/.test(lastChar ?? '')) return null
    let length = 0
    let index = relative
    while (index >= 0 && /[a-zA-Z0-9_-]/.test(ref.target[index])) {
      length += 1
      index -= 1
    }
    return { start: document.positionAt(cursor - length), end: position }
  }

  if (ref.type === 'task.maa.base_task') {
    if (current.offset === ref.location.offset + 1 || /[@a-zA-Z0-9_-]/.test(lastChar ?? '')) {
      const editRange = wordRange() ?? offsetRange(document, ref.location, current.offset - ref.location.offset, 1)
      return current.layer.getTaskList().map(task => taskItem(project, task, editRange, `1_${task}`, ref.belong))
    }
    return []
  }

  const emptyRange = { start: position, end: position }
  if (current.offset === ref.location.offset + 1 || /[ @+^(a-zA-Z0-9_-]/.test(lastChar ?? '')) {
    const editRange = wordRange() ?? emptyRange
    items.push(...current.layer.getTaskList().map(task => taskItem(project, task, editRange, `1_${task}`, ref.belong)))
    if (lastChar !== '@') {
      items.push(...maaVirtualKeys.map(name => item(`#${name}`, CompletionItemKind.EnumMember, emptyRange)))
    }
  } else if (lastChar === '#') {
    items.push(...maaVirtualKeys.map(name => item(name, CompletionItemKind.EnumMember, emptyRange)))
  } else {
    items.push(...maaVirtualKeys.map(name => item(`#${name}`, CompletionItemKind.EnumMember, emptyRange)))
  }
  return items
}

export function completion(project, document, position) {
  const current = context(project, document, position)
  if (!current) return null
  if (current.interfaceRef) return interfaceCompletion(project, document, current.interfaceRef)

  const layer = current.layer
  const decls = layer.mergedDecls.filter(decl => decl.file === current.file)
  if (current.decl?.type === 'task.anchor') {
    const declared = decls
      .filter(decl => decl.type === 'task.anchor' && decl.belong === current.decl.belong)
      .map(decl => decl.anchor)
    const editRange = offsetRange(document, current.decl.location, -1, 1)
    return [...new Set(layer.getAnchorList().map(([anchor]) => anchor))]
      .filter(anchor => !declared.includes(anchor))
      .map(anchor => item(anchor, CompletionItemKind.Variable, editRange, { sortText: anchor }))
  }

  const ref = current.ref
  if (!ref) return null
  if (project.bundle.maa) return maaCompletion(project, document, position, current, ref)

  const taskRange = offsetRange(document, ref.location, -1, 1)
  const tasks = () => layer.getTaskList().map(task => taskItem(project, task, taskRange))
  const anchors = editRange => [...new Set(layer.getAnchorList().map(([anchor]) => anchor))]
    .map(anchor => item(anchor, CompletionItemKind.Variable, editRange, { sortText: anchor }))

  if ((ref.type === 'task.next' && ref.objMode) || ['task.anchor', 'task.reco', 'task.color_filter', 'task.custom_task', 'task.entry'].includes(ref.type)) {
    if (ref.type === 'task.next' && ref.attrs.attrs.Anchor) return anchors(taskRange)
    if (ref.type === 'task.color_filter') {
      return layer.getTaskList()
        .filter(task => layer.getTaskBriefInfo(task).reco === 'ColorMatch')
        .map(task => taskItem(project, task, taskRange))
    }
    return tasks()
  }

  if (ref.type === 'task.custom_anchor') return anchors(taskRange)

  if ((ref.type === 'task.next' && !ref.objMode) || ref.type === 'task.roi' || ref.type === 'task.target') {
    const editRange = offsetRange(document, ref.location, -1, 1 + ref.attrs.offset)
    const prefixRange = { start: editRange.start, end: editRange.start }
    const result = []
    if (ref.type === 'task.next' && !ref.attrs.attrs.JumpBack) {
      result.push(item('[JumpBack]', CompletionItemKind.Property, prefixRange, {
        sortText: '0_JumpBack',
        command: { title: 'trigger completion', command: 'maa-pipeline.triggerCompletion' }
      }))
    }
    if (!ref.attrs.attrs.Anchor) {
      result.push(item('[Anchor]', CompletionItemKind.Property, prefixRange, {
        sortText: '2_Anchor',
        command: { title: 'trigger completion', command: 'maa-pipeline.triggerCompletion' }
      }))
      result.push(...layer.getTaskList().map(task => taskItem(project, task, editRange)))
    } else {
      result.push(...anchors(editRange).map(entry => ({ ...entry, sortText: `1_${entry.label}` })))
    }
    if (ref.type === 'task.roi') {
      result.push(...ref.prev.map(value => item(value.value, CompletionItemKind.Reference, editRange, {
        sortText: `0_${value.value}`
      })))
    }
    return result
  }

  if (ref.type === 'task.template' || ref.type === 'task.custom_template') {
    const result = []
    for (const folder of layer.getImageFolders().keys()) {
      result.push(item(`${folder}/`, CompletionItemKind.Folder, taskRange, { sortText: `0_${folder}/` }))
    }
    for (const image of layer.getImageList()) {
      result.push(item(image, CompletionItemKind.File, taskRange, { sortText: `1_${image}` }))
    }
    return result
  }

  if (ref.type === 'task.locale') {
    const editRange = offsetRange(document, ref.location, -1, 2)
    return project.bundle.langBundle.allKeys().map(key => item(key, CompletionItemKind.Constant, editRange, {
      newText: escaped(key),
      data: { type: 'locale', root: project.root, key }
    }))
  }

  return null
}

function markdownText(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

export async function localeHover(project, key) {
  const bundle = project.bundle.langBundle
  if (bundle.langs.length === 0) return null
  const entries = bundle.queryKey(key)
  const rows = await Promise.all(entries.map(async (entry, index) => {
    const lang = bundle.langs[index]
    if (!entry) return `| ${lang?.name ?? index} | <missing> |`
    const file = path.join(project.root, lang.file)
    const source = await sourceDocument(project, file)
    const line = source.positionAt(entry.keyNode.offset).line + 1
    return `| [${lang.name}](${pathUri(file)}#L${line}) | ${markdownText(entry.value)} |`
  }))
  return `| locale | value |\n| --- | --- |\n${rows.join('\n')}`
}

export function taskBrief(project, task, current) {
  const layer = project.bundle.topLayer
  let evaluated = null
  try {
    evaluated = project.bundle.maa
      ? project.bundle.maaEvalTask(current ? `${current}@${task}` : task)?.task
      : project.bundle.evalTask(task)
  } catch {}
  if (project.bundle.maa) {
    return `Algo: ${evaluated?.algorithm ?? 'MatchTemplate'}\n\nAct: ${evaluated?.action ?? 'DoNothing'}`
  }
  const doc = layer.getTaskDoc(task)
  return [
    doc,
    `Reco: ${evaluated?.recognition ?? 'DirectHit'}`,
    `Act: ${evaluated?.action ?? 'DoNothing'}`
  ].filter(Boolean).join('\n\n')
}

function imageHover(project, layer, image) {
  const content = []
  if (!project.bundle.maa && !image.endsWith('.png')) {
    const normalized = normalizeImageFolder(image)
    for (const sourceLayer of layer.getImageFolders().get(normalized) ?? []) {
      const count = [...sourceLayer.images].filter(value => value.startsWith(`${normalized}/`)).length
      const folder = path.join(sourceLayer.root, 'image', normalized)
      content.push(`[${path.relative(project.root, folder) || '.'}](${pathUri(folder)}) — ${count} images`)
    }
  } else {
    for (const [sourceLayer, full, relative] of layer.getImage(image)) {
      const label = path.relative(project.root, sourceLayer.root) || '.'
      content.push(`${label} — [${relative}](${pathUri(full)})\n\n![](${pathUri(full)})`)
    }
  }
  return content.join('\n\n')
}

async function taskHover(project, layer, task, current) {
  if (!task) return ''
  const content = [`### ${task}`]
  const seen = new Set()
  for (const source of layer.getTask(task)) {
    for (const info of source.infos) {
      const key = `${info.file}\0${info.prop.offset}\0${info.prop.length}`
      if (seen.has(key)) continue
      seen.add(key)
      const document = await sourceDocument(project, info.file)
      const text = document.getText().slice(info.prop.offset, info.data.offset + info.data.length)
      content.push(`${path.relative(project.root, source.layer.root) || '.'}\n\n\`\`\`jsonc\n${text}\n\`\`\``)
    }
  }

  let evaluated = null
  try {
    evaluated = project.bundle.maa
      ? project.bundle.maaEvalTask(current ? `${current}@${task}` : task)?.task
      : project.bundle.evalTask(task)
  } catch {}
  if (evaluated) {
    const algorithm = project.bundle.maa
      ? evaluated.algorithm ?? 'MatchTemplate'
      : evaluated.recognition ?? 'DirectHit'
    if (['MatchTemplate', 'TemplateMatch', 'FeatureMatch'].includes(algorithm)) {
      let templates = evaluated.template
      if (typeof templates === 'string') templates = [templates]
      if (!templates && project.bundle.maa) {
        const full = current ? `${current}@${task}` : task
        templates = [`${layer.maaFindTaskDecl(full)}.png`]
      }
      for (const template of templates ?? []) {
        const image = imageHover(project, layer, template)
        if (image) content.push(image)
      }
    }
    content.push(`merged\n\n\`\`\`json\n${JSON.stringify(evaluated, null, 2)}\n\`\`\``)
  }
  return content.join('\n\n')
}

export async function resolveCompletion(project, completionItem) {
  const data = completionItem.data
  if (!data || data.root !== project.root) return completionItem
  if (data.type === 'task') {
    completionItem.documentation = { kind: MarkupKind.Markdown, value: taskBrief(project, data.task, data.current) }
  } else if (data.type === 'locale') {
    const value = await localeHover(project, data.key)
    if (value) completionItem.documentation = { kind: MarkupKind.Markdown, value }
  }
  return completionItem
}

export async function hover(project, document, position) {
  const current = context(project, document, position)
  if (!current) return null
  const locale = current.decl?.type === 'task.locale'
    ? current.decl.key
    : current.ref?.type === 'task.locale'
      ? current.ref.target
      : null
  if (locale) {
    const value = await localeHover(project, locale)
    return value ? { contents: { kind: MarkupKind.Markdown, value } } : null
  }

  if (current.decl?.type === 'task.decl') {
    if (current.isDefault) return null
    return { contents: { kind: MarkupKind.Markdown, value: await taskHover(project, project.bundle.topLayer, current.decl.task) } }
  }

  if (project.bundle.maa) {
    const task = maaTaskRef(current)
    if (task) {
      return { contents: { kind: MarkupKind.Markdown, value: await taskHover(project, project.bundle.topLayer, task.taskSuffix, current.ref?.belong) } }
    }
  }

  const task = current.ref ? extractTaskRef(current.ref) : null
  if (task) {
    return { contents: { kind: MarkupKind.Markdown, value: await taskHover(project, project.bundle.topLayer, task) } }
  }
  if (current.ref?.type === 'task.template' || current.ref?.type === 'task.custom_template') {
    const value = imageHover(project, project.bundle.topLayer, current.ref.target)
    return value ? { contents: { kind: MarkupKind.Markdown, value } } : null
  }
  return null
}

export function documentLinks(project, document) {
  const current = context(project, document, { line: 0, character: 0 })
  if (!current) return []
  const result = []
  if (current.interface) {
    for (const ref of project.bundle.info.refs.filter(item => item.file === current.file)) {
      if (['interface.language_path', 'interface.resource_path', 'interface.import_path'].includes(ref.type)) {
        result.push({ range: nodeRange(document, ref.location), target: pathUri(path.join(project.root, ref.target)) })
      }
    }
  }
  for (const ref of current.layer.mergedRefs.filter(item => item.file === current.file)) {
    if (['task.can_locale', 'task.locale_text'].includes(ref.type) && /\.(md|png)$/.test(ref.target)) {
      result.push({ range: nodeRange(document, ref.location), target: pathUri(path.join(project.bundle.topLayer.root, ref.target)) })
      continue
    }
    if (!['task.template', 'task.custom_template'].includes(ref.type)) continue
    if (!ref.target.endsWith('.png')) {
      if (project.bundle.maa) continue
      const normalized = normalizeImageFolder(ref.target)
      const sourceLayer = project.bundle.topLayer.getImageFolders().get(normalized)?.[0]
      if (sourceLayer) {
        result.push({
          range: nodeRange(document, ref.location),
          target: pathUri(path.join(sourceLayer.root, 'image', normalized))
        })
      }
      continue
    }
    const image = project.bundle.topLayer.getImage(ref.target)[0]
    if (image) result.push({ range: nodeRange(document, ref.location), target: pathUri(image[1]) })
  }
  return result
}

export function symbols(project, query) {
  const q = query.toLowerCase()
  return Promise.all(uniqueInfos(project.bundle.info.layer.mergedAllDecls)
    .filter(decl => decl.type === 'task.decl' && !decl.task.startsWith('$') && decl.task.toLowerCase().includes(q))
    .map(async decl => {
      const location = await infoLocation(project, decl)
      return {
        name: decl.task,
        kind: SymbolKind.Class,
        location,
        containerName: `${path.basename(decl.file)}:${location.range.start.line + 1}`
      }
    }))
}

function hsv2rgb(h, s, v) {
  const c = v * s
  const x = c * (1 - Math.abs((h / 60) % 2 - 1))
  const m = v - c
  let rgb = [0, 0, 0]
  if (h < 60) rgb = [c, x, 0]
  else if (h < 120) rgb = [x, c, 0]
  else if (h < 180) rgb = [0, c, x]
  else if (h < 240) rgb = [0, x, c]
  else if (h < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return rgb.map(value => (value + m) * 255)
}

export function documentColors(project, document) {
  const current = context(project, document, { line: 0, character: 0 })
  if (!current) return []
  return current.layer.mergedRefs
    .filter(ref => ref.file === current.file && ref.type === 'task.color')
    .map(ref => {
      const rgb = ref.method === 'hsv'
        ? hsv2rgb(ref.color[0], ref.color[1], ref.color[2])
        : ref.color
      return {
        range: nodeRange(document, ref.location),
        color: {
          red: rgb[0] / 255,
          green: rgb[1] / 255,
          blue: rgb[2] / 255,
          alpha: 1
        }
      }
    })
}

export function syntaxDiagnostics(document, parse, printParseErrorCode) {
  const errors = []
  parse(document.getText(), errors, { allowTrailingComma: true, disallowComments: false })
  return errors.map(error => ({
    range: range(document, error.offset, Math.max(error.length, 1)),
    severity: DiagnosticSeverity.Error,
    source: 'maa-pipeline',
    code: `json-${error.error}`,
    message: printParseErrorCode(error.error)
  }))
}
