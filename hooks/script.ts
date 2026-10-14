import Sval from './vendor/sval.js'

export type ToolAnswer = { text: string; result: unknown; isError: boolean }

export type ToolHost = {
  call: (tool: string, args: Record<string, unknown>) => Promise<ToolAnswer>
  list: () => Promise<readonly { name: string; description: string }[]>
}

export type ScriptRun = {
  value: unknown
  logs: readonly string[]
  calls: readonly string[]
}

export class ScriptFailed extends Error {
  constructor(
    readonly reason: string,
    readonly logs: readonly string[],
    readonly calls: readonly string[],
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

export async function runScript(code: string, host: ToolHost): Promise<ScriptRun> {
  const logs: string[] = []
  const calls: string[] = []

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
    return { value, logs, calls }
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : describe(error)
    throw new ScriptFailed(reason, logs, calls)
  }
}
