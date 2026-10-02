# Agent Note: Remove the first-run onboarding dialogs

Status: implemented

## Problem

A browser client's first run opened with up to two blocking dialogs that `ui-settings-models` registered into the `settings.onboarding` ledger: a versioned Internal Testing Notice, and a credential step that rendered the Models page's own `ProviderEditor` in credential-only mode for the shipped `deepseek-official` route. Both shared one `OnboardingModal` wrapper, which held `#root` inert while it was visible.

Neither dialog still justified a dialog of its own. The notice existed to state the product's testing stage, a [restoration](../../archived/feature/2026-08-13-shared-modal-product-onboarding.md) that followed the earlier [full-viewport beta notice removal](2026-08-13-remove-first-run-beta-notice.md); a mandatory first-launch interstitial is the most expensive place to carry a sentence a reader can read anywhere else. The credential step duplicated a page the user can open: it collected its key through the same `credentials.set` call the Models page makes, rendered the same `ProviderEditor`, and derived its own readiness from a projection over the joined provider rows ([reading every provider](../bug-fix/2026-08-12-onboarding-reads-every-provider.md)) that re-answered the `providerUsable` question `ModelsSection` already asks. The shipped composition also stops mounting `llm-deepseek`, which was that step's only candidate row, so the step could no longer render an editor at all.

## Decision

Both dialogs and their support are deleted. `WelcomeNotice` and `welcome-store` (with `OnboardingModal`) and `DeepSeekOnboardingDialog` are gone, along with `src/onboarding-copy.ts` (the notice copy, its version, and the `ui-onboarding.welcomeNoticeVersion` acknowledgement field), their locale keys, their package tests, their browser scenarios, their goldens, and the two `settings.onboarding` registrations in `ui-settings-models`. `ProviderEditor` loses the credential-only props (`credentialOnly`, `credentialRequired`, `autoFocusCredential`) and every branch that read them, and `store.ts` loses `onboardingReadiness` and its `OnboardingReadiness` union, whose only reader was the credential step. `providerUsable` stays: the Models page still uses it to decide the setup-card posture.

The Models page is unchanged. It still lists provider rows, opens the setup card for a whole-section provider whose credential reference is unstored, and edits a profile through `settings.mutate` path ops plus `credentials.set`.

Two framework surfaces stay deliberately. The `settings.onboarding` slot declaration and the shell's render site stay, as does the host half's `ui-onboarding` namespace registration, because a stored `settings.yaml` that carries the section must keep validating; with no registrant the ledger is empty and the shell renders nothing ([deregistration rationale](2026-08-13-remove-first-run-beta-notice.md#alternatives-considered)). `OnboardingSurface` in `ui-primitives` also stays: it had already lost its production consumer before this removal, so its disposition is a separate decision.

## Alternatives considered

**Keep the notice and drop only its versioned acknowledgement.** Rejected: the versioned field is what lets revised copy reach a user once, so removing it while keeping the notice would either re-show the notice forever or let the copy age silently.

**Keep the credential step as a one-click path into the key form.** Rejected: the step saved no navigation the Models page does not already offer, while costing a second mount of the same editor, a second readiness projection over the same join, and a modal that holds the application root inert before the user has done anything.

**Keep the credential step but render it only when the credential is missing and no other provider is usable.** Rejected: that is what the step already did, so the argument above is unchanged; the composition that no longer mounts `llm-deepseek` had already taken away its last candidate row.

**Move the notice into a non-blocking banner beside the composer.** Rejected for this change: it is a new surface with a new dismissal rule, and no current evidence asks the product to keep stating its testing stage after every provider setup is one click away.

**Delete the `settings.onboarding` slot declaration and the `ui-onboarding` namespace as well.** Rejected: the slot is a contract a future first-run flow can register into without a shell change, and the namespace registration is what keeps an existing settings document valid at no cost ([earlier rationale](2026-08-13-remove-first-run-beta-notice.md#alternatives-considered)).

## Consequences

A first-run browser now lands directly on the conversation with nothing blocking it, and the only way to a working model is the Models page, which was already the diagnostic surface for every unusable state the deleted step used to report. What the product gives up is the client-side prompt: nothing now tells a user with no usable provider that a key is what is missing, so a deployment that wants that guidance ships its own step or relies on the empty composer and the Models page.

Reintroducing a first-run flow needs no new framework surface. A step registers into the unchanged `settings.onboarding` slot, takes its chrome and copy as its own, decides whether to show with its own readiness fact, and uses a fresh versioned field for re-acknowledgement. `providerUsable` remains the shipped predicate for whether the user already has a route to talk to, so a new step should read it instead of projecting its own.

## Testing

`pnpm run test:gui` covers the client suites and the host-side GUI packages without the deleted specs. The regenerated client catalog (`pnpm run gen-client-catalog`) is the mechanical record that `settings.onboarding` now has no occupants while its declaration and the shell's projection stay. The Models page behavior the deleted dialogs depended on is still pinned where it shipped: `providerUsable` in `readiness.client.spec.ts`, the setup card and its dismissal in `components.client.spec.tsx`, and the browser journey in `models-settings.e2e.ts`. Absence of the dialogs in the assembled product is pinned by the keyless web lane, where scenarios that previously had to pre-acknowledge the notice or mask its modal now boot the same composition unchanged.
