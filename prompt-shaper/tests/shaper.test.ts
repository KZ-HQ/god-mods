import { describe, expect, mock, test } from 'claude-code/testing'

describe('prompt-shaper', () => {
  test('attaches the meaning of shorthand the prompt uses, and leaves the text alone', async ($, on) => {
    mock.store(on, { shorthand: { app: 'the my-app project', cp: 'the other-app project' } })
    let seen: readonly string[] | undefined
    let text = ''
    on('prompt.submit', (_$, e) => {
      seen = e.context
      text = e.text

      return { text: e.text, context: e.context }
    })
    await $.prompt.submit({ text: 'fix the app login bug', wait: false, origin: { kind: 'composer' } })
    expect(text).toBe('fix the app login bug')
    expect(seen?.join('\n')).toMatch(/"app" = the my-app project/)
    expect(seen?.join('\n') ?? '').not.toMatch(/other-app/)
  })

  test('ignores prompts the person did not type', async ($, on) => {
    mock.store(on, { shorthand: { app: 'the my-app project' } })
    let seen: readonly string[] | undefined = ['unset']
    on('prompt.submit', (_$, e) => {
      seen = e.context

      return { text: e.text }
    })
    await $.prompt.submit({ text: 'app report', wait: false, origin: { kind: 'scheduled-trigger' } })
    expect(seen).toBeUndefined()
  })
})
