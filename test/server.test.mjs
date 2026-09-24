import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { completion, definition, nodeRange, syntaxDiagnostics, textDocument } from '../server/features.mjs'
import { parse, printParseErrorCode } from 'jsonc-parser'
import { codeActions, codeLenses } from '../server/interactive.mjs'
import { MaaProject, normalizePath, pathUri } from '../server/project.mjs'

test('converts upstream parser offsets to LSP ranges', () => {
  const document = textDocument('/tmp/pipeline.jsonc', '{\n  "Task": {}\n}\n')
  assert.deepEqual(nodeRange(document, { offset: 4, length: 6 }), {
    start: { line: 1, character: 2 },
    end: { line: 1, character: 8 }
  })
})

test('normalizes project paths and emits file URIs', () => {
  const file = normalizePath('/tmp/maa/../maa/project.json')
  assert.equal(file, '/tmp/maa/project.json')
  assert.equal(pathUri(file), 'file:///tmp/maa/project.json')
})

test('treats every supported file extension as JSONC', () => {
  const document = textDocument('/tmp/pipeline.json', '{\n  // comment\n  "Task": {},\n}\n')
  assert.equal(document.languageId, 'jsonc')
  assert.deepEqual(syntaxDiagnostics(document, parse, printParseErrorCode), [])
})

test('uses the upstream manager for MaaFramework language features', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maa-pipeline-test-'))
  const pipelineDir = path.join(root, 'resource', 'pipeline')
  await mkdir(path.join(root, 'config'), { recursive: true })
  await mkdir(pipelineDir, { recursive: true })
  await writeFile(path.join(root, 'interface.json'), JSON.stringify({
    controller: [{ name: 'Default', attach_resource_path: ['resource'] }],
    resource: [{ name: 'Default', path: ['resource'] }],
    task: [{ name: 'Run', entry: 'Start' }]
  }))
  await writeFile(path.join(root, 'config', 'maa_pi_config.json'), JSON.stringify({
    controller: 'Default',
    resource: 'Default'
  }))
  const file = path.join(pipelineDir, 'main.json')
  const source = '{\n  "Start": { "next": ["End"] },\n  "End": {}\n}\n'
  await writeFile(file, source)

  const project = new MaaProject({
    root,
    interfaceFile: path.join(root, 'interface.json'),
    mode: 'framework'
  })
  t.after(async () => {
    await project.stop()
    await rm(root, { recursive: true, force: true })
  })
  await project.init()

  const document = textDocument(file, source)
  const offset = source.indexOf('"End"') + 2
  const position = document.positionAt(offset)
  assert.deepEqual(project.bundle.topLayer.getTaskList(), ['Start', 'End'])
  assert.ok(completion(project, document, position).some(item => item.label === 'End'))
  assert.equal((await definition(project, document, position)).length, 1)
  assert.deepEqual(codeLenses(project, document).map(item => item.command.command), [
    'maa-pipeline.showReferences',
    'maa-pipeline.showReferences'
  ])
  const actionPosition = document.positionAt(source.indexOf('"Start"') + 2)
  assert.equal(codeActions(project, document, { start: actionPosition, end: actionPosition })[0].command.command, 'maa-pipeline.runTask')
})
