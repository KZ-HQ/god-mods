---
description: Resume the work a usage limit cut off (limit-guard)
argument-hint: "[what to resume]"
---
The usage limit that cut off earlier work has reset. Resume where the work stopped.

What limit-guard recorded as interrupted: $ARGUMENTS

For each interrupted agent or task, check its worktree and branch first (git status, git log), keep what was committed, and continue or restart only what did not finish. Commit at each step so another interruption loses nothing.

If nothing was actually in progress, say so in one line and stop.
