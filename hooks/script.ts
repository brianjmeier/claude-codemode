import Sval from './vendor/sval.js'
import type { NestedCall, Run } from '../types'

type ToolAnswer = { text: string; result: unknown; isError: boolean }

export type HostAnswer =
  | { kind: 'denied'; reason: string }
  | { kind: 'started'; agentId: string }
  | ({ kind: 'answered' } & ToolAnswer)

export type AgentAsk = { type: string; prompt: string }

export type ModelAsk = { model: string; prompt: string }

export type ToolHost = {
  call: (tool: string, args: Record<string, unknown>) => Promise<HostAnswer>
  agent: (ask: AgentAsk) => Promise<HostAnswer>
  ask: (ask: ModelAsk) => Promise<HostAnswer>
  list: () => Promise<readonly { name: string; description: string }[]>
  check: (tool: string, args: Record<string, unknown>) => Promise<'allow' | 'ask' | 'deny'>
  cwd: () => Promise<string>
  now: () => Promise<number>
  publish: (run: Run) => Promise<void>
}

export const SAVED_CODE_TOOL = 'mcp__tend__code_get'

export class ToolDenied extends Error {
  constructor(
    readonly tool: string,
    readonly reason: string,
  ) {
    super(`${tool} was denied: ${reason}`)
    this.name = 'ToolDenied'
  }
}

const SUMMARY_KEYS = ['command', 'file_path', 'pattern', 'path', 'url', 'query', 'description']
const SUMMARY_LENGTH = 120

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_LENGTH)

const summaryOf = (args: Record<string, unknown>, root: string): string => {
  const key = SUMMARY_KEYS.find(name => typeof args[name] === 'string')
  return oneLine((key === undefined ? JSON.stringify(args) : String(args[key])).replaceAll(`${root}/`, ''))
}

const describe = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))

const counted = (calls: readonly NestedCall[]): string => {
  const counts = new Map<string, number>()
  for (const { tool } of calls) counts.set(tool, (counts.get(tool) ?? 0) + 1)
  return [...counts].map(([name, n]) => (n === 1 ? name : `${name} ×${n}`)).join(', ')
}

const headOf = (run: Run): string => {
  if (run.outcome.kind === 'returned') return run.outcome.text
  if (run.outcome.kind === 'failed') return `The program failed: ${run.outcome.reason}`
  return '(still running)'
}

export const report = (run: Run): string =>
  [
    headOf(run),
    run.logs.length === 0 ? '' : `log:\n${run.logs.join('\n')}`,
    run.calls.length === 0 ? '' : `tool calls: ${counted(run.calls)}`,
  ]
    .filter(part => part !== '')
    .join('\n\n')

export async function runScript(code: string, host: ToolHost): Promise<Run> {
  const startedAt = await host.now()
  const root = await host.cwd()
  let run: Run = { calls: [], logs: [], outcome: { kind: 'running' }, elapsedMs: null }
  const change = (next: Run) => {
    run = next
    return host.publish(run)
  }
  const settle = (index: number, call: NestedCall) =>
    change({ ...run, calls: run.calls.map((one, i) => (i === index ? call : one)) })

  const record = async (name: string, summary: string, answerOf: () => Promise<HostAnswer>) => {
    const callStartedAt = await host.now()
    const index = run.calls.length
    await change({ ...run, calls: [...run.calls, { tool: name, summary, status: 'running' }] })
    const answer = await answerOf()
    if (answer.kind === 'denied') {
      await settle(index, { tool: name, summary, status: 'denied' })
      throw new ToolDenied(name, answer.reason)
    }
    if (answer.kind === 'started') {
      await settle(index, { tool: name, summary, status: 'started' })
      return answer
    }
    const ms = (await host.now()) - callStartedAt
    await settle(index, { tool: name, summary, status: answer.isError ? 'failed' : 'done', ms })
    return answer
  }

  const tool = async (name: string, args: Record<string, unknown>) => {
    const answer = await record(name, summaryOf(args, root), () => host.call(name, args))
    return answer.kind === 'answered' ? { text: answer.text, result: answer.result, isError: answer.isError } : answer
  }
  const agent = async (ask: AgentAsk) => {
    const answer = await record(ask.type, oneLine(ask.prompt), () => host.agent(ask))
    return answer.kind === 'started' ? { agentId: answer.agentId } : answer
  }
  const ask = async (question: ModelAsk) => {
    const answer = await record(`ask ${question.model}`, oneLine(question.prompt), () => host.ask(question))
    if (answer.kind === 'answered' && answer.isError) throw new Error(`ask ${question.model} failed: ${answer.text}`)
    return answer.kind === 'answered' ? answer.text : ''
  }
  const tools = new Proxy(
    {},
    { get: (_, name) => (args: Record<string, unknown>) => tool(String(name), args) },
  )

  const interpreter = new Sval({ ecmaVer: 'latest', sandBox: true })
  const exported = interpreter.exports as Record<string, unknown>
  let savedRuns = 0
  const saved = async (name: string, args: unknown) => {
    const answer = (await tool(SAVED_CODE_TOOL, { name })) as ToolAnswer
    if (answer.isError) throw new Error(`saved code "${name}" could not be read: ${answer.text}`)
    const { source } = JSON.parse(answer.text) as { source: string }
    const slot = `saved${savedRuns++}`
    interpreter.run(`exports.${slot} = (\n${source}\n)`)
    const program = exported[slot] as (tools: unknown, args: unknown) => unknown
    delete exported[slot]
    return program(tools, args)
  }
  interpreter.import({
    tool,
    tools,
    saved,
    agent,
    ask,
    listTools: host.list,
    canCall: host.check,
    cwd: host.cwd,
    log: (...parts: unknown[]) => void change({ ...run, logs: [...run.logs, parts.map(describe).join(' ')] }),
    ToolDenied,
  })

  let outcome: Run['outcome']
  try {
    interpreter.run(`exports.run = (async () => {\n${code}\n})()`)
    const value: unknown = await (interpreter.exports as { run: Promise<unknown> }).run
    outcome = { kind: 'returned', text: value === undefined ? '(no value returned)' : describe(value) }
  } catch (error) {
    outcome = { kind: 'failed', reason: error instanceof Error ? `${error.name}: ${error.message}` : describe(error) }
  }
  await change({ ...run, outcome, elapsedMs: (await host.now()) - startedAt })
  return run
}
