import type { EngineInterface, On, Register } from 'claude-code'

// MCP server prefixes are UUIDs here, so match on the tool's own suffix
const FIRECRAWL = /__firecrawl_/
const FIRECRAWL_SEARCH = /__firecrawl_search$/
const FIRECRAWL_SCRAPE = /__firecrawl_scrape$/
const EXA = /__\w*_exa$/
const EXA_SEARCH = /__web_search_exa$/
const EXA_FETCH = /__web_fetch_exa$/

// Firecrawl's own warning rides in its response's agent_hints, never in a scraped page's text
const LOW_HINT = /"agent_hints"\s*:\s*\[[^\]]*low on credits/i
const OUT = /insufficient credits|out of credits|no credits remaining|credit limit|payment required|\b402\b/i
const THROTTLED = /rate.?limit|too many requests|\b429\b/i

const OUT_FOR_MS = 24 * 60 * 60 * 1000
const THROTTLED_FOR_MS = 10 * 60 * 1000
const STORE_KEY = 'status'

type Level = 'ok' | 'low' | 'out'
type Status = { firecrawl: Level; firecrawlUntil: number; exa: Level; exaUntil: number }

const FRESH: Status = { firecrawl: 'ok', firecrawlUntil: 0, exa: 'ok', exaUntil: 0 }

// An "out" past its expiry reads as ok, so a top-up is picked up again
const effective = (level: Level, until: number, now: number): Level => (level === 'out' && now > until ? 'ok' : level)

// Read from $.store at every use: another session may have seen a service run out
let status: Status = FRESH

async function load($: EngineInterface): Promise<Status> {
  const saved = await $.store.get(STORE_KEY).catch(() => undefined)
  status = saved && typeof saved === 'object' ? { ...FRESH, ...(saved as Partial<Status>) } : status

  return status
}

async function levels($: EngineInterface) {
  const now = await $.clock.now()
  const s = await load($)

  return { fc: effective(s.firecrawl, s.firecrawlUntil, now), exa: effective(s.exa, s.exaUntil, now), now }
}

// Writes only when a level changes, so ordinary calls cost no store write
async function save($: EngineInterface, next: Status, note: string) {
  const changed = next.firecrawl !== status.firecrawl || next.exa !== status.exa
  if (!changed && next.firecrawlUntil === status.firecrawlUntil && next.exaUntil === status.exaUntil) return
  status = next
  await $.store.set(STORE_KEY, status)
  if (changed) {
    track($, 'search-router', 'level', { firecrawl: next.firecrawl, exa: next.exa })
    $.ui.invalidate('tool.describe')
    $.ui.toast(`search-router: ${note}`, { timeoutMs: 8000 })
  }
}

// <metrics: generated from shared/metrics.ts by shared/sync.sh>
// Shared mod metrics (schema v2). Source of truth: ~/.claude/mods/shared/metrics.ts.
// shared/sync.sh inlines it between the metrics markers in each mod's register.tsx (the engine only lets $
// into functions declared in the same file). Edit here, run sync.sh, never edit an inlined copy.
//
// Rows appended to ~/.claude/mods/metrics.jsonl, all with { v: 2, t, mod, event, ver, session, project }:
//   loaded   once per load (logLoaded, or count() in the mod's session.start hook), at session.start: proves which version of the mod is running
//   turn     once per turn with activity (logTurns, or count() in the mod's turn.complete hook): { hooks: { <event>: calls } }
//   <other>  outcome rows from track(), e.g. merge-gate 'verdict'
// Privacy: never put prompt, command, tool-input or matched-secret text in a row; lengths, kinds and counts only.

const APPEND = 'mkdir -p "$HOME/.claude/mods" && printf "%s\\n" "$1" >> "$HOME/.claude/mods/metrics.jsonl"'


const ctx = { ver: '', session: '', project: '' }
const stats = new Map<string, number>()
let writeFailed = false

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300)

function write($: EngineInterface, mod: string, event: string, data: Record<string, unknown>): void {
  void (async () => {
    const t = new Date(await $.clock.now()).toISOString()
    if (!ctx.project) ctx.project = (await $.session.cwd()).split('/').filter(Boolean).pop() ?? ''
    const line = JSON.stringify({ v: 2, t, mod, event, ver: ctx.ver, session: ctx.session, project: ctx.project, ...data })
    const { exitCode, stderr } = await $.process.run(['/bin/sh', '-c', APPEND, 'mod-metrics', line], { timeoutMs: 3000 })
    if (exitCode !== 0) throw new Error(stderr.trim() || `exit ${exitCode}`)
  })().catch((err: unknown) => {
    if (writeFailed) return
    writeFailed = true
    $.ui.toast(`${mod}: metrics write failed (${message(err)})`)
  })
}

// An outcome row: something the mod decided or did. Fire-and-forget.
function track($: EngineInterface, mod: string, event: string, data: Record<string, unknown> = {}): void {
  write($, mod, event, data)
}

async function loaded($: EngineInterface): Promise<void> {
  const mod = $.plugin.name
  ctx.session = await $.session.id().catch(() => '')
  ctx.project = ''
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }
    ctx.ver = manifest.version ?? ''
  } catch {
    ctx.ver = '?'
  }
  write($, mod, 'loaded', {})
}

function flush($: EngineInterface): void {
  const mod = $.plugin.name
  if (!stats.size) return
  const hooks = Object.fromEntries(stats)
  stats.clear()
  write($, mod, 'turn', { hooks })
}

// The engine allows one hook per event per plugin, and counts them by spelling. A mod that hooks
// session.start or turn.complete itself calls count() in that hook, which writes the row; otherwise
// it calls the matching helper once in register.
function logLoaded(on: On): void {
  on('session.start', async ($, e, next) => {
    await loaded($)

    return next(e)
  })
}

