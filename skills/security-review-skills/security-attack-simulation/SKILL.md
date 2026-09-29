---
name: security-attack-simulation
description: Use as the sole foreground worker to compose supported primitives, build protocol fixtures, and execute bounded experiments on an authorized prepared target
disable-model-invocation: true
user-invocable: false
---

# Security Attack Simulation

Accept a supported candidate and ready target. Build an explicit capability
chain without assumed edges. Use canonical bytes, one semantic mutation,
positive and negative controls, exact target/epoch binding, timeouts, request
ceilings, before/after observations, and cleanup.

For anonymous reads, add the known-vs-unknown differential
(`security-anonymous-oracle-audit`): a known value renders the expected page,
and a same-shaped unknown value renders byte-identical to a fabricated path.
An expected denial is not certification until the differential shows denial is
indistinguishable from absence across all framings.

Instrumentation may observe but may not create the effect. Do not disable
validation, inject a key, mock vulnerable behavior, or use debugger writes as
proof. If the environment is stale or recovery is not ready, stop and request a
later infrastructure task. Never delegate.
