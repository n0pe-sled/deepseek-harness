---
name: security-session-log-export
description: Use at campaign closeout or on operator request to freeze the session record into auditable transcripts and metadata
disable-model-invocation: true
user-invocable: false
---

# Security Session Log Export

Freeze the campaign's session record so the operator can review raw runs after
the session closes. Do this at closeout and after a long campaign, not as a
replacement for the campaign artifacts under `analysis/research/`.

1. Locate the session artifacts. The zstd-compressed `session.jsonl` files
   live under the DSH session state directory. Record the root session id.
2. Map each worker session id to a task id and label: task, role, attempt
   number. Duplicate tasks get an attempt suffix. Order by creation time.
3. For each session, emit the exact decompressed bytes as `session.jsonl`, a
   rendered transcript, and metadata (session id, role, task, depth, preset,
   started UTC, event count). Keep the artifact bytes verbatim.
4. Record provenance in a README: the source path, the exact export tooling,
   and how to regenerate the export.
5. State the secrets policy in the README. Raw logs may hold test credential
   material verbatim. Keep the export inside the authorized workspace and say
   so, or sanitize before sharing.
6. Store the export under `session-logs/` with one folder per worker category.

The export tooling belongs next to the export so it can be re-run. This skill
pairs with `security-campaign-orchestration`, which makes closeout packaging a
standard step.
