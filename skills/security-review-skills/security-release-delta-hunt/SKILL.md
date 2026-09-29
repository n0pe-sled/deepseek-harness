---
name: security-release-delta-hunt
description: Use as the sole foreground worker to diff the pinned epoch against prior releases and decide whether newly changed code carries a reachable primitive before any live work
disable-model-invocation: true
user-invocable: false
---

# Security Release Delta Hunt

Use this when the campaign needs to know whether a version delta changed the
attack surface: before reopening a closed campaign on a new release, or as a
first-class discovery task. Work read-only against the pinned tree and two
reference tarballs.

1. Confirm the pinned tree hash matches the manifest. Fetch the prior minor
   release, the feature window where new code lives, and the releases leading
   to the pinned patch, the patch window where security fixes live. Verify
   their SHA-256 and record all three hashes in the report.
2. Diff the patch window first. Each changed file is either hardening already
   applied in the pinned tree or an unshipped fix. Either way it closes a
   candidate. Record what the patch changed.
3. Diff the feature window. List surfaces that are newly added or materially
   changed and can write or take effect: controllers, services, auth flows,
   token scopes, import and export paths, API mounts.
4. Run each candidate through the gates the campaign proved in earlier rounds:
   the framework's universal write or mutation gate, if one exists, plus
   user-bound token requirements, admin scope, and per-object authorization.
   Record each near-miss with its trigger and the gate that stops it.
5. Name each candidate's reachability: attacker position, controlled value,
   validation order, earliest effect. Declare the delta family exhausted only
   when every candidate fails trigger or reachability, or is stopped by a gate
   that already held.
6. Return supported, refuted, or exhausted with a near-miss table. State the
   reopen condition: which release or mechanism would reopen this family.

Never run a live request in this task. This skill pairs with
`security-campaign-orchestration`, which runs the delta hunt before the first
live task on any reopen.
