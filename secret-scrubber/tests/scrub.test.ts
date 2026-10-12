import { describe, expect, test } from 'claude-code/testing'

import { scrub } from '../hooks/patterns.ts'

// Fake values in the right shapes
const GH = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
const ANT = 'sk-ant-api03-' + 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0'
const AWS = 'AKIA' + 'IOSFODNN7EXAMPLE'

describe('scrub', () => {
  test('masks known key shapes and keeps the rest', async () => {
    const r = scrub(`token=${GH}\nkey ${ANT}\naws ${AWS}\nplain text stays`)
    expect(r.text).not.toContain(GH)
    expect(r.text).not.toContain(ANT)
    expect(r.text).not.toContain(AWS)
    expect(r.text).toContain('plain text stays')
    expect(r.kinds).toEqual(expect.arrayContaining(['github', 'anthropic', 'aws']))
  })

  test('masks assigned values only when they look random', async () => {
    expect(scrub('MAILGUN_API_KEY=Xk29fLq8Zr7Tn4Pw1Vb6Hs3D').text).toBe('MAILGUN_API_KEY=[REDACTED]')
    expect(scrub('const token = process.env.API_TOKEN_VALUE_FROM_ENV').kinds).toEqual([])
    expect(scrub('password: placeholderpasswordvalue').kinds).toEqual([])
  })

  test('masks a private key block', async () => {
    const r = scrub('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----')
    expect(r.text).toBe('[REDACTED private-key]')
  })
})

describe('hooks', () => {
  test('refuses writing a real key into source, allows env files', async ($, on) => {
    let wrote = 0
    on('tool.call', { tool: 'Write' }, () => {
      wrote += 1

      return { result: { type: 'create', filePath: 'x', content: '', structuredPatch: [] } } as never
    })
    const bad = await $.tool.call({ tool: 'Write', file_path: '/r/lib/mail.mjs', content: `const k = '${GH}'` })
    expect(bad.deny).toMatch(/github key into \/r\/lib\/mail\.mjs/)
    await $.tool.call({ tool: 'Write', file_path: '/r/.dev.vars', content: `GH=${GH}` })
    expect(wrote).toBe(1)
  })
})

describe('tool output', () => {
  const append = (door: string, text: string) =>
    ({ door, uuid: 'u1', origin: { kind: 'tool', tool: 'Bash' }, message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] } }) as never

  function engine(on: Parameters<Parameters<typeof test>[1]>[1]) {
    const seen: string[] = []
    const toasts: string[] = []
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    on('clock.now', () => ({ value: 0 }))
    on('session.cwd', () => ({ value: '/r' }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('session.append', ($, e, next) => {
      seen.push(JSON.stringify(e.message.content))

      return next(e)
    })

    return { seen, toasts }
  }

  test('masks a key in tool output before it is stored, and says so once', async ($, on) => {
    const t = engine(on)
    await $.session.append(append('tool-result', `token=${GH}\nstatus ok`))
    expect(t.seen[0]).not.toContain(GH)
    expect(t.seen[0]).toContain('status ok')
    expect(t.toasts).toEqual(['secret-scrubber: masked github in tool output'])
  })

  test('leaves other messages and clean output untouched', async ($, on) => {
    const t = engine(on)
    await $.session.append(append('prompt', `my key is ${GH}`))
    await $.session.append(append('tool-result', 'nothing secret here'))
    expect(t.seen[0]).toContain(GH)
    expect(t.seen[1]).toContain('nothing secret here')
    expect(t.toasts).toEqual([])
  })

  test('refuses an Edit that adds a key to source', async ($, on) => {
    let edited = false
    on('tool.call', { tool: 'Edit' }, () => {
      edited = true

      return { result: 'ok' } as never
    })
    const r = await $.tool.call({ tool: 'Edit', file_path: '/r/src/aws.ts', old_string: 'x', new_string: `const id = '${AWS}'` } as never)
    expect(edited).toBe(false)
    expect(r.deny).toMatch(/key into \/r\/src\/aws\.ts/)
  })
})
