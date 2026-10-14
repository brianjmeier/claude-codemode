---
name: codemode
description: When and how to use the codemode `run` tool (mcp__codemode__run) — one JavaScript program that calls Claude Code's own tools in loops and branches and returns only the final value. Use when a task needs many similar tool calls (read N files, grep then read each hit, check every package), when raw tool output would flood the context and only a summary matters, or when the next call depends on the last one's result in a way a short program states better than a chain of turns.
---

# Code mode

`mcp__codemode__run` takes one JavaScript program and runs it. The program
calls the same tools you can call, each through the same permission check, and
only what it `return`s (plus its `log` lines and a count of the calls) comes
back into the conversation.

## When to reach for it

Use it when **the work is a loop or a filter over tool results**:

- the same call over many inputs: read 30 files and count something, run `git log` per package
- a search followed by a read of each hit, keeping only what matches
- aggregation: sizes, counts, tables, the five worst offenders
- a chain where call N+1 is decided by call N's result, and every step is mechanical

Call tools directly instead when:

- it is one or two calls — a program adds nothing
- you need to *read and think* about each result; the program cannot judge, you can
- the step is an edit you want the person to see as its own diff — make Edit/Write calls yourself
- a call will prompt for permission each time; a loop of prompts is worse than one Bash

## The program

The tool's own description lists what the program has (`tool`, `tools.Name`,
`listTools`, `log`, `ToolDenied`) and what each call resolves to. Two choices
it leaves to you:

- A tool that fails resolves with `isError: true`; a permission refusal
  **throws** `ToolDenied`. Catch it when the loop should go on without that
  item; leave it uncaught when the whole run should stop.
- `result` shapes differ per tool. Beyond `Read` and `Bash`, read `text`, or
  `return` one `result` once to see its shape.
- `ask()` or `agent()`: `ask({ model: "haiku", prompt })` answers inside the
  program, from the text you put in the prompt, with no tools, so read the
  files first and hand it their contents. `agent({ type, prompt })` starts a
  real subagent with tools, but its answer comes back to you later as a
  hand-back, never to the program: use it to kick off work, not to aggregate.
- Before a loop of calls that might prompt the person, `canCall(name, args)`
  says `allow`, `ask` or `deny` without running anything; skip or batch rather
  than stack up dialogs. `cwd()` gives the working directory for absolute paths.

## Patterns

Count matches across files, return only the table:

```js
const listed = await tools.Bash({ command: "rg --files -g '*.ts' src" })
const rows = []
for (const file of listed.result.stdout.split("\n").filter(Boolean)) {
  const { result } = await tools.Read({ file_path: file })
  const todos = result.file.content.split("\n").filter(line => line.includes("TODO")).length
  if (todos > 0) rows.push({ file, todos })
}
return rows.sort((a, b) => b.todos - a.todos).slice(0, 10)
```

Keep going past refusals, and say what was skipped:

```js
const out = []
for (const pkg of ["api", "web", "worker"]) {
  try {
    const run = await tools.Bash({ command: `git -C packages/${pkg} log -1 --format=%cr` })
    out.push(`${pkg}: ${run.result.stdout.trim()}`)
  } catch (error) {
    if (!(error instanceof ToolDenied)) throw error
    log(`${pkg} skipped: ${error.reason}`)
  }
}
return out.join("\n")
```

Tool names are the session's own: some builds have no `Glob` or `Grep` and
search through `Bash` instead. `await listTools()` says what is there.

## What the program cannot do

It has no filesystem, network, process, imports, `eval` or `Function` of its
own, and it cannot start another program. Every side effect is a tool call you
could have made yourself, and the person's permission rules, hooks and dialogs
apply to each one.

A synchronous infinite loop cannot be interrupted from inside; keep loops
bounded by the data they walk.

## Reading the output

The answer is the returned value, then `log:` lines if any, then
`tool calls: Read ×12, Grep` — the honest record of what ran. A failed run
comes back as an error that names the reason and still lists the calls that
already happened, so you know which side effects landed.
