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

  test('shows fill and cost, and offers Compact only when hot', async ($, on) => {
    engine(on)
    for (const surface of ['terminal', 'desktop'] as const) {
      await $.session.measure(measure(40))
      let ui = await $.ui.mount({ plugin: 'context-gauge', surface, ...BAND })
      expect(await ui.find({ type: 'Text', text: /40% · 80k\/200k/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /session \$1\.50/ })).toBeDefined()
      expect(await ui.find({ key: 'compact' })).toBeUndefined()
      await ui.unmount()

      await $.session.measure(measure(75))
      ui = await $.ui.mount({ plugin: 'context-gauge', surface, ...BAND })
      expect(await ui.find({ key: 'compact' })).toBeDefined()
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

  test('no Compact button while a turn is running', async ($, on) => {
    engine(on)
    await $.session.measure(measure(75))
    const ui = await $.ui.mount({ plugin: 'context-gauge', surface: 'terminal', ...BAND, props: { ...BAND.props, isWorking: true } })
    expect(await ui.find({ type: 'Text', text: /75%/ })).toBeDefined()
    expect(await ui.find({ key: 'compact' })).toBeUndefined()
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
    expect(await ui.find({ key: 'compact' })).toBeDefined()
    await ui.unmount()
    await $.session.measure(big(100_000))
    await $.session.measure(big(410_000))
    expect(toasts.length).toBe(2)
  })
})

describe('compact button', () => {
  test('pressing it compacts the session', async ($, on) => {
    engine(on)
    let calls = 0
    on('session.compact', () => {
      calls++

      return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] as never, tokensBefore: 500_000, tokensAfter: 40_000 }
    })
    const toasts: string[] = []
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    on('ui.status', () => ({ value: undefined }))
    await $.session.measure(measure(75))
    const ui = await $.ui.mount({ plugin: 'context-gauge', surface: 'terminal', ...BAND })
    await ui.press({ key: 'compact' })
    for (let i = 0; i < 50 && toasts.length === 0; i++) await $.session.measure(measure(75))
    expect(calls).toBe(1)
    expect(toasts).toEqual(['context-gauge: compacted 500k → 40k'])
  })

  test('a veto is reported, not lost', async ($, on) => {
    engine(on)
    on('session.compact', () => ({ skip: 'blocked by a PreCompact hook' }))
    const toasts: string[] = []
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    on('ui.status', () => ({ value: undefined }))
    await $.session.measure(measure(75))
    const ui = await $.ui.mount({ plugin: 'context-gauge', surface: 'terminal', ...BAND })
    await ui.press({ key: 'compact' })
    for (let i = 0; i < 50 && toasts.length === 0; i++) await $.session.measure(measure(75))
    expect(toasts[0]).toMatch(/skipped: blocked by a PreCompact hook/)
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
