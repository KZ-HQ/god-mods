import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Nothing beneath the plugin answers session.measure in a test
const engine = (on: On) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  // Metrics writes succeed, so their failure toast never mixes into the counts
  on('clock.now', () => ({ value: 0 }))
  on('session.cwd', () => ({ value: '/r' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  // The engine's own band: an empty Box
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return h(Box, {}) as ReturnType<typeof h> & object
  })
}

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

const measure = (percent: number, usd = 1.5) => ({
  context: { tokens: percent * 2000, window: 200_000, percent },
  rateLimits: [{ kind: 'five_hour', percentUsed: 34 }],
  cost: { usd },
  changed: ['context' as const],
})

describe('context-gauge band', () => {
  test('formats cost like every god-mod: three decimals under $1, two from $1', async ($, on) => {
    engine(on)
    for (const [usd, shown] of [[0.1234, /session \$0\.123/], [12.345, /session \$12\.35/]] as const) {
      await $.session.measure(measure(40, usd))
      const ui = await $.ui.mount({ plugin: 'context-gauge', surface: 'terminal', ...BAND })
      expect(await ui.find({ type: 'Text', text: shown })).toBeDefined()
      await ui.unmount()
    }
  })

  test('shows fill and cost, and has no Compact button', async ($, on) => {
    engine(on)
    for (const surface of ['terminal', 'desktop'] as const) {
      await $.session.measure(measure(40))
      let ui = await $.ui.mount({ plugin: 'context-gauge', surface, ...BAND })
      expect(await ui.find({ type: 'Text', text: /40% · 80k\/200k/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /session \$1\.50/ })).toBeDefined()
      expect(await ui.find({ key: 'compact' })).toBeUndefined()
      await ui.unmount()

      await $.session.measure(measure(95))
      ui = await $.ui.mount({ plugin: 'context-gauge', surface, ...BAND })
      expect(await ui.find({ key: 'compact' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('/gauge hides it', async ($, on) => {
    engine(on)
    mock.store(on)
    await $.session.measure(measure(50))
    await $.command.run({ command: 'gauge', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    const ui = await $.ui.mount({ plugin: 'context-gauge', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /50%/ })).toBeUndefined()
  })

  test('a hidden gauge stays hidden in the next session', async ($, on) => {
    engine(on)
    mock.store(on, { hidden: true })
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 100000, percent: 50 }, rateLimits: [] } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/r' } as never)
    const ui = await $.ui.mount({ plugin: 'context-gauge', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /50%/ })).toBeUndefined()
  })

  test('nags once above 400k even when the window is large', async ($, on) => {
    engine(on)
    const toasts: string[] = []
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    const big = (tokens: number) => ({ ...measure(0), context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) } })
    await $.session.measure(big(300_000))
    expect(toasts).toEqual([])
    await $.session.measure(big(420_000))
    await $.session.measure(big(450_000))
    expect(toasts.length).toBe(1)
    const ui = await $.ui.mount({ plugin: 'context-gauge', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /over 400k/ })).toBeDefined()
    await ui.unmount()
    await $.session.measure(big(100_000))
    await $.session.measure(big(410_000))
    expect(toasts.length).toBe(2)
  })
})

describe('context hogs', () => {
  test('/hogs ranks files by result size and the band names the top one', async ($, on) => {
    engine(on)
    on('tool.call', (_$, e) => ({ result: {}, text: e.tool === 'Read' && e.file_path === '/r/big.ts' ? 'x'.repeat(40_000) : 'y'.repeat(400) }) as never)
    const toasts: string[] = []
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    await $.session.measure(measure(50))
    await $.tool.call({ tool: 'Read', file_path: '/r/big.ts' } as never)
    await $.tool.call({ tool: 'Read', file_path: '/r/big.ts' } as never)
    await $.tool.call({ tool: 'Read', file_path: '/r/small.ts' } as never)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    const run = () => $.command.run({ command: 'hogs', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    const out = JSON.stringify(await run())
    expect(out).toMatch(/\/r\/big\.ts {2}~20k tokens {2}20%/)
    expect(out.indexOf('big.ts')).toBeLessThan(out.indexOf('small.ts'))
    expect(out).toContain('bash')
    expect(toasts.length).toBe(1)
    expect(toasts[0]).toMatch(/big\.ts holds ~10k|holds ~20k.*\/compact/)
    const ui = await $.ui.mount({ plugin: 'context-gauge', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /top big\.ts ~20k/ })).toBeDefined()
    await ui.unmount()
  })

  test('a huge Grep or Bash result does not toast', async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: {}, text: 'x'.repeat(200_000) }) as never)
    const toasts: string[] = []
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    await $.tool.call({ tool: 'Grep', pattern: 'a' } as never)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect(toasts).toEqual([])
  })

  test('a compaction clears the tally', async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: {}, text: 'x'.repeat(400) }) as never)
    const msgs = [{ role: 'user', text: 'summary', toolUses: [] }]
    on('session.compact', () => ({ messages: msgs }) as never)
    await $.tool.call({ tool: 'Read', file_path: '/r/a.ts' } as never)
    await $.session.compact({ messages: msgs } as never)
    const out = JSON.stringify(await $.command.run({ command: 'hogs', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }))
    expect(out).toContain('No tool results')
  })
})

