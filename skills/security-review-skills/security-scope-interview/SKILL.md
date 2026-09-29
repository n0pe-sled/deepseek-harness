---
name: security-scope-interview
description: Use when an operator wants to create, refine, or review a security campaign SCOPE.md through a targeted discussion before research begins
disable-model-invocation: true
user-invocable: false
---

# Security scope interview

Work with the operator to produce a concrete `SCOPE.md`. This is a facilitated
decision session. It is not target research or authorization to operate a lab.

Read an existing `SCOPE.md` first. Inspect nearby tracked documentation or
configuration only when it can answer a scope question. Do not read secret
files or probe a target to fill gaps. Treat local facts as proposals until the
operator accepts them. The operator is the source for authorization and
testing boundaries.

## Run the conversation

- State what is already known, then ask the highest-impact unresolved question.
- Ask one decision-sized question at a time. Combine questions only when one
  answer necessarily settles both. Do not send the operator a questionnaire.
- Explain why the answer changes the campaign when that is not obvious. Use
  concrete examples from the current campaign, not generic security advice.
- After each answer, reflect the proposed `SCOPE.md` wording and let the
  operator correct it. Separate accepted facts, your recommendation, and open
  decisions.
- Resolve contradictions in discussion. Do not silently choose the broader
  target, permission, attacker access, research method, or proof standard.
- Offer a narrow default when useful and state the tradeoff. The operator must
  explicitly approve any broader authority or side effect.

Start with the outcome and authorization. Normally settle these decisions
before baseline details:

1. The exact impact and authority or data affected. A vulnerability class such
   as SSRF, injection, or RCE is not an impact by itself.
2. The authorization owner or record, exact target identifiers and
   environments, and the attacker's starting access.
3. Allowed testing actions and explicit limits. Internet exposure, third-party
   targets, denial of service, persistence, destructive changes, social
   engineering, and access to another person's data are forbidden unless the
   operator lists them.
4. How infrastructure may identify and acquire the baseline, including the
   environment kind, named account or profile, region, services,
   configuration, expected artifacts, and snapshot reset path. Never put a
   credential in scope text.
5. A small, repeatable success proof. Prefer an authorized marker, test-owned
   account, or other reversible effect. State what independent clean
   reproduction must observe.
6. External research sources, artifact and secret handling, numeric resource
   bounds, and stop conditions.

Reorder these topics when a new answer exposes a more important ambiguity.

## Write the file

Map accepted answers to the repository's `SCOPE.md` sections. Preserve useful
local sections and add target-specific fields only when they change decisions.
Use precise identifiers, observable effects, and numeric limits. Refer to
secrets through a named profile, secret manager, or credential source.

Before replacing a non-template file, show the proposed scope and call out the
material changes. Write after the operator accepts the consolidated wording.
If the operator wants to stop early, save a draft only on request. Mark it
`Status: blocked for scope`, list each open decision and its owner, and say
which actions remain unauthorized.

Call the scope ready only when it has no placeholder or open authorization,
target, attacker-access, technique, effect, resource-limit, or reset decision.
Baseline artifact paths may remain assigned to an authorized infrastructure
collection step if the discovery source and target are exact. End with a short
read-back of the authorized outcome, forbidden boundaries, success test, and
first permitted baseline action.
