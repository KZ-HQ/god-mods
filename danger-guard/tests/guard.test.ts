import { describe, expect, test } from 'claude-code/testing'

import { assess, redact, segments } from '../hooks/analyze.ts'

const reasons = (cmd: string) => assess(cmd).map(r => r.reason)

describe('assess', () => {
  test('flags destructive commands', async () => {
    for (const cmd of [
      'rm -rf src',
      'rm -fr src',
      'rm -r -f src',
      'rm --recursive src',
      'sudo rm -Rf /tmp/x',
      'cd src && rm -rf lib',
      'git push --force origin main',
      'git push -f',
      'git push origin +main',
      'git push --force-with-lease',
      'git reset --hard HEAD~1',
      'git clean -fdx',
      'git checkout -- .',
      'git restore .',
      'git branch -D feature',
      'git stash clear',
      'find . -name "*.pyc" -delete',
      'ls | xargs rm',
      'bash -c "rm -rf src"',
      'rm data/raw/2024-01-01.edf',
      'mv data/raw/a.edf /tmp/',
      'echo x > data/app.sqlite',
      'sqlite3 data/app.sqlite "DELETE FROM tenants WHERE id=3"',
      'psql -c "DROP TABLE tenants"',
      'psql -c "delete from tenants;"',
      'uv run alembic downgrade -1',
      'alembic downgrade base',
      'npx wrangler deploy',
      'wrangler d1 migrations apply app --remote',
      'wrangler d1 execute app --remote --command "UPDATE leases SET rent=0"',
      'chmod -R 777 .',
    ]) {
      expect(reasons(cmd).length).toBeGreaterThan(0)
    }
  })

  test('lets everyday commands through', async () => {
    for (const cmd of [
      'ls -la',
      'rm build/out.txt',
      'git push origin main',
      'git status && git diff',
      'git checkout -b feature',
      'git restore --staged file.py',
      'uv run pytest -q 2>&1 | tail -20',
      'make test',
      'sqlite3 data/app.sqlite "SELECT count(*) FROM tenants"',
      'wrangler d1 execute app --remote --command "SELECT 1"',
      'wrangler d1 execute app --local --command "DELETE FROM x WHERE id=1"',
      'psql -c "delete from tenants where id = 1"',
      'cat data/raw/a.edf | head',
      'npm run dev &',
      'echo "rm -rf is dangerous"',
      'rm -rf node_modules dist .next',
      'rm -rf apps/web/.next coverage/ __pycache__',
      'cd sites-owner && rm -rf node_modules',
    ]) {
      expect(reasons(cmd)).toEqual([])
    }
  })

  test('rebuildable folders pass only when every target is one', async () => {
    expect(reasons('rm -rf node_modules src').length).toBeGreaterThan(0)
    expect(reasons('rm -rf /tmp/build').length).toBeGreaterThan(0)
    expect(reasons('rm -rf ../dist').length).toBeGreaterThan(0)
    expect(reasons('rm -rf $OUT/dist').length).toBeGreaterThan(0)
    expect(reasons('rm -rf data/raw/node_modules').length).toBeGreaterThan(0)
  })

  test('tracks a leading cd for previews', async () => {
    const [risk] = assess('cd /repo && git reset --hard')
    expect(risk?.cwd).toBe('/repo')
    expect(risk?.preview.kind).toBe('discard')
  })

  test('splits without breaking redirects or quotes', async () => {
    expect(segments('a 2>&1 | b && c "x;y"')).toEqual(['a 2>&1', 'b', 'c "x;y"'])
  })
})

describe('tool.call', () => {
  test('a safe command runs untouched', async ($, on) => {
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
    const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(ran.deny).toBeUndefined()
    expect(ran.isError).toBeUndefined()
  })

  test('a risky command is denied when the person declines', async ($, on) => {
    let didRun = false
    on('tool.call', { tool: 'Bash' }, () => {
      didRun = true

      return { result: { stdout: '', stderr: '', interrupted: false } }
    })
    on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => ({
      result: { questions: e.questions, answers: { [e.questions[0]!.question]: 'Cancel' } },
    }))
    const ran = await $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/does-not-exist-guard-test' })
    expect(didRun).toBe(false)
    expect(ran.isError === true || ran.deny !== undefined).toBe(true)
  })

  test('a risky command runs when the person approves', async ($, on) => {
    let didRun = false
    on('tool.call', { tool: 'Bash' }, () => {
      didRun = true

      return { result: { stdout: '', stderr: '', interrupted: false } }
    })
    on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => ({
      result: { questions: e.questions, answers: { [e.questions[0]!.question]: 'Run it' } },
    }))
    await $.tool.call({ tool: 'Bash', command: 'git branch -D does-not-exist' })
    expect(didRun).toBe(true)
  })
})

