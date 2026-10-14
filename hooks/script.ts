import Sval from './vendor/sval.js'

type ToolAnswer = { text: string; result: unknown; isError: boolean }

export type ToolHost = {
  call: (tool: string, args: Record<string, unknown>) => Promise<ToolAnswer>
  list: () => Promise<readonly { name: string; description: string }[]>
}

type Trace = { logs: readonly string[]; calls: readonly string[] }

export class ScriptFailed extends Error {
  constructor(
    readonly reason: string,
    readonly trace: Trace,
  ) {
    super(reason)
  }
}

export class ToolDenied extends Error {
  constructor(
    readonly tool: string,
    readonly reason: string,
  ) {
    super(`${tool} was denied: ${reason}`)
    this.name = 'ToolDenied'
  }
}

const describe = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))

const counted = (calls: readonly string[]): string => {
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call, (counts.get(call) ?? 0) + 1)
  return [...counts].map(([name, n]) => (n === 1 ? name : `${name} ×${n}`)).join(', ')
}

export const report = (head: string, trace: Trace): string =>
  [
    head,
    trace.logs.length === 0 ? '' : `log:\n${trace.logs.join('\n')}`,
    trace.calls.length === 0 ? '' : `tool calls: ${counted(trace.calls)}`,
  ]
    .filter(part => part !== '')
    .join('\n\n')

export async function runScript(code: string, host: ToolHost): Promise<string> {
  const logs: string[] = []
  const calls: string[] = []
  const trace = { logs, calls }

  const tool = (name: string, args: Record<string, unknown>) => {
    calls.push(name)
    return host.call(name, args)
  }
  const tools = new Proxy(
    {},
    { get: (_, name) => (args: Record<string, unknown>) => tool(String(name), args) },
  )

  const interpreter = new Sval({ ecmaVer: 'latest', sandBox: true })
  interpreter.import({
    tool,
    tools,
    listTools: host.list,
    log: (...parts: unknown[]) => void logs.push(parts.map(describe).join(' ')),
    ToolDenied,
  })

  try {
    interpreter.run(`exports.run = (async () => {\n${code}\n})()`)
    const value: unknown = await (interpreter.exports as { run: Promise<unknown> }).run
    return report(value === undefined ? '(no value returned)' : describe(value), trace)
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : describe(error)
    throw new ScriptFailed(reason, trace)
  }
}
