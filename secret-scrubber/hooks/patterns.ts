// Pure helpers: no `$`, so tests call them directly.

// Key shapes with a recognisable prefix: few false positives
const SECRETS: readonly [kind: string, re: RegExp][] = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['anthropic', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g],
  ['github', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['aws', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['stripe', /\b[rs]k_live_[A-Za-z0-9]{20,}/g],
  ['google', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['mailgun', /\bkey-[0-9a-f]{32}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
]

// `API_KEY=...`, `"password": "..."`: the value only, and only when it looks random
const ASSIGNED = /\b([A-Za-z_]*(?:api[_-]?key|secret|token|passw(?:or)?d|client[_-]?secret)[A-Za-z_]*)(\s*[:=]\s*["']?)([A-Za-z0-9/+_.-]{20,})/gi
const looksRandom = (v: string) => /[a-z]/.test(v) && /[A-Z0-9]/.test(v) && !/^(?:true|false|null|undefined|process\.env|\$\{)/i.test(v)

export type Scrubbed = { text: string; kinds: string[] }

export function scrub(text: string): Scrubbed {
  const kinds = new Set<string>()
  let out = text
  for (const [kind, re] of SECRETS) {
    out = out.replace(re, () => {
      kinds.add(kind)

      return `[REDACTED ${kind}]`
    })
  }
  out = out.replace(ASSIGNED, (all, name: string, sep: string, value: string) => {
    if (!looksRandom(value) || value.startsWith('[REDACTED')) return all
    kinds.add('assigned')

    return `${name}${sep}[REDACTED]`
  })

  return { text: out, kinds: [...kinds] }
}

// Files whose job is to hold secrets: writing one there is the right place
export const SECRET_STORE = /(^|\/)(\.env(\.[\w.-]+)?|\.dev\.vars(\.[\w.-]+)?|\.npmrc|\.netrc|[^/]*\.(pem|key|p12))$/

// Example files show the shape, not a real value
export const isExample = (path: string) => /(^|\/)[^/]*(example|sample|template)[^/]*$/i.test(path)
