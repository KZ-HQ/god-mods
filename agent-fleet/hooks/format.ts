// Pure helpers: no `$`, so tests call them directly.

export const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)

  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

// "Bash: npm test", "Edit: scoped.mjs": the tool and the most telling argument.
export function describeTool(e: Record<string, unknown>): string {
  const tool = String(e.tool ?? '').replace(/^mcp__.+?__/, '')
  const arg = [e.command, e.file_path, e.path, e.pattern, e.url, e.query, e.description]
    .find((v): v is string => typeof v === 'string' && v.length > 0)
  if (!arg) return tool
  const shown = e.file_path === arg || e.path === arg ? arg.split('/').pop() ?? arg : arg.replace(/\s+/g, ' ')

  return `${tool}: ${shown.length > 48 ? shown.slice(0, 47) + '…' : shown}`
}

export const GLYPH = { running: '▶', completed: '✔', failed: '✘', killed: '■' } as const
