# codemode for Claude Code

A Claude Code mod that gives the model one tool, `mcp__codemode__run`: it
writes a JavaScript program, the program calls Claude Code's own tools
(`Read`, `Bash`, `Edit`, MCP tools — anything the session has), and only the
program's return value comes back into the conversation.

```js
const listed = await tools.Bash({ command: "rg --files -g '*.ts' src" })
const rows = []
for (const file of listed.result.stdout.split("\n").filter(Boolean)) {
  const { result } = await tools.Read({ file_path: file })
  const todos = result.file.content.split("\n").filter(l => l.includes("TODO")).length
  if (todos > 0) rows.push({ file, todos })
}
return rows.sort((a, b) => b.todos - a.todos).slice(0, 10)
```

Thirty reads, one result in context:

```
[ { "file": "src/a.ts", "todos": 4 }, ... ]

tool calls: Bash, Read ×30
```

It ships with a `codemode` skill that tells the model when a program beats
direct calls and how to write one.

## Install

```text
/plugin marketplace add brianjmeier/claude-codemode
/plugin install codemode@claude-codemode
```

Or for one session: `claude --plugin-dir <this folder>`.

## The program's world

| Global | |
| --- | --- |
| `await tool(name, args)` | any tool the session has, by name |
| `await tools.Name(args)` | the same, as a property |
| `await listTools()` | `[{ name, description }]` |
| `log(...values)` | a line in the output |
| `ToolDenied` | what a refused call throws (`tool`, `reason`) |

A call resolves `{ text, result, isError }`. A tool that fails resolves with
`isError: true`; a call the permission check refuses throws `ToolDenied`.

## Permissions and containment

- **Every nested call is a real tool call.** It goes through `$.tool.call`,
  the same path as the model's own calls: your allow/deny rules, auto mode,
  `PreToolUse` hooks and the permission dialog all apply, per call, with that
  call's own arguments.
- **The program has nothing else.** It runs in [sval](https://github.com/Siubaak/sval),
  a JavaScript interpreter written in JavaScript, inside the mod's own hooks
  runtime — which has no Node, no filesystem, no network, no process, and
  refuses `eval`, `Function` and WebAssembly. The interpreter is needed exactly
  because that runtime will not compile code from text. The program cannot
  reach the engine's `$`, and cannot start another program.
- **Limits.** A synchronous infinite loop cannot be preempted. The program
  shares the runtime's built-in prototypes, so it can monkey-patch `Array.prototype`
  for this mod's runtime (not the session, not the filesystem).

## Why not gabe4coding/claude-code-mode

That plugin is MCP-only and adds tool search, hints, saved functions and
output projection. This one is the primitive alone, and reaches built-in tools
because a mod can call them through the engine.

## Develop

```text
claude plugin validate .
claude plugin test .
```

`hooks/vendor/sval.js` is sval 0.6.12 (MIT), vendored unmodified.
