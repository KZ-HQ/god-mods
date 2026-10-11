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
})