describe('/guard', () => {
  test('off lets a risky command run without asking; on asks again', async ($, on) => {
    let ran = 0
    let asked = 0
    on('tool.call', { tool: 'Bash' }, () => {
      ran += 1

      return { result: { stdout: '', stderr: '', interrupted: false } }
    })
    on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
      asked += 1

      return { result: { questions: e.questions, answers: { [e.questions[0]!.question]: 'Cancel' } } }
    })
    expect((await $.command.run({ command: 'guard', args: 'off' })).text).toBe('danger-guard is OFF for this session.')
    await $.tool.call({ tool: 'Bash', command: 'git branch -D gone' })
    expect([ran, asked]).toEqual([1, 0])

    expect((await $.command.run({ command: 'guard', args: 'on' })).text).toBe('danger-guard is on.')
    await $.tool.call({ tool: 'Bash', command: 'git branch -D gone' })
    expect([ran, asked]).toEqual([1, 1])
    expect((await $.command.run({ command: 'guard', args: '' })).text).toBe('danger-guard is on.')
  })

  test('asks before an Edit to a protected path, and denies when declined', async ($, on) => {
    let wrote = false
    on('fs.exists', () => ({ value: true }))
    on('tool.call', { tool: 'Edit' }, () => {
      wrote = true

      return { result: 'ok' }
    })
    on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => ({
      result: { questions: e.questions, answers: { [e.questions[0]!.question]: 'Cancel' } },
    }))
    const r = await $.tool.call({ tool: 'Edit', file_path: '/app/data/app.sqlite', old_string: 'a', new_string: 'b' } as never)
    expect(wrote).toBe(false)
    expect(r.deny).toMatch(/protected path \/app\/data\/app\.sqlite/)
  })
})

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// Stubs Bash (never really runs) and AskUserQuestion (answers Cancel), recording the question.
function holdAndRecord(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const seen = { question: '', ran: false }
  on('tool.call', { tool: 'Bash' }, () => {
    seen.ran = true

    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    seen.question = e.questions[0]!.question

    return { result: { questions: e.questions, answers: { [e.questions[0]!.question]: 'Cancel' } } }
  })

  return seen
}

describe('redact', () => {
  test('masks secrets on a command line', async () => {
    for (const [cmd, secret] of [
      ['curl -H "Authorization: Bearer abcdef1234567890xyz" https://x', 'abcdef1234567890xyz'],
      ['CLOUDFLARE_API_TOKEN=s3cr3tvalue wrangler deploy', 's3cr3tvalue'],
      ['mysql -u root -phunter22 db', 'hunter22'],
      ['psql postgres://admin:pa55word@db/x', 'pa55word'],
      ['tool --password=letmein', 'letmein'],
      ['tool --api-key k-123456', 'k-123456'],
      ['echo sk-ant-api03-AAAAAAAAAAAAAAAAAAAA', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAA'],
      ['git push https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x', 'ghp_abcdefghij'],
      ['export AWS=AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP'],
    ] as const) {
      expect(redact(cmd).includes(secret)).toBe(false)
    }
  })

  test('leaves ordinary commands readable', async () => {
    for (const cmd of ['rm -rf build/tmp', 'git reset --hard HEAD~1', 'find . -print -delete', 'wrangler d1 execute DB --remote --command "DELETE FROM tenants"']) {
      expect(redact(cmd)).toBe(cmd)
    }
  })
})

describe('summary', () => {
  test('shows the Haiku summary first and the raw command as a last line', async ($, on) => {
    let prompt = ''
    on('model.complete', (_$, e) => {
      prompt = e.prompt

      return { value: { isAnswered: true, text: 'Does: deletes src.\nRisk: files are gone; not undoable.', usage: USAGE } }
    })
    const seen = holdAndRecord(on)
    await $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/does-not-exist-guard-test' })
    expect(seen.ran).toBe(false)
    expect(seen.question).toMatch(/^Risky: recursive delete/)
    expect(seen.question).toMatch(/Summary \(Haiku, advisory\):\nDoes: deletes src\.\nRisk: files are gone/)
    expect(seen.question).toMatch(/Command: rm -rf \/tmp\/does-not-exist-guard-test\n\nRun it\?$/)
    expect(prompt).toMatch(/rm -rf/)
  })

  test('never sends a secret to the model', async ($, on) => {
    let prompt = ''
    on('model.complete', (_$, e) => {
      prompt = e.prompt

      return { value: { isAnswered: true, text: 'Does: x\nRisk: y', usage: USAGE } }
    })
    holdAndRecord(on)
    await $.tool.call({ tool: 'Bash', command: 'API_TOKEN=supersecretvalue123 rm -rf /tmp/does-not-exist-guard-test' })
    expect(prompt).toMatch(/rm -rf/)
    expect(prompt.includes('supersecretvalue123')).toBe(false)
  })

  test('an unanswered summary falls back to the raw command and still asks', async ($, on) => {
    on('model.complete', () => ({ value: { isAnswered: false, reason: 'aborted', usage: USAGE } }))
    const seen = holdAndRecord(on)
    const r = await $.tool.call({ tool: 'Bash', command: 'git branch -D gone' })
    expect(seen.ran).toBe(false)
    expect(r.deny).toMatch(/did not approve/)
    expect(seen.question).toMatch(/^Risky: force-deletes branch gone\n\n\$ git branch -D gone/)
    expect(seen.question.includes('Summary')).toBe(false)
  })

  test('a summary call that throws still asks, never fails open', async ($, on) => {
    on('model.complete', () => {
      throw new Error('model blocked')
    })
    const seen = holdAndRecord(on)
    const r = await $.tool.call({ tool: 'Bash', command: 'git branch -D gone' })
    expect(seen.ran).toBe(false)
    expect(seen.question).toMatch(/\$ git branch -D gone/)
    expect(r.deny).toMatch(/did not approve/)
  })
})
