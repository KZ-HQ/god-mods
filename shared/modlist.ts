// The god-mods mod list, read from the marketplace's own marketplace.json. Source of truth: ~/.claude/mods/shared/modlist.ts.
// shared/sync.sh inlines it between the modlist markers in each mod that uses it. Edit here, run sync.sh, never edit an inlined copy.
// Undefined when the god-mods marketplace is not installed or its manifest is unreadable.
import type { EngineInterface } from 'claude-code'

export async function godModList($: EngineInterface): Promise<{ names: string[]; file: string } | undefined> {
  try {
    const home = await $.env.get('HOME')
    const known = JSON.parse(await $.fs.read(`${home}/.claude/plugins/known_marketplaces.json`))
    const root = known['god-mods']?.installLocation ?? known['god-mods']?.source?.path
    if (!root) return undefined
    const file = `${root}/.claude-plugin/marketplace.json`
    const names = (JSON.parse(await $.fs.read(file)).plugins as { name: string }[]).map(p => p.name)

    return names.length ? { names, file } : undefined
  } catch {
    return undefined
  }
}
