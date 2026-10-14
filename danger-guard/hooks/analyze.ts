// Pure command analysis: no `$`, so tests can call it directly.
// Best-effort pattern matching, not a parser or a sandbox.

// Paths whose loss can't be redone: raw data, databases, backups.
export const PROTECTED: readonly RegExp[] = [
  /(^|\/)data\/raw(\/|$)/,
  /\.(sqlite3?|db)(-wal|-shm|-journal)?$/,
  /(^|\/)backups?(\/|$)/,
]

export type Preview =
  | { kind: 'rm'; targets: string[] }
  | { kind: 'push' }
  | { kind: 'discard' }
  | { kind: 'clean'; withIgnored: boolean }
  | { kind: 'branch'; branch: string }
  | { kind: 'none' }

export type Risk = { reason: string; preview: Preview; cwd?: string }

export const isProtected = (path: string) => PROTECTED.some(re => re.test(path))

// Build outputs and caches a command rebuilds: deleting them loses nothing.
const REBUILDABLE = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.vite',
  'coverage', '.nyc_output', '__pycache__', '.pytest_cache', '.ruff_cache', '.mypy_cache', '.tox', '.cache',
])

// A plain relative path whose last part is a rebuildable folder: `node_modules`, `apps/web/.next`.
// Absolute paths, `..`, globs and variables never qualify.
export const isRebuildable = (path: string) =>
  !path.startsWith('/') && !path.startsWith('~') && !/(^|\/)\.\.(\/|$)|[*?[\]$`{}]/.test(path) && REBUILDABLE.has(path.replace(/\/+$/, '').split('/').pop() ?? '')

// Splits on && || ; | and newlines outside quotes.
export function segments(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < command.length) { cur += c + command[++i]; continue }
      if (c === quote) quote = null
      cur += c
      continue
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue }
    if (c === '\\' && i + 1 < command.length) { cur += c + command[++i]; continue }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') { out.push(cur); cur = ''; i++; continue }
    const isBackground = c === '&' && command[i - 1] !== '>' && command[i + 1] !== '>'
    if (c === ';' || c === '|' || c === '\n' || isBackground) { out.push(cur); cur = ''; continue }
    cur += c
  }
  out.push(cur)

  return out.map(s => s.trim()).filter(Boolean)
}

// Shell-ish word split: respects quotes, drops them.
export function words(segment: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let quote: string | null = null
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue }
    if (c === '\\' && i + 1 < segment.length) { cur += segment[++i]; has = true; continue }
    if (/\s/.test(c)) { if (has || cur) out.push(cur); cur = ''; has = false; continue }
    cur += c
  }
  if (has || cur) out.push(cur)

  return out
}

const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'nohup', 'time', 'env', 'exec', 'nice'])

const RUNNERS = new Set(['npx', 'bunx', 'pnpx'])
const RUN_SUBCOMMAND = new Set(['uv', 'poetry', 'pdm', 'pipenv', 'hatch', 'pnpm', 'yarn', 'bun'])

// Drops leading VAR=x assignments, wrappers like sudo and runners like `uv run`.
function strip(argv: string[]): string[] {
  let i = 0
  for (;;) {
    const a = argv[i]
    if (a === undefined) break
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a) || WRAPPERS.has(a)) i++
    else if (RUNNERS.has(a)) i++
    else if (RUN_SUBCOMMAND.has(a) && ['run', 'exec', 'dlx', 'x'].includes(argv[i + 1] ?? '')) i += 2
    else if (a.startsWith('-') && i > 0) i++ // a runner's own flags: `uv run --with x`
    else break
  }

  return argv.slice(i)
}

const shortFlags = (args: string[]) =>
  args.filter(a => /^-[A-Za-z]+$/.test(a)).map(a => a.slice(1)).join('')

const SQL_DESTRUCTIVE = /\b(drop\s+(table|database|schema|view|index)|truncate(\s+table)?\s+\w|alter\s+table\s+\w+\s+drop)\b/i
const SQL_DELETE_NO_WHERE = /\bdelete\s+from\s+[\w."`\[\]]+\s*(;|$|["'])/i
const SQL_WRITE = /\b(insert|update|delete|drop|alter|create|replace|truncate)\b/i

function assessSegment(argv: string[], raw: string, cwd: string | undefined): Risk[] {
  const risks: Risk[] = []
  const add = (reason: string, preview: Preview = { kind: 'none' }) => risks.push({ reason, preview, cwd })
  const [cmd = '', ...args] = strip(argv)
  const base = cmd.split('/').pop() ?? cmd

  // Shells and eval: assess what they would run
  if (['bash', 'sh', 'zsh', 'dash'].includes(base)) {
    const i = args.indexOf('-c')
    if (i >= 0 && args[i + 1] !== undefined) return assess(args[i + 1]!, cwd)
  }
  if (base === 'eval') return assess(args.join(' '), cwd)
  if (base === 'xargs' && args.some(a => a === 'rm' || a.endsWith('/rm'))) {
    add('xargs rm: deletes files listed on its input')
  }

  const operands = args.filter(a => !a.startsWith('-'))

  if (base === 'rm' || base === 'rmdir' || base === 'unlink' || base === 'trash') {
    const flags = shortFlags(args)
    const recursive = /[rR]/.test(flags) || args.includes('--recursive')
    const hitsProtected = operands.filter(isProtected)
    const onlyRebuildable = operands.length > 0 && operands.every(isRebuildable)
    if (recursive && !onlyRebuildable) add(`recursive delete (rm ${args.filter(a => a.startsWith('-')).join(' ')})`, { kind: 'rm', targets: operands })
    else if (hitsProtected.length) add(`deletes protected data: ${hitsProtected.join(', ')}`, { kind: 'rm', targets: operands })
    if (operands.some(t => t === '/' || t === '~' || t === '.' || t === '..' || t === '*' || t === '$HOME')) {
      add('delete target is a root, home, current or parent directory')
    }
  }

  if (base === 'find' && (args.includes('-delete') || /-exec(dir)?\s+(\S*\/)?rm\b/.test(raw))) {
    add('find deletes what it matches')
  }

  if ((base === 'mv' || base === 'cp' || base === 'rsync') && operands.some(isProtected)) {
    add(`${base} touches protected data: ${operands.filter(isProtected).join(', ')}`)
  }
  if (base === 'rsync' && args.some(a => a.startsWith('--delete'))) add('rsync --delete removes files at the destination')

  if ((base === 'chmod' || base === 'chown') && /[R]/.test(shortFlags(args))) add(`recursive ${base}`)
  if (base === 'dd' || base.startsWith('mkfs') || base === 'diskutil') add(`${base}: writes to disks directly`)

  if (base === 'git') {
    const sub = operands[0]
    const rest = args.slice(args.indexOf(sub ?? '') + 1)
    const flags = shortFlags(rest)
    if (sub === 'push' && (rest.some(a => a === '--force' || a.startsWith('--force-with-lease') || a === '--mirror' || a === '--delete') || /f/.test(flags) || rest.some(a => /^\+/.test(a) || /^:/.test(a)))) {
      add('force push or remote delete: rewrites what the remote has', { kind: 'push' })
    }
    if (sub === 'reset' && rest.includes('--hard')) add('git reset --hard: discards uncommitted changes', { kind: 'discard' })
    if (sub === 'clean' && /f/.test(flags)) add('git clean: deletes untracked files', { kind: 'clean', withIgnored: /x/i.test(flags) })
    if ((sub === 'checkout' || sub === 'restore') && rest.includes('.') && !rest.includes('--staged')) {
      add(`git ${sub} .: discards uncommitted changes`, { kind: 'discard' })
    }
    if (sub === 'checkout' && /f/.test(flags)) add('git checkout -f: discards uncommitted changes', { kind: 'discard' })
    if (sub === 'branch' && (/D/.test(flags) || (rest.includes('--delete') && rest.includes('--force')))) {
      const branch = rest.filter(a => !a.startsWith('-'))[0] ?? ''
      add(`force-deletes branch ${branch}`, { kind: 'branch', branch })
    }
    if (sub === 'stash' && (rest[0] === 'drop' || rest[0] === 'clear')) add(`git stash ${rest[0]}: stashed work is lost`)
    if (sub === 'filter-branch' || sub === 'filter-repo') add(`git ${sub}: rewrites history`)
    if (sub === 'rebase' && rest.includes('--root')) add('git rebase --root: rewrites all history')
  }

  if (base === 'alembic' && operands[0] === 'downgrade') add('alembic downgrade: drops schema changes and their data')
  if (base === 'sqlite3' && SQL_WRITE.test(raw)) {
    const db = operands.find(isProtected)
    if (db) add(`writes to database ${db}`)
  }

  if (base === 'wrangler') {
    const w = operands
    const remote = args.includes('--remote')
    if (w[0] === 'deploy' || w[0] === 'publish') add('wrangler deploy: ships to production')
    if (w[0] === 'd1' && w[1] === 'migrations' && w[2] === 'apply' && remote) add('applies D1 migrations to the remote (production) database')
    if (w[0] === 'd1' && w[1] === 'execute' && remote && (SQL_WRITE.test(raw) || args.some(a => a.startsWith('--file')))) {
      add('writes to the remote (production) D1 database')
    }
    if (w.includes('delete') && ['d1', 'r2', 'kv', 'queues'].includes(w[0] ?? '')) add(`wrangler ${w.slice(0, 3).join(' ')}: deletes a Cloudflare resource`)
  }

  // Redirect that overwrites protected data: `> data/raw/x`
  const redirect = raw.match(/(^|[^>&0-9])>\s*([^\s>&|;]+)/)
  if (redirect && isProtected(redirect[2]!)) add(`overwrites protected data: ${redirect[2]}`)

  return risks
}

// The risks of a whole Bash command, in order; empty when nothing matched.
export function assess(command: string, cwd?: string): Risk[] {
  const risks: Risk[] = []
  if (SQL_DESTRUCTIVE.test(command)) risks.push({ reason: 'destructive SQL (DROP / TRUNCATE)', preview: { kind: 'none' }, cwd })
  if (SQL_DELETE_NO_WHERE.test(command)) risks.push({ reason: 'DELETE without WHERE', preview: { kind: 'none' }, cwd })
  let at = cwd
  for (const seg of segments(command)) {
    const argv = words(seg)
    if (argv[0] === 'cd' && argv[1] !== undefined) {
      at = argv[1].startsWith('/') || argv[1].startsWith('~') || at === undefined ? argv[1] : `${at}/${argv[1]}`
      continue
    }
    risks.push(...assessSegment(argv, seg, at))
  }
  const seen = new Set<string>()

  return risks.filter(r => !seen.has(r.reason) && seen.add(r.reason))
}

// Masks secrets in a command before it leaves the machine for a summary.
// Copied shapes from secret-scrubber (mods install from separate folders, so no cross-mod import),
// plus the forms secrets take on a command line. Errs toward masking.
const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
]
const MASK = '[REDACTED]'

export function redact(command: string): string {
  let out = command
  for (const re of SECRET_SHAPES) out = out.replace(re, MASK)

  return out
    // NAME=value / NAME: value where the name says secret
    .replace(/\b([A-Za-z_][\w-]*(?:token|key|secret|passw(?:or)?d|pwd|auth|credential|cookie|session)[\w-]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, `$1$2${MASK}`)
    // --password=x, --token x, --api-key x
    .replace(/(--?[\w-]*(?:token|key|secret|passw(?:or)?d|pwd|auth|credential)[\w-]*)(=|\s+)("[^"]*"|'[^']*'|[^\s-]\S*)/gi, `$1$2${MASK}`)
    // Authorization: Bearer x / Basic x
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MASK}`)
    // user:pass@ in URLs
    .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, `$1${MASK}@`)
    // mysql -pSECRET
    .replace(/(\bmysql(?:dump|admin)?\b[^|;&]*?\s-p)(?!\s)\S+/g, `$1${MASK}`)
    // long random-looking runs: hex or base64
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, MASK)
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, m => (/[a-z]/.test(m) && /[A-Z0-9]/.test(m) ? MASK : m))
}
