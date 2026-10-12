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

describe('/shorthand', () => {
  test('add, list and remove terms; a removed term stops expanding', async ($, on) => {
    mock.store(on)
    let seen: readonly string[] | undefined
    on('prompt.submit', (_$, e) => {
      seen = e.context

      return { text: e.text }
    })
    const run = (args: string) => $.command.run({ command: 'shorthand', args }).then(r => r.text)
    expect(await run('')).toMatch(/^No shorthand yet/)
    expect(await run('add kz = the KZ-HQ org')).toBe('Shorthand saved: kz = the KZ-HQ org')
    expect(await run('')).toBe('Shorthand:\n  kz = the KZ-HQ org')
    await $.prompt.submit({ text: 'list kz repos', wait: false, origin: { kind: 'composer' } })
    expect(seen?.join('\n')).toMatch(/"kz" = the KZ-HQ org/)

    expect(await run('rm kz')).toBe('Shorthand removed: kz')
    await $.prompt.submit({ text: 'list kz repos', wait: false, origin: { kind: 'composer' } })
    expect(seen?.join('\n') ?? '').not.toMatch(/KZ-HQ/)
  })
})

describe('git state', () => {
  test('attaches git state only when it changed since the last prompt', async ($, on) => {
    mock.store(on)
    let status = '## main\n M src/a.ts\n'
    on('process.run', (_$, e) => ({
      value: { exitCode: 0, stdout: e.argv[0] === 'git' ? status : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    const contexts: (string | undefined)[] = []
    on('prompt.submit', (_$, e) => {
      contexts.push(e.context?.join('\n'))

      return { text: e.text }
    })
    const send = () => $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
    await send()
    await send()
    status = '## main\n'
    await send()
    expect(contexts[0]).toBe('Git now: main; 1 changed: M src/a.ts.')
    expect(contexts[1]).toBeUndefined()
    expect(contexts[2]).toBe('Git now: main; working tree clean.')
  })
})
