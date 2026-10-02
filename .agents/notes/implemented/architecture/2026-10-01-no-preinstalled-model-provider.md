# Agent Note: the shipped product pre-installs no model provider

Status: implemented

## Problem

`dsh-base` mounted the native DeepSeek adapter and pinned the shared default model to `deepseek-official` / `deepseek-v4-flash`. Every deployment that installed this fork therefore had a model provider it never chose, and a first run asked the user to accept an internal-testing notice and then to paste a DeepSeek API key before the composer would send a prompt. A deployment whose users reach no DeepSeek endpoint, including this fork's own use against a local model server, started in a state its owner had to undo, and the adapter would have sent the first request of every user who accepted the prompt to DeepSeek.

The composition pin also made the empty state unrepresentable. `AgentDefaultModelConfig.Config` required `provider` and `model`, so the base layer had to name a pair, and `currentSelection()` could never report that no model was selected.

## Decision

`packages/bundle/base/cordis.patch.yml` mounts no model provider. The `llm-deepseek` row is gone, and the `agent-default-model` row carries no `provider` and no `model`. `llm-pi-ai` stays mounted and dormant: it registers no route until an `llm-pi-ai:` settings section supplies provider profiles, which is what the web Models page writes. A deployment that wants the DeepSeek route mounts `llm-deepseek` in its own layer, and the closure still carries that package so the row resolves.

`AgentDefaultModelConfig` no longer requires a composition pair. Its composition `Config` accepts an absent pair, `AgentDefaultModelSettings` and its settings schema accept a section that names neither field, and `currentSelection()` returns undefined when neither the composition entry nor the saved `agent-default-model:` section names a provider and a model. The settings section keeps the same namespace, `saveSelection()` keeps writing the complete section, and the user layer still outranks the composition layer, so a saved selection behaves exactly as before.

The browser client already rendered this state, so the empty selection needs no new client work. `ui-model-selection` shows the `Select model` fallback and its empty catalog when `current` is null, and `ui-settings-models` renders its provider cards from the joined snapshot.

The host plane reports and refuses an empty selection instead of serving a route nobody registered:

- `session.models` reports the session selection as null, which the wire type already allowed, and continues to report `routable` separately.
- `session.prompt` refuses a turn with `model-unavailable` and names that no model is selected for the session, which is the existing enforcement point rather than a new one.
- The headless direct entry point writes a diagnostic naming that no model is selected and exits non-zero instead of creating an Agent whose provider nothing serves.

Both first-run dialogs are gone from `packages/client/ui-settings-models`: the versioned internal-testing notice and the conditional `deepseek-official` credential step. The `settings.onboarding` slot they occupied stays declared by `ui-settings`, so a deployment or third-party plugin may still contribute a step, and the `ui-onboarding` settings namespace stays registered by `ui-settings-general` so a stored document keeps validating.

## Alternatives considered

**Keep the DeepSeek route mounted and clear only the default model.** The adapter would still register `deepseek-official`, so the Models page would offer a route with no key and the picker would list models nothing serves. The route itself is what the removal is about, not only the preselection.

**Ship a first-run provider picker instead of removing the prompt.** The product has no provider to pick from, so a picker would ask the user to choose among nothing. The Models page is the surface that adds a provider, and it is reachable from Settings at any time rather than only on a first run.

**Keep the internal-testing notice for this fork's own builds.** The notice is upstream's copy for the upstream release, and this fork ships neither the release nor the DeepSeek endpoint the notice describes. Its acknowledgements are stored in a settings namespace that no longer has a reader.

**Remove the adapter package from the shipped closure.** A deployment mounting the `llm-deepseek` row would then fail to resolve its bundle, which turns a composition choice into a staging bug. The package stays in the closure and only the row leaves the composition.

**Require every entry point to name a model.** The web surface creates sessions on client request with no command line to name one, and the Models page is where a person names it. Requiring a flag would make the browser UI unusable rather than configured.

## Consequences

A fresh installation has no model provider until its owner adds one on the Models page, so its first session starts with the composer inert and the model seat showing `Select model`. A prompt that reaches the host with no selection is refused with `model-unavailable` rather than reaching an endpoint the deployment never chose. A deployment that pins a pair in `agent-default-model` or in `settings.yaml` behaves as before, because the user layer and the composition layer still outrank the empty default.

The trade-off is one extra step before the first prompt for a deployment that configures its provider by composition. That cost is paid once per installation, and it replaces a first run that every deployment paid whether or not it wanted the DeepSeek route.

The two SDK entry points lose their pre-installed provider with it. The bundled Python runtime no longer mounts `llm-deepseek`, and the JSON-RPC SDK server no longer defaults `provider` and `model` to `deepseek-official`, so a caller names its provider and model.

## Testing

The base bundle test asserts that the patch list mounts no `llm-deepseek` row and pins no default model. The settings-section tests cover an absent pair, a composed pair, and a saved pair, and the host gateway tests cover a session with no selection reporting null and refusing a prompt. Config-dump acceptance composes the shipped web and headless profiles and requires the composed tree to carry no provider row and no default pair.
