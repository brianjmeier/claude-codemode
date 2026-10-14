import type { EngineInterface, Register, ToolCallArgs } from 'claude-code'
import { runScript, ScriptFailed, ToolDenied, type ScriptRun, type ToolHost } from './script.ts'

export const TOOL_NAME = 'run'
export const TOOL = 'mcp__codemode__run'

const DESCRIPTION = `Run one JavaScript program that calls Claude Code's own tools and returns only its final value.

Use it to loop, branch, filter and aggregate over many tool calls without each raw result entering the conversation.

The program is the body of an async function:
- \`await tool("Read", { file_path: "README.md" })\` calls any tool you can call, by name, with its usual arguments.
- \`await tools.Grep({ pattern: "TODO" })\` is the same call for names that are valid property names.
- Each call resolves \`{ text, result, isError }\`: \`text\` is what you would have read, \`result\` the tool's structured record (Read: \`result.file.content\`; Bash: \`result.stdout\`, \`result.stderr\`). A tool that fails resolves with \`isError: true\`.
- A call the permission check refuses throws \`ToolDenied\` (\`e.tool\`, \`e.reason\`).
- \`await listTools()\` returns \`[{ name, description }]\`.
- \`log(...values)\` adds a line to the output.
- \`return\` the value you want back; objects come back as JSON.

Every call goes through the same permission check, hooks and dialog as if you had made it directly. The program has no filesystem, network, process, imports or eval of its own: side effects happen only through tools.`

const counted = (calls: readonly string[]): string => {
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call, (counts.get(call) ?? 0) + 1)
  return [...counts].map(([name, n]) => (n === 1 ? name : `${name} ×${n}`)).join(', ')
}

const show = (value: unknown): string =>
  value === undefined ? '(no value returned)' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)

export const report = (run: Pick<ScriptRun, 'logs' | 'calls'>, head: string): string =>
  [
    head,
    run.logs.length === 0 ? '' : `log:\n${run.logs.join('\n')}`,
    run.calls.length === 0 ? '' : `tool calls: ${counted(run.calls)}`,
  ]
    .filter(part => part !== '')
    .join('\n\n')

const hostOf = ($: EngineInterface): ToolHost => ({
  call: async (tool, args) => {
    if (tool === TOOL) throw new ToolDenied(tool, 'a program cannot start another program')
    const answer = await $.tool.call({ ...args, tool } as ToolCallArgs)
    if (answer.deny !== undefined) throw new ToolDenied(tool, answer.deny)
    return { text: answer.text ?? '', result: answer.result, isError: answer.isError === true }
  },
  list: async () =>
    (await $.tool.list())
      .filter(info => info.name !== TOOL)
      .map(({ name, description }) => ({ name, description })),
})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL_NAME,
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: { code: { type: 'string', description: 'The body of an async function. `return` the final value.' } },
        required: ['code'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const { code } = e as unknown as { code: string }
    try {
      const run = await runScript(code, hostOf($))
      return { result: report(run, show(run.value)) }
    } catch (error) {
      if (error instanceof ScriptFailed) return { deny: report(error, `The program failed: ${error.reason}`) }
      throw error
    }
  }).catch(() => ({ deny: 'codemode: the program runner itself failed; nothing more ran.' }))
}
