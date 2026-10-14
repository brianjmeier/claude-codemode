# codemode for Claude Code

A Claude Code mod that gives the model one tool, `mcp__codemode__run`: it
writes a JavaScript program, the program calls Claude Code's own tools
(`Read`, `Bash`, `Edit`, MCP tools — anything the session has), and only the
program's return value comes back into the conversation.

![Claude Code summarizing a week of commits with one codemode program, then a deny rule stopping a call inside a program](docs/demo.svg)

It ships with a `codemode` skill that tells the model when a program beats
direct calls and how to write one.

## Install

```text
/plugin marketplace add brianjmeier/claude-codemode
/plugin install codemode@claude-codemode
```

Or for one session: `claude --plugin-dir <this folder>`.

## The program's world

`tool(name, args)`, `tools.Name(args)`, `listTools()`, `log(...)` and
`ToolDenied`. The tool's description is the full contract the model reads;
[`skills/codemode/SKILL.md`](skills/codemode/SKILL.md) says when to use it.

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

## Develop

```text
claude plugin validate .
claude plugin test .
```

`hooks/vendor/sval.js` is sval 0.6.12 (MIT), vendored unmodified.
