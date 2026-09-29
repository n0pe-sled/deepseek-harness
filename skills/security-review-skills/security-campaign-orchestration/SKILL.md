---
name: security-campaign-orchestration
description: Use when starting, resuming, routing, or stopping an authorized long-running vulnerability research campaign with one foreground worker at a time
disable-model-invocation: true
user-invocable: false
---

# Security Campaign Orchestration

Use this only in the root campaign session. Start from `SCOPE.md`, `STATE.yaml`,
the active manifest, and the approach registry. If a baseline is absent or
incoherent, route infrastructure before analysis.

Keep the current problem as one causal gate. Create a typed task packet and
delegate it through the foreground-only `research_worker` tool. Do not start a
second child or do concurrent local research while the child runs. Consume its
persisted report, reject snapshot/epoch mismatches, update durable state, and
only then select the next role.

Use sequential diversity: route a materially different approach after a
family stalls. Reopen a blocked family only for new evidence or mechanism.
Every closed or refuted family carries an explicit reopen condition in the
registry; a family without one dies without a reason to recheck it. Require
independent validation before `clean-reproduction` and `complete-chain`. If no
complete result exists, preserve the strongest proven capability and the exact
missing gate.

On any reopen trigger, verify the epoch against the manifest first, run the
release-delta hunt (`security-release-delta-hunt`) before spending live
effort, and only then route the first live task.

Record mid-campaign scope changes as dated amendments to `SCOPE.md` that name
the new success-proof language. A parked lead (`security-findings-triage`)
keeps an unpark condition. A restart directive re-baselines from the committed
pinned role to a pristine epoch before any live work; do not resume on a dirty
snapshot.

Close out by freezing canonical fixtures, recording cleanup, packaging the
result without secrets, and exporting the session logs
(`security-session-log-export`).
