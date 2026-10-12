import { describe, expect, test } from 'claude-code/testing'

import { overlap, words } from '../hooks/words.ts'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

describe('words', () => {
  test('content words, plurals folded', async () => {
    expect([...words('Please check the tenants and their leases')]).toEqual(['tenant', 'lease'])
    expect(Math.round(overlap(words("tenant lease invoice"), words("tenants leases")) * 100)).toBe(67)
  })
})

describe('band', () => {
  test('shows from the third prompt when a prompt shares almost nothing with the session', async ($, on) => {
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as never)
    const send = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
    await send('scope the reminders module to households with tests')
    await send('reminders module tests failing on household scoping')
    let ui = await $.ui.mount({ plugin: 'topic-drift', surface: 'terminal', ...BAND })
    expect(await ui.find({ key: 'dismiss' })).toBeUndefined()
    await ui.unmount()

    await send('recommend a good espresso grinder budget around three hundred dollars')
    ui = await $.ui.mount({ plugin: 'topic-drift', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /New topic\? This prompt shares 0%/ })).toBeDefined()
    await ui.press({ key: 'dismiss' })
    expect(await ui.find({ key: 'dismiss' })).toBeUndefined()
  })
})

describe('what counts', () => {
  const engine = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('session.end', () => ({ sessionId: 's1' }))
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as never)
  }
  const shown = async ($: Parameters<Parameters<typeof test>[1]>[0]) => {
    const ui = await $.ui.mount({ plugin: 'topic-drift', surface: 'terminal', ...BAND })
    const found = (await ui.find({ key: 'dismiss' })) !== undefined
    await ui.unmount()

    return found
  }

  test('slash commands and prompts the person did not type never count or warn', async ($, on) => {
    engine(on)
    const send = (text: string, kind = 'composer') => $.prompt.submit({ text, wait: false, origin: { kind } as never })
    await send('scope the reminders module to households with tests')
    await send('/compact keep the reminders module notes')
    await send('recommend espresso grinder budget around three hundred dollars', 'scheduled-trigger')
    expect(await shown($)).toBe(false)
    // Only one counted prompt so far, so a drifting one is still too early to warn about
    await send('recommend espresso grinder budget around three hundred dollars')
    expect(await shown($)).toBe(false)
  })

  test('a session end (/clear) forgets the topic and the warning', async ($, on) => {
    engine(on)
    const send = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
    await send('scope the reminders module to households with tests')
    await send('reminders module tests failing on household scoping')
    await send('recommend a good espresso grinder budget around three hundred dollars')
    expect(await shown($)).toBe(true)

    await $.session.end({ reason: 'clear' } as never)
    expect(await shown($)).toBe(false)
    await send('recommend a good espresso grinder budget around three hundred dollars')
    expect(await shown($)).toBe(false)
  })
})
