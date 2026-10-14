export type NestedCall =
  | { tool: string; summary: string; status: 'running' | 'denied' }
  | { tool: string; summary: string; status: 'done' | 'failed'; ms: number }

export type Outcome = { kind: 'running' } | { kind: 'returned'; text: string } | { kind: 'failed'; reason: string }

export type Run = {
  calls: readonly NestedCall[]
  logs: readonly string[]
  outcome: Outcome
  elapsedMs: number | null
}

declare module 'claude-code' {
  interface PluginState {
    codemode: { runs: StateFamily<Run> }
  }
}
