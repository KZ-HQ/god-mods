import { describe, expect, mock, test } from 'claude-code/testing'

import { parse } from '../hooks/suggest.ts'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

describe('parse', () => {
  test('strips numbering and quotes, keeps three', async () => {
    expect(parse('1. "merge #58"\n- run the full suite\n* deploy to staging\nfourth')).toEqual(['merge #58', 'run the full suite', 'deploy to staging'])
  })
})

describe('band', () => {
  test('suggestions after an answer; pressing one drafts it', async ($, on) => {
    mock.store(on)
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    on('model.complete', () => ({ value: { isAnswered: true, text: 'merge #58\nreset production', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) as never)
    let filled = ''
    on('prompt.fill', (_$, e) => {
      filled = e.text

      return { isFilled: true } as never
    })
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as never)

    await $.prompt.submit({ text: 'add the journey test', wait: false, origin: { kind: 'composer' } })
    await $.turn.complete({ answer: 'PR #58 is up. Merge it?', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
    // The suggestions arrive after turn.complete settles
    for (let i = 0; i < 50; i++) await Promise.resolve()

    const ui = await $.ui.mount({ plugin: 'next-steps', surface: 'terminal', ...BAND })
    expect(await ui.find({ key: 's2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'reset production' })).toBeDefined()
    await ui.press({ key: 's1' })
    expect(filled).toBe('merge #58')
  })
})
