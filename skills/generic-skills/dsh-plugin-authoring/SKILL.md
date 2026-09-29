---
name: dsh-plugin-authoring
description: Use when authoring a plugin package outside the deepseek-harness repo (node half, browser client half, or both) — covers the bundle/profile installation model, the real client-bundle contract, and the deltas between the published plugin docs' sample code and the shipped harness
---

# Authoring a Third-Party dsh Plugin

**This skill is guidance distilled from one working session, not the docs.** The authoritative references are inside the checkout: `docs/user/develop/basic/publish.md` (plugin authoring), `packages/client/AGENTS.md` (client half), `packages/tsdown/tsdown.client.ts` (client build config), and `packages/client/src/runtime/module-loader.ts` (bundle wrapper). Where the published sample code and the shipped harness disagree, the shipped harness wins — the deltas below are exactly those disagreements, each verified at runtime.

## Sources of truth (reference checkout only)

- `docs/user/develop/basic/publish.md` — plugin/bundle authoring instructions and sample layout.
- `packages/client/AGENTS.md` — browser client platform contract, component discipline, slot registration.
- `packages/tsdown/tsdown.client.ts` — the client build half (externals, banner/footer, defines). Copy it, do not reinvent it.
- `packages/client/src/runtime/module-loader.ts` — the `window.__ModuleLoader__.load({ id, factory })` wrapper the loader emits.
- `packages/client/src/runtime/registry.ts` — how client-modules scans enabled Loader entries for `dsh.client` packages.

## Installation model (recap)

- A **bundle** is an npm package with a `dsh.bundle.patch` file (a `cordis.patch.yml` snippet). A **profile** is `$DSH_HOME/profiles/<name>`; its manifest lists bundles in `dsh.profile.bundles`. Install with `dsh plugin --profile <name> add <spec>` (spec = local dir or package).
- Layer order: bundles → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays. Bundles are mounted first, so service availability (not list order) drives activation.
- **One patch row is both halves.** client-modules scans enabled Loader entries; any package with `dsh.client` metadata is served to the browser, so a single `insert` row (e.g. `id: system-prompt-editor`, `name: dsh-system-prompt-editor`) covers the node half and the browser roster. The registry serves the package's `./client` export, so after editing the client half you must rebuild the bundle (`prepare` script covers git installs) and restart the harness.

## Package layout checklist

- `package.json`: `type: module`; `main`/`types` point at `lib/index.js` / `lib/index.d.ts`; `exports` map `.` → `./lib/index.js`, `./client` → `./lib/client.js`, `./package.json` → `./package.json`; `files: ["lib", "cordis.patch.yml"]`; `dsh.bundle.patch: "./cordis.patch.yml"`; `dsh.client.platform: "web"`. Runtime deps (cordis, schemastery, dsh-settings, dsh-system-prompt…) are peerDependencies and devDependencies, never bundled.
- `cordis.patch.yml`: one `insert` row — same row serves node and browser.
- `tsdown.config.ts`: node ESM build (`src/index.ts` → `lib/index.js`, deps external, dts on) **plus** a browser half replicating the repo's `clientConfig` (entry `{client: 'src/client/index.ts'}`, outDir `lib`, format cjs, platform browser, `dts: false`, `clean: false`, the exact PLATFORM_MODULES + PRELOADED_CLIENT_EXTERNALS externals, and the same outputOptions banner/footer/intro). No CSS pipeline: inline styles on `--dsw-alias-*` tokens.

## Node half

