#!/usr/bin/env python3
"""Prints one JSON line per subagent run in the last N days, from ~/.claude/projects/*/*/subagents.

Usage counted once per message id; '<synthetic>' messages don't set the model. Prices are list, per million
tokens: input, cache read, cache write, output.
"""
import glob, json, os, re, sys, time

PRICE = {'haiku': (0.1, 0.01, 0.125, 0.5), 'sonnet': (2, 0.2, 2.5, 10), 'opus': (4, 0.2, 5, 20)}


def tier(model):
    return 'haiku' if 'haiku' in model else 'sonnet' if 'sonnet' in model else 'opus' if 'opus' in model else None


def agent(path):
    seen, model, tokens, usd, cwd = set(), None, 0, 0.0, ''
    for line in open(path, errors='replace'):
        try:
            m = json.loads(line)
        except ValueError:
            continue
        cwd = cwd or m.get('cwd', '')
        msg = m.get('message') or {}
        u, mid = msg.get('usage'), msg.get('id')
        if not isinstance(u, dict) or mid in seen:
            continue
        seen.add(mid)
        if tier(msg.get('model') or ''):
            model = msg['model']
        i, r, w, o = (u.get(k) or 0 for k in ('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'))
        tokens += i + r + w + o
        t = tier(model or '')
        if t:
            pi, pr, pw, po = PRICE[t]
            usd += (i * pi + r * pr + w * pw + o * po) / 1e6
    return model, tokens, usd, cwd


cutoff = time.time() - float(sys.argv[1] if len(sys.argv) > 1 else 7) * 86400
for f in glob.glob(os.path.expanduser('~/.claude/projects/*/*/subagents/agent-*.jsonl')):
    try:
        if os.path.getmtime(f) < cutoff:
            continue
        model, tokens, usd, cwd = agent(f)
    except OSError:
        continue
    if not model:
        continue
    try:
        meta = json.load(open(re.sub(r'\.jsonl$', '.meta.json', f)))
    except (OSError, ValueError):
        meta = {}
    print(json.dumps({'type': meta.get('agentType', '?'), 'tier': tier(model), 'usd': round(usd, 4), 'tokens': tokens,
                      'project': os.path.basename(cwd.split('/.claude/worktrees/')[0]), 'desc': meta.get('description', '')[:60]}))
