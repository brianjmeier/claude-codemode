import type { On } from 'claude-code'
import { test, expect, mock, type Engine } from 'claude-code/testing'
import { TOOL } from '../hooks/register'

const run = ($: Engine, code: string) => $.tool.call({ tool: TOOL, code })

const codemodeTest = (name: string, body: ($: Engine, on: On) => Promise<void>) =>
  test(name, async ($, on) => {
    mock.clock(on)
    await body($, on)
  })

codemodeTest('a program loops over tools and only its final value comes back', async ($, on) => {
  const files: Record<string, string> = { 'a.md': 'alpha\nTODO one', 'b.md': 'beta', 'c.md': 'TODO two\nTODO three' }
  on('tool.call', { tool: 'Read' }, async (_, e) => ({ result: files[String(e.file_path)] ?? '' }))

  const ran = await run($, `
    const counts = {}
    for (const file of ["a.md", "b.md", "c.md"]) {
      const { result } = await tools.Read({ file_path: file })
      counts[file] = result.split("\\n").filter(line => line.includes("TODO")).length
    }
    log("read", Object.keys(counts).length, "files")
    return counts
  `)

  expect(ran.deny).toBeUndefined()
  expect(ran.result).toBe(
    '{"a.md":1,"b.md":0,"c.md":2}\n\nlog:\nread 3 files\n\ntool calls: Read ×3',
  )
})

codemodeTest('a refused call throws ToolDenied, which the program may catch', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, async () => ({ deny: 'not in this repo' }))

  const ran = await run($, `
    try { await tool("Bash", { command: "git push" }) }
    catch (error) { return error instanceof ToolDenied ? error.tool + ": " + error.reason : "other" }
  `)

  expect(ran.result).toBe('Bash: not in this repo\n\ntool calls: Bash')
})

codemodeTest('a refusal the program does not catch fails the run, naming the calls it made', async ($, on) => {
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

codemodeTest('a tool that errors resolves with isError instead of throwing', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, async () => ({ isError: true, result: 'exit 1', text: 'Exit code 1' }) as never)

  const ran = await run($, `
    const out = await tools.Bash({ command: "false" })
    return { isError: out.isError, text: out.text }
  `)

  expect(ran.result).toBe('{"isError":true,"text":"Exit code 1"}\n\ntool calls: Bash')
})

codemodeTest('a program cannot start another program', async ($, on) => {
  const ran = await run($, `return await tool("${TOOL}", { code: "return 1" })`)

  expect(ran.deny).toBe(
    `The program failed: ToolDenied: ${TOOL} was denied: a program cannot start another program\n\ntool calls: ${TOOL}`,
  )
})