describe('metrics', () => {
  test('a failed write is toasted once, not swallowed', async ($, on) => {
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    on('clock.now', () => ({ value: 0 }))
    on('session.cwd', () => ({ value: '/r' }))
    on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'Operation not permitted\n' } }) as never)
    const toasts: string[] = []
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    const big = (tokens: number) => ({ ...measure(0), context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) } })
    await $.session.measure(big(420_000))
    await $.session.measure(big(100_000))
    await $.session.measure(big(420_000))
    for (let i = 0; i < 50 && !toasts.some(t => t.includes('metrics')); i++) await $.session.measure(big(450_000))
    expect(toasts.filter(t => t.includes('metrics write failed'))).toEqual(['context-gauge: metrics write failed (Operation not permitted)'])
  })
})

describe('last turn', () => {
  test('shows what the last main-loop turn cost and how long it took', async ($, on) => {
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    on('session.cwd', () => ({ value: '/r' }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as ReturnType<typeof h> & object)
    let usdNow = 1
    on('session.usage', () => ({ value: { cost: { usd: usdNow } } }) as never)
    const clock = mock.clock(on, { now: 0 })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))

    await $.turn.start({ text: 'go', turnId: 't1' })
    usdNow = 1.25
    await clock.advance(7_000)
    await $.turn.complete({ answer: 'done', durationMs: 7000, isAborted: false, turnId: 't1', reason: 'answer' })
    await $.session.measure(measure(40))
    const ui = await $.ui.mount({ plugin: 'context-gauge', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /last turn \$0\.250 · 7s/ })).toBeDefined()
  })
})

describe('agents', () => {
  const run = async ($: Parameters<Parameters<typeof test>[1]>[0], on: On, stdout: string) => {
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    on('session.cwd', () => ({ value: '/r' }))
    on('session.id', () => ({ value: 's1' }) as never)
    on('clock.now', () => ({ value: 0 }))
    on('session.usage', () => ({ value: { cost: { usd: 1 } } }) as never)
    on('process.run', (_$, e) => ({ value: { exitCode: 0, stdout: e.argv.some(a => a.endsWith('agents.py')) ? stdout : '', stderr: '' } }) as never)
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as ReturnType<typeof h> & object)
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await $.session.measure(measure(40))
    for (let i = 0; i < 20; i++) await Promise.resolve()

    return $.ui.mount({ plugin: 'context-gauge', surface: 'terminal', ...BAND })
  }

  test("adds this session's subagent cost beside session cost", async ($, on) => {
    const ui = await run($, on, '{"usd": 1.1, "agents": 3}\n')
    expect(await ui.find({ type: 'Text', text: /session \$1\.50 \+ agents \$1\.10/ })).toBeDefined()
  })

  test('shows no agents figure when no subagent ran', async ($, on) => {
    const ui = await run($, on, '{"usd": 0, "agents": 0}\n')
    expect(await ui.find({ type: 'Text', text: /agents/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /session \$1\.50/ })).toBeDefined()
  })
})

describe('prompt cache', () => {
  test('counts down the last 10 minutes, then prices the cold re-write', async ($, on) => {
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    on('session.cwd', () => ({ value: '/r' }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as ReturnType<typeof h> & object)
    on('session.usage', () => ({ value: { cost: { usd: 1 } } }) as never)
    const clock = mock.clock(on, { now: 0 })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))

    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.turn.complete({ answer: 'done', durationMs: 0, isAborted: false, turnId: 't1', reason: 'answer' })
    await $.session.measure(measure(50))
    const band = async (text: RegExp) => {
      const ui = await $.ui.mount({ plugin: 'context-gauge', surface: 'terminal', ...BAND })
      const found = await ui.find({ type: 'Text', text })
      await ui.unmount()

      return found
    }

    expect(await band(/cache/)).toBeUndefined()
    await clock.advance(55 * 60_000)
    expect(await band(/cache 5m left/)).toBeDefined()
    await clock.advance(6 * 60_000)
    // 100k tokens at opus: 100k * (2 * $4 - $0.2) / 1M
    expect(await band(/cache cold: next message re-writes 100k ≈ \$0\.780/)).toBeDefined()

    await $.turn.start({ text: 'again', turnId: 't2' })
    expect(await band(/cache/)).toBeUndefined()
  })
})
