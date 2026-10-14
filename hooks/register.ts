import type { EngineInterface, Register, ToolCallArgs } from 'claude-code'
import { report, runScript, ScriptFailed, ToolDenied, type ToolHost } from './script.ts'

declare module 'claude-code' {
  interface McpToolInputs {
    mcp__codemode__run: { code: string }
  }
}

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
      name: 'run',
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
    try {
      return { result: await runScript(e.code, hostOf($)) }
    } catch (error) {
      if (error instanceof ScriptFailed) return { deny: report(`The program failed: ${error.reason}`, error.trace) }
      throw error
    }
  }).catch(() => ({ deny: 'codemode: the program runner itself failed; nothing more ran.' }))
}
