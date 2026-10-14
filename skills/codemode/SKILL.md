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

The body of an async function. Globals:

| Global | What it does |
| --- | --- |
| `await tool(name, args)` | Calls any tool by name with its usual arguments |
| `await tools.Name(args)` | The same, for names that are valid identifiers (`tools.Read`, `tools.Grep`, `tools.Bash`) |
| `await listTools()` | `[{ name, description }]` of what the program may call |
| `log(...values)` | Adds a line to the output |
| `ToolDenied` | The error a refused call throws (`error.tool`, `error.reason`) |

Each call resolves `{ text, result, isError }`:

- `text` — what you would have read had you made the call
- `result` — the tool's structured record. The two you will use most:
  - `Read`: `result.file.content` (the file without line numbers), `result.file.totalLines`
  - `Bash`: `result.stdout`, `result.stderr`, `result.interrupted`

  For any other tool, read `text`, or `return` one `result` once to see its shape.
- `isError` — the tool ran and failed (a non-zero Bash exit, a missing file); it does **not** throw

A permission refusal **throws** `ToolDenied`. Catch it when the loop should go
on without that item; leave it uncaught when the whole run should stop.

`return` a string to get it back verbatim, anything else to get JSON.

## Patterns

Count matches across files, return only the table:

```js
const { text } = await tools.Glob({ pattern: "src/**/*.ts" })
const rows = []
for (const file of text.split("\n").filter(Boolean)) {
  const { text: body } = await tools.Read({ file_path: file })
  const todos = body.split("\n").filter(line => line.includes("TODO")).length
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
    out.push(`${pkg}: ${run.text.trim()}`)
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
