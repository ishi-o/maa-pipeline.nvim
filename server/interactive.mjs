import path from 'node:path'

import { CodeActionKind } from 'vscode-languageserver/node'
import { modify } from 'jsonc-parser'
import { t } from '@nekosu/maa-locale'
import { extractTaskRef } from '@nekosu/maa-pipeline-manager'

import { context, nodeRange, sourceDocument, textDocument } from './features.mjs'
import { fileUriPath, pathUri } from './project.mjs'

export const commands = {
  noop: 'maa-pipeline.noop',
  triggerCompletion: 'maa-pipeline.triggerCompletion',
  showReferences: 'maa-pipeline.showReferences',
  evaluateTask: 'maa-pipeline.evaluateTask',
  launchTask: 'maa-pipeline.launchTask',
  switchConfig: 'maa-pipeline.switchConfig',
  extractLocale: 'maa-pipeline.extractLocale'
}

export const notifications = {
  triggerCompletion: 'maa-pipeline/triggerCompletion',
  showReferences: 'maa-pipeline/showReferences',
  showText: 'maa-pipeline/showText',
  launchTask: 'maa-pipeline/launchTask',
  requestInput: 'maa-pipeline/requestInput'
}

function lens(range, title, command = commands.noop, args = []) {
  return { range, command: { title, command, arguments: args } }
}

export function codeLenses(project, document) {
  const file = fileUriPath(document.uri)
  if (!file) return []
  const located = project.bundle.locateLayer(file)
  if (!located) return []
  const [layer, normalizedFile, isDefault] = located
  const result = []

  for (const decl of project.bundle.info.decls.filter(info => info.file === normalizedFile)) {
    const range = nodeRange(document, decl.location)
    if (decl.type === 'interface.resource') {
      const active = decl.name === project.resource
      const disabled = decl.controller && !decl.controller.includes(project.controller)
      if (active) result.push(lens(range, t('maa.pipeline.codelens.resource-activated')))
      else if (disabled) result.push(lens(range, t('maa.pipeline.codelens.resource-disabled')))
      else result.push(lens(range, t('maa.pipeline.codelens.resource-switch'), commands.switchConfig, [project.root, 'resource', decl.name]))
    } else if (decl.type === 'interface.language') {
      const active = decl.name === project.locale
      if (active) result.push(lens(range, t('maa.pipeline.codelens.language-activated')))
      else result.push(lens(range, t('maa.pipeline.codelens.language-switch'), commands.switchConfig, [project.root, '__locale', decl.name]))
    }
  }

  if (isDefault) return result
  const counts = new Map()
  const counted = new Set()
  for (const ref of project.bundle.topLayer.mergedAllRefs) {
    const task = extractTaskRef(ref)
    const key = task && `${task}\0${ref.file}\0${ref.location.offset}\0${ref.location.length}`
    if (task && !counted.has(key)) {
      counted.add(key)
      counts.set(task, (counts.get(task) ?? 0) + 1)
    }
  }
  for (const [task, infos] of Object.entries(layer.tasks)) {
    for (const info of infos) {
      if (info.file !== normalizedFile) continue
      const range = nodeRange(document, info.prop)
      const position = document.positionAt(info.prop.offset + 1)
      if (project.bundle.maa) {
        result.push(lens(range, t('maa.pipeline.codelens.eval-task'), commands.evaluateTask, [project.root, task]))
      } else {
        result.push(lens(range, t('maa.pipeline.codelens.launch'), commands.launchTask, [project.root, task]))
        result.push(lens(range, t('maa.pipeline.codelens.refs', `${counts.get(task) ?? 0}`), commands.showReferences, [project.root, document.uri, position]))
      }
    }
  }
  return result
}

export function inlayHints(project, document, requestedRange) {
  const current = context(project, document, requestedRange.start)
  if (!current) return []
  const begin = document.offsetAt(requestedRange.start)
  const end = document.offsetAt(requestedRange.end)
  const refs = current.layer.mergedRefs.filter(ref =>
    ref.file === current.file &&
    ref.location.offset >= begin &&
    ref.location.offset + ref.location.length <= end
  )
  const result = []
  const preferred = project.bundle.langBundle.queryName(project.locale)
  for (const ref of refs) {
    const position = document.positionAt(ref.location.offset + ref.location.length)
    if (ref.type === 'task.locale') {
      const entry = project.bundle.langBundle.queryKey(ref.target)[preferred]
      if (entry) result.push({ position, label: entry.value })
    }
    const task = extractTaskRef(ref)
    if (task) {
      const doc = current.layer.getTaskDoc(task)
      if (doc) result.push({ position, label: doc })
    }
  }
  return result
}

export function codeActions(project, document, requestedRange) {
  const file = fileUriPath(document.uri)
  if (!file) return []
  const located = project.bundle.locateLayer(file)
  if (!located) return []
  const [layer, normalizedFile] = located
  const begin = document.offsetAt(requestedRange.start)
  const end = document.offsetAt(requestedRange.end)
  const ref = layer.mergedRefs.find(info =>
    info.file === normalizedFile &&
    info.type === 'task.can_locale' &&
    info.location.offset <= end &&
    info.location.offset + info.location.length >= begin
  )
  if (!ref) return []
  const title = t('maa.pipeline.codeaction.extract-locale')
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
  }]
}

export async function localeWorkspaceEdit(project, request, key) {
  if (!key || project.bundle.langBundle.allKeys().includes(key)) return null
  const sourceFile = fileUriPath(request.uri)
  if (!sourceFile) return null
  const documentChanges = []
  const source = await sourceDocument(project, sourceFile)
  documentChanges.push({
    textDocument: { uri: request.uri, version: null },
    edits: [{
      range: {
        start: source.positionAt(request.offset),
        end: source.positionAt(request.offset + request.length)
      },
      newText: JSON.stringify(`$${key}`)
    }]
  })
  for (const action of project.bundle.langBundle.addPair(key, request.value)) {
    const uri = pathUri(action.file)
    if (action.type === 'replace') {
      const document = textDocument(action.file, '')
      documentChanges.push({ kind: 'create', uri, options: { overwrite: true } })
      documentChanges.push({
        textDocument: { uri, version: null },
        edits: [{
          range: { start: document.positionAt(0), end: document.positionAt(document.getText().length) },
          newText: action.content
        }]
      })
    } else {
      const document = await sourceDocument(project, action.file)
      const position = document.positionAt(action.offset)
      documentChanges.push({
        textDocument: { uri, version: null },
        edits: [{ range: { start: position, end: position }, newText: action.content }]
      })
    }
  }
  return { documentChanges }
}

export async function configWorkspaceEdit(project, key, value) {
  const file = path.join(project.root, 'config', 'maa_pi_config.json')
  const previous = await project.loader.get(file)
  const text = previous ?? '{}\n'
  const document = textDocument(file, text)
  const edits = modify(text, [key], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' }
  }).map(edit => ({
    range: {
      start: document.positionAt(edit.offset),
      end: document.positionAt(edit.offset + edit.length)
    },
    newText: edit.content
  }))
  const uri = pathUri(file)
  return previous === undefined
    ? {
        documentChanges: [
          { kind: 'create', uri },
          { textDocument: { uri, version: null }, edits }
        ]
      }
    : { changes: { [uri]: edits } }
}

export function evaluatedTask(project, task) {
  const value = project.bundle.maa
    ? project.bundle.maaEvalTask(task)?.task
    : project.bundle.evalTask(task)
  return value ? JSON.stringify(value, null, 2) : null
}