codemodeTest('the program reaches nothing but its tools: no eval, no engine, no host', async ($, on) => {
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

codemodeTest('a program that does not parse fails before any call', async ($, on) => {
  const ran = await run($, 'return (')

  expect(ran.deny).toStartWith('The program failed: SyntaxError')
})

codemodeTest('listTools names what the program may call, never itself', async ($, on) => {
  on('tool.list', async () => ({
    value: [
      { name: 'Read', description: 'Reads a file.', mcp: false },
      { name: TOOL, description: 'Runs a program.', mcp: true },
    ],
  }))

  const ran = await run($, 'return (await listTools()).map(t => t.name)')

  expect(ran.result).toBe('["Read"]')
})

codemodeTest('a program that returns nothing says so', async ($, on) => {
  const ran = await run($, 'log("done")')

  expect(ran.result).toBe('(no value returned)\n\nlog:\ndone')
})

codemodeTest('each call inside the program meets the permission check with its own arguments', async ($, on) => {
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

codemodeTest('the row shows the program, each call it made, and what came back', async ($, on) => {
  const runs = new Set<string>()
  on('state.set', async (_, e, next) => {
    runs.add(String((e as unknown as { id: string }).id))
    return next(e)
  })
  on('tool.call', { tool: 'Read' }, async () => ({ result: 'ok' }))
  on('tool.call', { tool: 'Bash' }, async () => ({ deny: 'no jj here' }))
  const code = 'await tools.Read({ file_path: "a.md" })\ntry { await tools.Bash({ command: "jj log" }) } catch {}\nreturn "two calls"'

  const ran = await run($, code)
  const [requestId] = [...runs]

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'codemode',
      surface,
      component: 'ToolUse',
      requestId,
      props: { tool_use_id: requestId ?? '', tool: TOOL, input: { code }, isRunning: false, isErrored: false, isInterrupted: false, output: ran.result },
    })
    const shown = (await ui.find({ type: 'Box' }))?.text ?? ''
    expect(shown).toContain('⏺ codemode · 2 calls · 0ms')
    expect(shown).toContain('tools.Read({ file_path: "a.md" })')
    expect(shown).toContain('✓ Read a.md 0ms')
    expect(shown).toContain('✗ Bash jj log denied')
    expect(shown).toContain('two calls')
    expect(shown).not.toContain('tool calls:')
    await ui.unmount()
  }
})

codemodeTest('the row draws while the program is still being written', async $ => {
  for (const isRunning of [false, true]) {
    const ui = await $.ui.mount({
      plugin: 'codemode',
      surface: 'terminal',
      component: 'ToolUse',
      props: { tool_use_id: 'streaming', tool: TOOL, input: {}, isRunning, isErrored: false, isInterrupted: false },
    })

    expect((await ui.find({ type: 'Box' }))?.text).toStartWith('⏺ codemode')
    await ui.unmount()
  }
})

codemodeTest('agent() asks for each subagent at once, and one that never starts is reported, not waited on', async ($, on) => {
  const spawned: string[] = []
  on('agent.spawn', async (_, e) => {
    spawned.push((e as unknown as { subagent_type: string }).subagent_type)
    return { model: 'haiku' }
  })

  const ran = await run($, `
    const asked = await Promise.allSettled([
      agent({ type: "Explore", prompt: "summarize the prs station" }),
      agent({ type: "Plan", prompt: "summarize the backlog station" }),
    ])
    return asked.map(a => a.reason.reason).join(" | ")
  `)

  expect(spawned).toEqual(['Explore', 'Plan'])
  expect(ran.result).toBe('the Explore subagent did not start | the Plan subagent did not start\n\ntool calls: Explore, Plan')
})

codemodeTest('a refused subagent throws ToolDenied', async ($, on) => {
  on('agent.spawn', async () => ({ deny: 'no subagents here' }))

  const ran = await run($, `
    try { await agent({ type: "Explore", prompt: "x" }) } catch (error) { return error.tool + ": " + error.reason }
  `)

  expect(ran.result).toBe('Explore: no subagents here\n\ntool calls: Explore')
})

codemodeTest('parallel calls each keep their own line', async ($, on) => {
  const runs = new Set<string>()
  on('state.set', async (_, e, next) => {
    runs.add(String((e as unknown as { id: string }).id))
    return next(e)
  })
  on('tool.call', { tool: 'Read' }, async (_, e) => ({ result: String(e.file_path) }))
  const code = 'return (await Promise.all(["a.md", "b.md", "c.md"].map(file => tools.Read({ file_path: file })))).length'

  const ran = await run($, code)
  const [requestId] = [...runs]
  const ui = await $.ui.mount({
    plugin: 'codemode',
    surface: 'terminal',
    component: 'ToolUse',
    requestId,
    props: { tool_use_id: requestId ?? '', tool: TOOL, input: { code }, isRunning: false, isErrored: false, isInterrupted: false, output: ran.result },
  })
  const shown = (await ui.find({ type: 'Box' }))?.text ?? ''

  for (const file of ['a.md', 'b.md', 'c.md']) expect(shown).toContain(`✓ Read ${file} 0ms`)
  await ui.unmount()
})

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

codemodeTest('ask() puts questions to a model in parallel and hands the answers to the program', async ($, on) => {
  on('model.complete', async (_, e) => ({
    value: { isAnswered: true as const, text: `${e.model}: ${e.prompt.toUpperCase()}`, usage: USAGE },
  }))

  const ran = await run($, `
    const answers = await Promise.all(["prs", "backlog"].map(name => ask({ model: "haiku", prompt: name })))
    return answers.join(" | ")
  `)

  expect(ran.result).toBe('haiku: PRS | haiku: BACKLOG\n\ntool calls: ask haiku ×2')
})

codemodeTest('an ask() the model does not answer throws, naming why', async ($, on) => {
  on('model.complete', async () => ({
    value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE },
  }))

  const ran = await run($, `
    try { await ask({ model: "haiku", prompt: "x" }) } catch (error) { return error.message }
  `)

  expect(ran.result).toBe('ask haiku failed: empty-reply\n\ntool calls: ask haiku')
})

codemodeTest('canCall() says what the permission check would decide without running the call', async ($, on) => {
  let ran = false
  on('tool.check', async (_, e) => ({ decision: (e.input as { command: string }).command.startsWith('jj') ? ('deny' as const) : ('allow' as const) }))
  on('tool.call', { tool: 'Bash' }, async () => {
    ran = true
    return { result: 'ran' }
  })

  const answer = await run($, 'return [await canCall("Bash", { command: "jj log" }), await canCall("Bash", { command: "ls" })].join(",")')

  expect(answer.result).toBe('deny,allow')
  expect(ran).toBe(false)
})

codemodeTest('cwd() hands the program the session\'s working directory', async ($, on) => {
  on('session.cwd', async () => ({ value: '/work/repo' }))

  const answer = await run($, 'return cwd()')

  expect(answer.result).toBe('/work/repo')
})
