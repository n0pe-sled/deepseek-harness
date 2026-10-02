# Agent Note: First-run readiness reads every provider, and the setup card closes

Status: implemented

## Problem

The first-run step and the Models page both asked one question — is `deepseek-official`'s credential stored? — of a join that describes every provider. Two defects followed from that single reading.

A user who configured some other provider (a pi-ai gateway, a self-hosted route) and never wanted the official DeepSeek endpoint was taken over by the full-screen credential prompt on every blank session, with a working model already selected in the composer behind it. Nothing they could do short of storing a DeepSeek key would end it, because the step's readiness projection never looked at the row they had configured.

On the Models page the same reading opened the DeepSeek setup card over them on every visit, and that card could not be closed: it was rendered from row data with no local state a Cancel could flip, so its Cancel button did nothing visible. Worse, it shared the row-editor/add/declare close handler, which unconditionally clears all three of those states — so cancelling the card that owned none of them discarded the add card's draft while staying open itself.

## Decision

One predicate answers what both surfaces actually need. `providerUsable(row)` is true when the route is registered with the adapter registry (`entry.active`) and whatever credential its resolved profile names is stored; a profile naming no reference authenticates through the provider's own path, as does a live route with no settings address, so neither owes this page a key.

`onboardingReadiness`, the projection that answered this for the first-run step, is deleted with that step ([removing the first-run onboarding dialogs](../simplification/2026-10-01-remove-first-run-onboarding-dialogs.md)). `providerUsable` and the setup card's posture are what remain, and they answer the same question the Models page always asked: `needsSetup(row, anyUsable)` makes the setup card the first-run posture alone, so with another provider reachable DeepSeek is an ordinary row carrying the missing-key dot, one Edit click from the same card.

Each card kind now owns its own close handler. `closeSetup` records the provider in a component-local `dismissedSetup` set and touches nothing else; `closeEditor` keeps clearing the three states its cards own. Both route the post-save reload through one `announceSaved` helper. Dismissal is viewing state, like the open editor and the add card: a reload restores the first-run posture for a user still in it.

## Alternatives considered

- **Deriving readiness from the model catalog (`llm.models`) instead of the join.** It answers "can the user talk to something" most directly, but it costs a per-provider listing round trip on a surface that already holds the join, and a provider whose listing fails transiently would re-open onboarding.
- **Requiring `row.configured` in `providerUsable`.** It reads as the stricter check, and would exclude exactly the routes a deployment mounts through `cordis.yml` without a configurable-provider declaration — live routes serving models that this page cannot configure. Registration, not configurability, is what makes a provider usable.
- **Only adding the dismissal, leaving the card auto-opening.** It fixes the Cancel button and nothing else: a user with a working provider would still be handed the DeepSeek form on every visit to Models, which is the same misreading in a quieter form.
- **Persisting the dismissal to settings.** A durable "do not ask about DeepSeek" flag is a second fact about first-run state that can disagree with the join. The credential itself already ends the posture permanently, and every other card on this page is session-local.

## Consequences

The predicate is now the page's own answer: nothing outside `ui-settings-models` reads it, and the Models page is the one surface that reports an unreachable settings address or an unstored credential. A future first-run step that offers more than one route to configure should read `providerUsable` rather than project its own readiness over the join.

## Testing

`readiness.client.spec.ts` pins `providerUsable` over the four join states; the section tests cover the first-run posture, the plain-row posture, and the cancel that collapses the setup card while the add card keeps its draft. The `onboarding-usable-provider` web e2e lane that replayed the scenario through the real wire is deleted with the step it exercised ([removing the first-run onboarding dialogs](../simplification/2026-10-01-remove-first-run-onboarding-dialogs.md)). Absence of a first-run step in the assembled product is pinned by the keyless web lane instead: the Settings scenarios it drives would fail if a blocking step returned.
