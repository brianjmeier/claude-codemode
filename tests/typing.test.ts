import { test, expect } from 'claude-code/testing'
import { TOOL } from '../hooks/register'
import { codeSoFar } from '../hooks/typing'

test('the code so far is read out of partial JSON, escapes and all', async () => {
  expect(codeSoFar('{"co')).toBe('')
  expect(codeSoFar('{"code": "const a')).toBe('const a')
  expect(codeSoFar('{"code":"line one\\nline two\\t\\"quoted\\"')).toBe('line one\nline two\t"quoted"')
  expect(codeSoFar('{"code":"half an escape \\')).toBe('half an escape ')
  expect(codeSoFar('{"code":"\\u00e9 then \\u00')).toBe('é then ')
  expect(codeSoFar('{"code":"done"}')).toBe('done')
})

test('the row types the program out as the model writes it', async ($, on) => {
  const pieces = ['{"code": "const files', ' = await tools.Glob(', '{ pattern: \\"*.ts\\" })\\nreturn']
  on('turn.step', async function* () {
    yield { kind: 'tool', index: 0, id: 'typing-1', name: TOOL }
    for (const json of pieces) yield { kind: 'input', index: 0, json }
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: null }
  })

  for await (const chunk of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })) void chunk

  const ui = await $.ui.mount({
    plugin: 'codemode',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'typing-1',
    props: { tool_use_id: 'typing-1', tool: TOOL, input: {}, isRunning: false, isErrored: false, isInterrupted: false },
  })

  expect((await ui.find({ type: 'Box' }))?.text).toContain('const files = await tools.Glob({ pattern: "*.ts" })\nreturn▌')
  await ui.unmount()
})
