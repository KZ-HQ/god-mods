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

describe('when it stays quiet', () => {
  const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  function engine(on: Parameters<Parameters<typeof test>[1]>[1]) {
    let calls = 0
    mock.store(on)
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    on('model.complete', () => {
      calls += 1

      return { value: { isAnswered: true, text: 'one\ntwo', usage: USAGE } } as never
    })
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as never)

    return () => calls
  }
  const settle = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }

  test('/next off stops suggestions and hides any shown; /next on brings them back', async ($, on) => {
    const calls = engine(on)
    const answer = (turnId: string) => $.turn.complete({ answer: 'Done. Next?', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
    await answer('t1')
    await settle()
    expect(calls()).toBe(1)

    expect((await $.command.run({ command: 'next', args: 'off' })).text).toBe('next-steps is off.')
    let ui = await $.ui.mount({ plugin: 'next-steps', surface: 'terminal', ...BAND })
    expect(await ui.find({ key: 's1' })).toBeUndefined()
    await ui.unmount()
    await answer('t2')
    await settle()
    expect(calls()).toBe(1)

    expect((await $.command.run({ command: 'next', args: 'on' })).text).toBe('next-steps is on.')
    await answer('t3')
    await settle()
    expect(calls()).toBe(2)
    ui = await $.ui.mount({ plugin: 'next-steps', surface: 'terminal', ...BAND })
    expect(await ui.find({ key: 's1' })).toBeDefined()
  })

  test('no model call for a subagent turn, an empty answer, or a turn that did not end in an answer', async ($, on) => {
    const calls = engine(on)
    await $.turn.complete({ answer: 'sub', durationMs: 1, isAborted: false, turnId: 'a', reason: 'answer', agentId: 'x1' })
    await $.turn.complete({ answer: '   ', durationMs: 1, isAborted: false, turnId: 'b', reason: 'answer' })
    await $.turn.complete({ answer: 'partial', durationMs: 1, isAborted: true, turnId: 'c', reason: 'aborted' } as never)
    await settle()
    expect(calls()).toBe(0)
  })
})
