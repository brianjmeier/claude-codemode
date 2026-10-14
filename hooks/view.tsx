import type { EngineInterface, RenderInput } from 'claude-code'
import type { NestedCall, Outcome, Run } from '../types'

const CODE_LINES = 6
const RESULT_LINES = 4

const MARK = {
  running: { glyph: '…', color: 'inactive' },
  done: { glyph: '✓', color: 'success' },
  failed: { glyph: '✗', color: 'error' },
} as const

const DOT = { running: 'inactive', returned: 'success', failed: 'error' } as const

const duration = (ms: number): string => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

const head = (text: string, count: number) => {
  const lines = text.split('\n')
  return { shown: lines.slice(0, count), hidden: Math.max(0, lines.length - count) }
}

const tail = (text: string, count: number) => {
  const lines = text.split('\n')
  return { shown: lines.slice(-count), hidden: Math.max(0, lines.length - count) }
}

const markOf = (call: NestedCall) => (call.status === 'denied' ? MARK.failed : MARK[call.status])

const settledAs = (call: NestedCall): string => {
  if (call.status === 'done' || call.status === 'failed') return ` ${duration(call.ms)}`
  return call.status === 'denied' ? ' denied' : ''
}

const answerOf = (outcome: Outcome) => {
  if (outcome.kind === 'returned') return head(outcome.text, RESULT_LINES)
  if (outcome.kind === 'failed') return head(outcome.reason, RESULT_LINES)
  return null
}

const outcomeOf = (props: RenderInput<'ToolUse'>['props'], run: Run): Outcome => {
  if (props.isRunning || run.outcome.kind !== 'running' || props.output === undefined) return run.outcome
  const text = typeof props.output === 'string' ? props.output : JSON.stringify(props.output)
  return props.isErrored ? { kind: 'failed', reason: text } : { kind: 'returned', text }
}

export type Program = { kind: 'typing' | 'written'; code: string }

export function drawRun($: EngineInterface, e: RenderInput<'ToolUse'>, source: Program, run: Run) {
  const { Box, Text, Code } = $.ui.resolve(e)
  const outcome = outcomeOf(e.props, run)
  const isTyping = source.kind === 'typing'
  const program = isTyping ? tail(source.code, CODE_LINES) : head(source.code.trim(), CODE_LINES)
  const answer = answerOf(outcome)

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={DOT[outcome.kind]}>⏺ </Text>
        <Text weight="bold">codemode</Text>
        {run.calls.length > 0 && <Text dimColor>{` · ${plural(run.calls.length, 'call')}`}</Text>}
        {run.elapsedMs !== null && <Text dimColor>{` · ${duration(run.elapsedMs)}`}</Text>}
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {isTyping && program.hidden > 0 && <Text dimColor>… {plural(program.hidden, 'line')} above</Text>}
        <Code source={`${program.shown.join('\n')}${isTyping ? '▌' : ''}`} language="javascript" wrap="truncate-end" />
        {!isTyping && program.hidden > 0 && <Text dimColor>… {plural(program.hidden, 'more line')}</Text>}
      </Box>
      {run.calls.length > 0 && (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          {run.calls.map(call => (
            <Text wrap="truncate-end">
              <Text color={markOf(call).color}>{markOf(call).glyph} </Text>
              <Text weight="bold">{call.tool}</Text>
              <Text>{` ${call.summary}`}</Text>
              <Text dimColor>{settledAs(call)}</Text>
            </Text>
          ))}
        </Box>
      )}
      {answer !== null && (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          {answer.shown.map(line => (
            <Text wrap="truncate-end" color={outcome.kind === 'failed' ? 'error' : 'text'}>
              {line}
            </Text>
          ))}
          {answer.hidden > 0 && <Text dimColor>… {plural(answer.hidden, 'more line')}</Text>}
        </Box>
      )}
    </Box>
  )
}

