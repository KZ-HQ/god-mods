import type { Register } from 'claude-code'

const FALLBACK = [
  'agent-fleet', 'context-gauge', 'danger-guard', 'limit-guard', 'long-turn-notify', 'merge-gate',
  'mod-stats', 'next-steps', 'prompt-shaper', 'search-router', 'secret-scrubber', 'switchboard',
  'test-on-edit', 'topic-drift', 'where-am-i', 'worktree-janitor',
]
let GOD_MODS = new Set(FALLBACK)
let listSource = 'built-in fallback'

async function loadModList($: any) {
  try {
    const home = await $.env.get('HOME')
    const known = JSON.parse(await $.fs.read(`${home}/.claude/plugins/known_marketplaces.json`))
    const root = known['god-mods']?.installLocation ?? known['god-mods']?.source?.path
    if (!root) return
    const file = `${root}/.claude-plugin/marketplace.json`
    const names = JSON.parse(await $.fs.read(file)).plugins.map((p: any) => p.name).filter((n: string) => n !== 'mod-faults')
    if (names.length) {
      GOD_MODS = new Set(names)
      listSource = file
    }
  } catch {}
}
const isGodMod = (plugin: string) => GOD_MODS.has(plugin.split('@')[0]) || plugin.endsWith('@god-mods')
const FAULTS = new Set(['skipped', 'kept', 'expired', 'caught', 'rejected'])
const KEEP = 1000

type Fault = { at: string; plugin: string; event: string; outcome: string; reason?: string; ms: number }

let path: string | undefined
let lines: string[] = []
let writing = Promise.resolve()
const seen = new Set<string>()
const counts = new Map<string, number>()

async function logPath($: any) {
  path ??= `${await $.env.get('HOME')}/.claude/logs/god-mods-faults.jsonl`
  return path
}

function record($: any, faults: Fault[]) {
  for (const f of faults) counts.set(f.plugin, (counts.get(f.plugin) ?? 0) + 1)
  writing = writing
    .then(async () => {
      const file = await logPath($)
      lines = [...lines, ...faults.map(f => JSON.stringify(f))].slice(-KEEP)
      await $.fs.write(file, lines.join('\n') + '\n')
    })
    .catch(() => undefined)
}

async function watch($: any, e: any, next: any) {
  try {
    return await next(e)
  } finally {
    try {
      const faults: Fault[] = []
      for (const t of next.trace ?? []) {
        if (!isGodMod(t.plugin)) continue
        seen.add(t.plugin)
        if (!FAULTS.has(t.outcome) || t.reason?.startsWith('bypassed')) continue
        const at = new Date().toISOString()
        faults.push({ at, plugin: t.plugin, event: t.event, outcome: t.outcome, reason: t.reason, ms: Math.round(t.ms) })
      }
      if (faults.length) record($, faults)
    } catch {}
  }
}

async function start($: any, e: any, next: any) {
  await loadModList($)
  try {
    const file = await logPath($)
    if (await $.fs.exists(file)) lines = (await $.fs.read(file)).split('\n').filter(Boolean).slice(-KEEP)
  } catch {}
  await $.command.register({ name: 'mod-faults', description: 'Show god-mods faults this session and which mods are watched' })
  return watch($, e, next)
}

async function report($: any) {
  const faults = [...counts].map(([p, n]) => `  ${p}: ${n}`).join('\n') || '  none'
  const watched = [...seen].sort().join(', ') || 'none yet'
  return { text: `god-mods faults this session:\n${faults}\nWatched beneath this mod: ${watched}\nMod list (${GOD_MODS.size}): ${listSource}\nLog: ${await logPath($)}` }
}

export const register: Register = on => {
  on('session.start', start as any)
  on('command.run', { command: 'mod-faults' }, report as any)
  on('session.end', watch as any)
  on('session.measure', watch as any)
  on('session.append', watch as any)
  on('turn.start', watch as any)
  on('turn.complete', watch as any)
  on('prompt.submit', watch as any)
  on('prompt.compose', watch as any)
  on('tool.call', watch as any)
  on('tool.describe', watch as any)
  on('agent.spawn', watch as any)
  on('command.run', watch as any)
  on('ui.render', watch as any)
  on('ui.close', watch as any)
}
