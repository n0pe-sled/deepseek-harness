---
name: security-findings-triage
description: Use when a test turns up a finding outside the campaign objective, to classify it and decide whether it composes toward the goal without pulling the campaign off its primary path
disable-model-invocation: true
user-invocable: false
---

# Security Findings Triage

A side finding is a real result that does not reach the campaign objective:
a by-design behavior, a low-severity observation, an existence oracle, or an
authenticated authorization gap. Handle it without losing the primary
objective.

1. Record it immediately with the endpoint, request, evidence IDs, and exact
   observable. A finding that lives only in a transcript will be lost.
2. Classify by source. Is the behavior intended, documented, or gated by a
   known rule, or is it a defect? Name the code path that proves the class.
3. Rate reachability and severity. What can the attacker do with it, from which
   position, and with what authority. Existence oracles and by-design reads
   stay low unless something consumes them.
4. Decide compose vs park. Does the finding bridge the objective's missing
   gate, or does it only matter combined with a primitive you do not have?
   Park if the campaign has no path from it to the objective. Escalate only
   when it composes with another primitive you can hold.
5. Preserve the verdict in the registry and the assessment: endpoint, evidence,
   severity, and the compose condition. Never let a side finding redirect the
   next task.

A parked finding carries an unpark condition, not a to-do. This skill pairs
with `security-campaign-orchestration`, which writes mid-campaign scope
amendments when a parked finding is promoted.
