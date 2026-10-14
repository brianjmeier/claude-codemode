import { atom, memberOf, read } from 'claude-code'
import type { EngineInterface, Register, ToolCallArgs } from 'claude-code'
import type { Run } from '../types'
import { report, runScript, type ToolHost } from './script'
import { codeSoFar } from './typing'
import { drawRun, type Program } from './view'

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
- \`await ask({ model: "haiku", prompt: "..." })\` asks a model one question with no tools and resolves its answer as text; hand it the text it needs. Several can run at once with \`Promise.all\`. Start each prompt with what differs (\`prs: summarize…\`): the person sees the first words of every call.
- \`await agent({ type: "Explore", prompt: "..." })\` starts a subagent and resolves \`{ agentId }\` at once; its answer reaches you as a normal subagent hand-back, not the program.
- \`await listTools()\` returns \`[{ name, description }]\`.
- \`await canCall(name, args)\` returns \`"allow"\`, \`"ask"\` or \`"deny"\`: what the permission check would decide, without running anything.
- \`await cwd()\` returns the session's working directory, for absolute paths.
- \`log(...values)\` adds a line to the output.
- \`return\` the value you want back; objects come back as JSON.

Every call goes through the same permission check, hooks and dialog as if you had made it directly. The program has no filesystem, network, process, imports or eval of its own: side effects happen only through tools.`

const runs = atom({ plugin: 'codemode', key: 'runs' } as const, {
  calls: [],
  logs: [],
  outcome: { kind: 'running' },
  elapsedMs: null,
} as Run)

const typed = atom({ plugin: 'codemode', key: 'typed' } as const, '')

const hostOf = ($: EngineInterface, requestId: string): ToolHost => ({
  call: async (tool, args) => {
    if (tool === TOOL) return { kind: 'denied', reason: 'a program cannot start another program' }
    const answer = await $.tool.call({ ...args, tool } as ToolCallArgs)
    if (answer.deny !== undefined) return { kind: 'denied', reason: answer.deny }
    return { kind: 'answered', text: answer.text ?? '', result: answer.result, isError: answer.isError === true }
  },
  agent: async ({ type, prompt }) => {
    const spawned = await $.agent.spawn({ prompt, subagentType: type, description: prompt.slice(0, 40) })
    if (spawned.deny !== undefined) return { kind: 'denied', reason: spawned.deny }
    if (spawned.agentId === undefined) return { kind: 'denied', reason: `the ${type} subagent did not start` }
    return { kind: 'started', agentId: spawned.agentId }
  },
  ask: async ({ model, prompt }) => {
    const answer = await $.model.complete({ model, prompt })
    if (answer.isAnswered) return { kind: 'answered', text: answer.text, result: answer.text, isError: false }
    return { kind: 'answered', text: answer.reason, result: answer.reason, isError: true }
  },
  list: async () =>
    (await $.tool.list())
      .filter(info => info.name !== TOOL)
      .map(({ name, description }) => ({ name, description })),
  check: async (tool, args) => (await $.tool.check({ tool, input: args })).decision,
  cwd: () => $.session.cwd(),
  now: () => $.clock.now(),
  publish: async run => {
    await $.state.set({ plugin: 'codemode', key: 'runs', id: requestId }, run)
  },
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
    const run = await runScript(e.code, hostOf($, e.tool_use_id))
    return run.outcome.kind === 'failed' ? { deny: report(run) } : { result: report(run) }
  }).catch(($, e, next) => ({
    deny: `codemode: the program runner itself failed (${next.error.message ?? next.error.kind}); nothing more ran.`,
  }))

  on('turn.step', async function* ($, e, next) {
    const ours = new Map<number, { id: string; json: string; code: string }>()
    for await (const chunk of next(e)) {
      if (chunk.kind === 'tool' && chunk.name === TOOL) ours.set(chunk.index, { id: chunk.id, json: '', code: '' })
      const call = chunk.kind === 'input' ? ours.get(chunk.index) : undefined
      if (call !== undefined && chunk.kind === 'input') {
        call.json += chunk.json
        const code = codeSoFar(call.json)
        if (code !== call.code) {
          call.code = code
          await $.state.set({ plugin: 'codemode', key: 'typed', id: call.id }, code)
        }
      }
      yield chunk
    }
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== TOOL) return next(e)
    const { code } = e.props.input as Partial<{ code: string }>
    const program: Program =
      code === undefined ? { kind: 'typing', code: await read($, memberOf(typed, e)) } : { kind: 'written', code }
    return drawRun($, e, program, await read($, memberOf(runs, e)))
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.tool !== TOOL) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}
