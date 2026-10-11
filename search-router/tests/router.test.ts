import { describe, expect, mock, test } from 'claude-code/testing'

const FC = 'mcp__abc123__firecrawl_search'
const EXA = 'mcp__def456__web_search_exa'

describe('search-router', () => {
  test('after Firecrawl runs out, its calls are denied and Exa still runs', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    const error = 'Insufficient credits to perform this request (402)'
    let firecrawlCalls = 0
    on('tool.call', { tool: FC }, () => {
      firecrawlCalls += 1

      return { isError: true as const, result: error, text: error }
    })
    on('tool.call', { tool: EXA }, () => ({ result: 'exa results' }))

    const first = await $.tool.call({ tool: FC, query: 'x' } as never)
    expect(first.isError === true || first.deny !== undefined).toBe(true)

    const second = await $.tool.call({ tool: FC, query: 'x' } as never)
    expect(second.deny).toMatch(/out of credits/)
    expect(firecrawlCalls).toBe(1)

    const exa = await $.tool.call({ tool: EXA, query: 'x' } as never)
    expect(exa.deny).toBeUndefined()
  })

  test('steers descriptions toward Exa for search', async ($, on) => {
    mock.clock(on)
    on('tool.describe', (_$, e) => ({ description: e.description }))
    const fc = await $.tool.describe({ tool: FC, description: 'Search the web.', provider: { plugin: 'mcp:fc', tier: 'user' } } as never)
    expect(fc.description).toMatch(/prefer web_search_exa/)
    const exa = await $.tool.describe({ tool: EXA, description: 'Search.', isDeferred: true, provider: { plugin: 'mcp:exa', tier: 'user' } } as never)
    expect(exa.isDeferred).toBe(false)
  })

  test("a scraped page that mentions credits doesn't count; Firecrawl's own hint does", async ($, on) => {
    mock.clock(on)
    mock.store(on)
    const toasts: string[] = []
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    let body = '{"markdown":"Our users were low on credits last quarter"}'
    on('tool.call', { tool: FC }, () => ({ result: body, text: body }))
    await $.tool.call({ tool: FC, query: 'x' } as never)
    expect(toasts).toEqual([])
    body = '{"agent_hints":["The connected Firecrawl account is low on credits."],"markdown":"..."}'
    await $.tool.call({ tool: FC, query: 'x' } as never)
    expect(toasts[0]).toMatch(/Firecrawl credits are low/)
  })

  test('ordinary successful calls write nothing to the store', async ($, on) => {
    mock.clock(on)
    let writes = 0
    on('store.get', () => ({ value: undefined }))
    on('store.set', () => {
      writes += 1

      return { value: undefined }
    })
    on('tool.call', { tool: EXA }, () => ({ result: 'ok', text: 'ok' }))
    for (let i = 0; i < 3; i++) await $.tool.call({ tool: EXA, query: 'x' } as never)
    expect(writes).toBe(0)
  })

  test('metrics: a loaded row at session start, and a quiet pass-through Exa call still counts in the turn row', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    const rows: Record<string, unknown>[] = []
    on('session.cwd', () => ({ value: '/x/my-app' }))
    on('session.id', () => ({ value: 's1' }))
    on('fs.read', () => ({ value: '{"version":"9.9.9"}' }) as never)
    on('process.run', (_$, e) => {
      if (e.argv[3] === 'mod-metrics') rows.push(JSON.parse(e.argv[4]!) as Record<string, unknown>)

      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('session.start', (_$, e) => e as never)
    on('command.register', () => ({ value: undefined }))
    on('tool.call', { tool: EXA }, () => ({ result: 'exa results' }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))

    await $.session.start({ source: 'startup', cwd: '/x/my-app' } as never)
    await $.tool.call({ tool: EXA, query: 'x' } as never)
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
    for (let i = 0; i < 50 && rows.length < 2; i++) await $.clock.now()

    expect(rows.find(r => r.event === 'loaded')).toMatchObject({ v: 2, mod: 'search-router', ver: '9.9.9', session: 's1', project: 'my-app' })
    expect(rows.find(r => r.event === 'turn')).toMatchObject({ v: 2, mod: 'search-router', hooks: { 'session.start': 1, 'tool.call': 1 } })
  })
})