- Named-export `apply(ctx)`; optional `name`; `Config` is a schemastery schema object. No default export (loader mounts named exports).
- **`import Schema from '@deepseek-ai/schemastery'`** — schemastery ships only a default export; `import { Schema }` fails at runtime even though some sample code shows it.
- **`ctx.settings` and `ctx.systemPrompt` only exist via module augmentation**: add type-only imports (`import type {} from '@deepseek-ai/dsh-settings'`, same for `dsh-system-prompt`) and devDeps for those packages, or the Context type stays bare and those members do not typecheck.
- **`ctx.settings.register(ns, schema)` wants the branded `SettingsNamespace`** — a plain string is not assignable. Either use `settingsNamespace('...')` from `@deepseek-ai/dsh-settings` (value import) or cast locally.
- Register the schema with its full typing: `Config: Schema.object<SettingsSection>({...})` (the `z<Config>`-style typing) so `scope.get()` returns the section type, not `{}`.
- **Section providers are evaluated per assembly**: `ctx.systemPrompt.section({ name, order, text: () => scope.get()?.text ?? '' })` — one registration stays current forever; no re-registration on update. Order bands: `-100` identity, `0` persona, `100–199` tool guidance, `200` default.

## Browser client half

- Entry at `src/client/index.ts`, built to `lib/client.js` as a CJS factory wrapped in `window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports; } });`. Externals = platform baseline (`react`, `jsx-runtime`, `react-dom`, `/client`, `@deepseek-ai/cordis`, `ui-slots`, `ui-primitives`) + `@deepseek-ai/dsh-client-runtime/client`. All `@deepseek-ai` dsh imports in client code must be type-only (`import type {}` pulls Context merges).
- Register UI into the settings page with `ctx.slots.inject(name, () => ctx.slots.register({ id, order, label }, Component))` — the inject form tolerates the slot declaration arriving later; a bare `register` at apply time may run before the slot exists.
- **Bind the settings scope exactly once in `apply`** (`ctx.settingsScope.bind<SectionType>({ namespace: '...' })`): `bind()` registers a `ctx.effect`, so calling it inside the inject factory runs per render occurrence and leaks a controller each time. Explicit generic required — without it `T` infers `unknown` and the register-site type check fails.
- **Component discipline**: components never see `ctx`; props are the four shares (`PropsRuntime`, `PropsRenderSlots`, `PropsStore`, inject face). Inject a `hooks` compartment that exposes a `use<Name>` selector hook over an observable `getSnapshot()/subscribe()` pair, and consume it in the component. `SettingsScope.set(field, value)` rejects; the scope snapshot carries `{status, value, writable, mode, revision}` — render from the snapshot, not from a set() return.

## Verification

- **Smoke test without the harness**: import the built node half, stub the context (assert `typeof Config === 'function'`, schema is a function, sections land at the right order after `apply(ctx, Config({}))` — the loader passes the resolved config, so call with the resolved value). Run with `node tests/smoke.mjs`.
- **Integration test with real providers**: in a temp dir, use the real `dsh-settings-file` (backed by a temp file, never `$DSH_HOME`), real `dsh-system-prompt`, and the plugin, then assert on `renderPrompt(assemble())`: first assembly contains the custom text, second assembly reflects the post-write value, empty text clears the section, document persisted. Handle teardown with `ctx.stop?.()`.
- **Browser hot-test without disturbing the user's instance**: boot a second instance on another port (`dsh web --no-open --port <other>`), verify the client bundle serves 200 and the boot graph lists the plugin. Never kill a running GUI the user relies on; keep it up and verify elsewhere.
- **Write-back is the only reliable "did it land" signal**: the browser `set()` never rejects on host refusal — it recovers by reloading the mirror. Always read back after writing.

## Version facts (as of the working session)

- dsh packages publish at `0.1.1-rc.2` under the `next` tag; `latest` is stale (`0.0.1-rc.1`) for runtime packages. **Pin exact versions, do not use dist-tags.**
- cordis `4.0.1`, schemastery `3.18.1`, tsdown `0.22.x`, TypeScript `6.0.3`, GUI React `18.3.1`.
- `$DSH_HOME/profiles/node_modules` fallback resolves runtime deps for installed bundles; edits to installed packages may not pick up new deps until reinstall.
- `settings.yaml` is machine-global under `$DSH_HOME`; `systemPrompt.section` values are per-registration, so the provider-closure pattern is what keeps the editor live across sessions.
