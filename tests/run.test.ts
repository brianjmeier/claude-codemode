import { test, expect, type Engine } from 'claude-code/testing'

const TOOL = 'mcp__codemode__run'

test('a program loops over tools and only its final value comes back', async ($, on) => {
  const files: Record<string, string> = { 'a.md': 'alpha\nTODO one', 'b.md': 'beta', 'c.md': 'TODO two\nTODO three' }
  on('tool.call', { tool: 'Read' }, async (_, e) => ({ result: files[String(e.file_path)] ?? '' }))

  const ran = await $.tool.call({
    tool: TOOL,
    code: `
      const counts = {}
      for (const file of ["a.md", "b.md", "c.md"]) {
        const { result } = await tools.Read({ file_path: file })
        counts[file] = result.split("\\n").filter(line => line.includes("TODO")).length
      }
      log("read", Object.keys(counts).length, "files")
      return counts
    `,
  } as never)

  expect(ran.deny).toBeUndefined()
  expect(ran.result).toBe(
    '{\n  "a.md": 1,\n  "b.md": 0,\n  "c.md": 2\n}\n\nlog:\nread 3 files\n\ntool calls: Read ×3',
  )
})

const run = ($: Engine, code: string) => $.tool.call({ tool: TOOL, code } as never)

test('a refused call throws ToolDenied, which the program may catch', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, async () => ({ deny: 'not in this repo' }))

  const ran = await run($, `
    try { await tool("Bash", { command: "git push" }) }
    catch (error) { return error instanceof ToolDenied ? error.tool + ": " + error.reason : "other" }
  `)

  expect(ran.result).toBe('Bash: not in this repo\n\ntool calls: Bash')
})

test('a refusal the program does not catch fails the run, naming the calls it made', async ($, on) => {
  on('tool.call', { tool: 'Read' }, async () => ({ result: 'ok' }))
  on('tool.call', { tool: 'Bash' }, async () => ({ deny: 'not in this repo' }))

  const ran = await run($, `
    log("before")
    await tools.Read({ file_path: "a" })
    await tools.Bash({ command: "git push" })
    return "unreachable"
  `)

  expect(ran.deny).toBe(
    'The program failed: ToolDenied: Bash was denied: not in this repo\n\nlog:\nbefore\n\ntool calls: Read, Bash',
  )
})

test('a tool that errors resolves with isError instead of throwing', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, async () => ({ isError: true, result: 'exit 1', text: 'Exit code 1' }) as never)

  const ran = await run($, `
    const out = await tools.Bash({ command: "false" })
    return { isError: out.isError, text: out.text }
  `)

  expect(ran.result).toBe('{\n  "isError": true,\n  "text": "Exit code 1"\n}\n\ntool calls: Bash')
})

test('a program cannot start another program', async $ => {
  const ran = await run($, `return await tool("${TOOL}", { code: "return 1" })`)

  expect(ran.deny).toBe(
    `The program failed: ToolDenied: ${TOOL} was denied: a program cannot start another program\n\ntool calls: ${TOOL}`,
  )
})

test('the program reaches nothing but its tools: no eval, no engine, no host', async $ => {
  const ran = await run($, `
    const reach = name => { try { return typeof eval(name) } catch (error) { return error.name } }
    let built
    try { built = Function("return 1")() } catch (error) { built = error.name }
    return { built, $: typeof $, require: typeof require, process: typeof process, fetch: typeof fetch, Bun: typeof Bun, Deno: typeof Deno, evalOf$: reach("$") }
  `)

  expect(JSON.parse(String(ran.result))).toEqual({
    built: 'EvalError',
    $: 'undefined',
    require: 'undefined',
    process: 'undefined',
    fetch: 'undefined',
    Bun: 'undefined',
    Deno: 'undefined',
    evalOf$: 'EvalError',
  })
})

test('a program that does not parse fails before any call', async $ => {
  const ran = await run($, 'return (')

  expect(ran.deny).toStartWith('The program failed: SyntaxError')
})

test('listTools names what the program may call, never itself', async ($, on) => {
  on('tool.list', async () => ({
    value: [
      { name: 'Read', description: 'Reads a file.', mcp: false },
      { name: TOOL, description: 'Runs a program.', mcp: true },
    ],
  }))

  const ran = await run($, 'return (await listTools()).map(t => t.name)')

  expect(ran.result).toBe('[\n  "Read"\n]')
})

test('a program that returns nothing says so', async $ => {
  const ran = await run($, 'log("done")')

  expect(ran.result).toBe('(no value returned)\n\nlog:\ndone')
})

test('each call inside the program meets the permission check with its own arguments', async ($, on) => {
  const asked: string[] = []
  on('classic.PreToolUse', async (_, e) => {
    const { file_path } = e as unknown as { file_path: string }
    asked.push(`${e.tool} ${file_path}`)
    return file_path.endsWith('.env') ? { deny: 'secrets stay out' } : {}
  })
  on('tool.call', { tool: 'Read' }, async () => ({ result: 'ok' }))

  const ran = await run($, `
    const seen = []
    for (const file of ["a.md", ".env"]) {
      try { await tools.Read({ file_path: file }); seen.push(file) }
      catch (error) { seen.push(file + " refused: " + error.reason) }
    }
    return seen.join(", ")
  `)

  expect(asked).toEqual(['Read a.md', 'Read .env'])
  expect(ran.result).toBe('a.md, .env refused: secrets stay out\n\ntool calls: Read ×2')
})
