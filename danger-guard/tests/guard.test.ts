import { describe, expect, test } from 'claude-code/testing'

import { assess, segments } from '../hooks/analyze.ts'

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