function logTurns(on: On): void {
  on('turn.complete', async ($, e, next) => {
    flush($)

    return next(e)
  })
}

// First statement of every hook: counts the call into this turn's row. The engine only accepts
// function literals as hooks, so calls are counted from inside rather than by wrapping.
// In a session.start hook it also writes the loaded row; in a turn.complete hook it writes the turn row.
function count($: EngineInterface, event: string): void {
  stats.set(event, (stats.get(event) ?? 0) + 1)
  if (event === 'session.start') void loaded($)
  if (event === 'turn.complete') flush($)
}
// </metrics>

export const register: Register = on => {
  logTurns(on)

  on('session.start', async ($, e, next) => {
    count($, 'session.start')
    await load($)
    await $.command.register({ name: 'search-router', description: 'Show Firecrawl / Exa routing status; /search-router reset after a top-up' })

    return next(e)
  })

  on('command.run', { command: 'search-router' }, async ($, e) => {
    count($, 'command.run')
    if (e.args.trim() === 'reset') {
      status = FRESH
      await $.store.set(STORE_KEY, status)
      $.ui.invalidate('tool.describe')
    }
    const { fc, exa, now } = await levels($)
    const until = (ms: number) => (ms > now ? ` (until ${new Date(ms).toLocaleTimeString()})` : '')

    return {
      text: [
        `Firecrawl: ${fc}${fc === 'out' ? until(status.firecrawlUntil) : ''}`,
        `Exa: ${exa}${exa === 'out' ? until(status.exaUntil) : ''}`,
        'Policy: Exa for search and page reads; Firecrawl for structured scrapes, category search and Alexandria; fail over when one is out.',
      ].join('\n'),
    }
  })

  on('tool.describe', async ($, e, next) => {
    count($, 'tool.describe')
    const name = e.tool
    if (!FIRECRAWL.test(name) && !EXA.test(name)) return next(e)

    const base = await next(e)
    const { fc, exa } = await levels($)
    const notes: string[] = []

    if (FIRECRAWL.test(name)) {
      if (fc === 'out' && exa !== 'out') notes.push('UNAVAILABLE: Firecrawl is out of credits. Use the Exa tools (web_search_exa, web_fetch_exa) instead.')
      else {
        if (FIRECRAWL_SEARCH.test(name)) notes.push('Routing: prefer web_search_exa for general web search. Use this for developer/gov/research category search, site-filtered search, or Alexandria data.')
        if (FIRECRAWL_SCRAPE.test(name)) notes.push('Routing: prefer web_fetch_exa to read a page as text. Use this for screenshots, JSON/schema extraction, branding, raw HTML, PDF parsing, or when web_fetch_exa fails.')
        if (fc === 'low') notes.push('Firecrawl credits are LOW: call only for what Exa cannot do.')
      }
    } else if (exa === 'out' && fc !== 'out') {
      notes.push('UNAVAILABLE for now (rate-limited or out of credits). Use firecrawl_search / firecrawl_scrape instead.')
    } else if (EXA_SEARCH.test(name) || EXA_FETCH.test(name)) {
      notes.push('Routing: preferred tool for general web search and reading pages.')
    }

    const description = notes.length ? `${base.description}\n\n${notes.join(' ')}` : base.description
    // Keep Exa's two everyday tools loaded, so preferring them costs no ToolSearch round-trip
    const isEveryday = EXA_SEARCH.test(name) || EXA_FETCH.test(name)

    return isEveryday ? { ...base, description, isDeferred: false } : { ...base, description }
  })

  on('tool.call', async ($, e, next) => {
    count($, 'tool.call')
    const name = String(e.tool)
    const isFirecrawl = FIRECRAWL.test(name)
    const isExa = EXA.test(name)
    if (!isFirecrawl && !isExa) return next(e)

    const { fc, exa, now } = await levels($)
    if (isFirecrawl && fc === 'out' && exa !== 'out') {
      track($, 'search-router', 'rerouted', { from: 'firecrawl' })
      return { deny: 'search-router: Firecrawl is out of credits. Use web_search_exa (search) or web_fetch_exa (read a page) instead. After a top-up the user can run /search-router reset.' }
    }
    if (isExa && exa === 'out' && fc !== 'out') {
      track($, 'search-router', 'rerouted', { from: 'exa' })
      return { deny: 'search-router: Exa is rate-limited or out of credits for now. Use firecrawl_search or firecrawl_scrape instead.' }
    }

    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const text = (ran.text ?? JSON.stringify(ran.result ?? '')).slice(0, 50_000)

    if (isFirecrawl) {
      if (ran.isError && OUT.test(text)) await save($, { ...status, firecrawl: 'out', firecrawlUntil: now + OUT_FOR_MS }, 'Firecrawl is out of credits; routing web tools to Exa for 24h.')
      else if (LOW_HINT.test(text)) await save($, { ...status, firecrawl: 'low' }, 'Firecrawl credits are low; top up at firecrawl.dev. Routing plain search and reads to Exa.')
      else if (!ran.isError && status.firecrawl !== 'ok') await save($, { ...status, firecrawl: 'ok' }, 'Firecrawl credits look fine again.')
    } else {
      const isOut = ran.isError === true && (OUT.test(text) || THROTTLED.test(text))
      if (isOut) await save($, { ...status, exa: 'out', exaUntil: now + (OUT.test(text) ? OUT_FOR_MS : THROTTLED_FOR_MS) }, 'Exa is unavailable; routing web tools to Firecrawl.')
      else if (!ran.isError && status.exa !== 'ok') await save($, { ...status, exa: 'ok' }, 'Exa is available again.')
    }

    return ran
  })
}
