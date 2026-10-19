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
