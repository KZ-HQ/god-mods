import { describe, expect, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

// git answers the branch; metrics rows are captured; core compaction answers one summary message
function engine(on: On) {
  const rows: Record<string, unknown>[] = []
  on('clock.now', () => ({ value: 0 }))
  on('session.cwd', () => ({ value: '/r' }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === '/bin/sh' && e.argv[4]) rows.push(JSON.parse(e.argv[4]))

    return { value: { exitCode: 0, stdout: e.argv[0] === 'git' ? 'feat-x\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))

  return rows
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const tool = ($: any, name: string, input: Record<string, unknown>, agentId?: string) =>
  $.tool.call({ tool: name, input, ...(agentId ? { agentId } : {}) } as never)

const compact = async ($: any): Promise<readonly SessionMessage[]> => {
  const r = await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'old', toolUses: [] }] } as never)

  return r.messages ?? []
}

describe('carry', () => {
  test('appends a note with branch, last request, open todos and recent files', async ($, on) => {
    engine(on)
    await $.prompt.submit({ text: 'fix the login bug please', wait: false, origin: { kind: 'composer' } })
    await tool($, 'Read', { file_path: '/r/a.ts' })
    await tool($, 'Edit', { file_path: '/r/b.ts' })
    await tool($, 'Read', { file_path: '/r/a.ts' })
    await tool($, 'TodoWrite', { todos: [{ content: 'write test', status: 'in_progress' }, { content: 'done one', status: 'completed' }] })
    const msgs = await compact($)
    expect(msgs.length).toBe(2)
    const note = msgs[1].text
    expect(note).toContain('Branch: feat-x')
    expect(note).toContain('Last request: fix the login bug please')
    expect(note).toContain('- [>] write test')
    expect(note).not.toContain('done one')
    expect(note).toContain('Recent files (newest first): /r/a.ts, /r/b.ts')
  })

  test('adds nothing when no work was seen', async ($, on) => {
    engine(on)
    const msgs = await compact($)
    expect(msgs.length).toBe(1)
  })

  test("ignores subagents' file use", async ($, on) => {
    engine(on)
    await tool($, 'Read', { file_path: '/r/sub.ts' }, 'agent-1')
    const msgs = await compact($)
    expect(msgs.length).toBe(1)
  })

  test('caps the files list and the request length', async ($, on) => {
    engine(on)
    await $.prompt.submit({ text: 'x'.repeat(500), wait: false, origin: { kind: 'composer' } })
    for (let i = 0; i < 20; i++) await tool($, 'Read', { file_path: `/r/f${i}.ts` })
    const note = (await compact($))[1].text
    expect(note).toContain('/r/f19.ts')
    expect(note).not.toContain('/r/f7.ts,')
    expect(note.length).toBeLessThan(1500)
  })
})

describe('metrics', () => {
  test('records snapshot size and re-reads of carried files, without paths or prompt text', async ($, on) => {
    const rows = engine(on)
    await $.prompt.submit({ text: 'secret prompt', wait: false, origin: { kind: 'composer' } })
    await tool($, 'Read', { file_path: '/r/a.ts' })
    await tool($, 'Edit', { file_path: '/r/b.ts' })
    await compact($)
    await tool($, 'Read', { file_path: '/r/a.ts' })
    for (let i = 0; i < 5; i++) await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
    await settle()
    const carry = rows.find(r => r.event === 'carry')!
    expect(carry.files).toBe(2)
    expect(carry.task).toBe(true)
    expect(carry.chars as number).toBeGreaterThan(0)
    const reread = rows.find(r => r.event === 'reread')!
    expect(reread).toMatchObject({ carried: 2, reread: 1, turns: 5 })
    expect(JSON.stringify(rows)).not.toContain('/r/a.ts')
    expect(JSON.stringify(rows)).not.toContain('secret prompt')
  })
})
