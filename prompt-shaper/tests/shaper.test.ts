import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// git status answers with the given text; metrics rows are captured
function engine(on: On, git: () => string) {
  const rows: Record<string, unknown>[] = []
  on('clock.now', () => ({ value: 0 }))
  on('session.cwd', () => ({ value: '/r' }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === '/bin/sh' && e.argv[4]) rows.push(JSON.parse(e.argv[4]))

    return { value: { exitCode: 0, stdout: e.argv[0] === 'git' ? git() : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return rows
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('git state', () => {
  test('attaches git state only when it changed since the last prompt', async ($, on) => {
    let status = '## main\n M src/a.ts\n'
    engine(on, () => status)
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

  test('leaves the prompt text alone', async ($, on) => {
    engine(on, () => '## main\n')
    let text = ''
    on('prompt.submit', (_$, e) => {
      text = e.text

      return { text: e.text }
    })
    await $.prompt.submit({ text: 'fix the app login bug', wait: false, origin: { kind: 'composer' } })
    expect(text).toBe('fix the app login bug')
  })

  test('ignores prompts the person did not type', async ($, on) => {
    engine(on, () => '## main\n')
    let seen: readonly string[] | undefined = ['unset']
    on('prompt.submit', (_$, e) => {
      seen = e.context

      return { text: e.text }
    })
    await $.prompt.submit({ text: 'app report', wait: false, origin: { kind: 'scheduled-trigger' } })
    expect(seen).toBeUndefined()
  })
})

describe('outcome', () => {
  test("records Claude's own git checks in the main loop, and whether a note was already given", async ($, on) => {
    const rows = engine(on, () => '## main\n')
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('tool.call', () => ({ result: 'ok' }) as never)
    const bash = (command: string, agentId?: string) => $.tool.call({ tool: 'Bash', input: { command }, ...(agentId ? { agentId } : {}) } as never)
    await bash('git status --short')
    await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
    await bash('cd /r && git branch --show-current')
    await bash('git -C /r status')
    await bash('git log --oneline -3')
    await bash('git status', 'agent-1')
    await settle()
    expect(rows.filter(r => r.event === 'gitcheck').map(r => r.noted)).toEqual([false, true, true])
  })
})
