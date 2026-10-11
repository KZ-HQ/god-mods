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
