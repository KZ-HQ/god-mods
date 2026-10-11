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
