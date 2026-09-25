# Agent Note: English-only documentation

Status: implemented

## Problem

The repository shipped every human-facing document as a bilingual pair: an English `foo.md`, a Chinese `foo.zh.md`, and a machine-checked `foo.i18n.yaml` consistency sidecar that recorded both sides' Git blob hashes. A corpus-wide pairing gate validated the set, the documentation website projected two route trees from it, `packages/client/locale` shipped a Chinese dictionary with browser-derived locale negotiation, and a `dsh-translate-docs` workflow owned counterpart updates.

That machinery charged every English edit. A one-line correction to a document obligated a counterpart update in the same change, a re-recorded sidecar, and a gate that parsed every pair in the tree to validate one. The translation workflow loaded a guidance corpus (the skill, the pairing contract, the translation rules, a terminology table, style samples, and the prose standard) before touching a two-line diff, and it re-derived the last-confirmed state by hand. Reviewers could not read the Chinese prose, so a counterpart's accuracy rested on hash equality and heading structure rather than on review.

The cost fell on work that had nothing to do with translation, and the return was a second copy that no reviewer could verify.

## Decision

The repository is English-only, and the translation subsystem is removed rather than left dormant.

Every `.zh.md` counterpart and `.i18n.yaml` sidecar is deleted, together with the tooling that produced and checked them: `scripts/translation-*`, `scripts/verify-translation-*`, `scripts/paired-markdown-derivatives.*`, `scripts/gen-translation-brief.ts`, `docs/i18n/`, and the `dsh-translate-docs` skill. [.agents/notes/README.md](../../README.md) no longer describes a triplet, and the format's language-switcher line is gone, so an Agent Note is one file.

`packages/client/locale` ships one dictionary. [en.ts](../../../../packages/client/locale/src/locales/en.ts) is the complete common key set and [index.ts](../../../../packages/client/locale/src/locales/index.ts) re-exports it alone, so `CommonKey` derives from the only shipped language. The website projects a single route tree, and [dsh-doc-site-sync](../../../skills/dsh-doc-site-sync/SKILL.md) rejects locale directories as source layouts.

The Git integration that merged pairs is gone. `lefthook.yml` runs no pairing check, and `scripts/install-lefthook.mjs` configures no merge driver, so the worktree-local hooks carry only the lint, notices, whitespace, and vendor-manifest jobs.

Four Agent Notes whose entire subject was the removed subsystem moved to the frozen archive: [bilingual documentation via paired sibling files](../../archived/process/2026-07-02-bilingual-docs-and-pairing-gate.md), [calibrated translation prompt v4](../../archived/process/2026-07-23-translation-prompt-v4-contract.md), [briefed minimal translation updates](../../archived/process/2026-07-26-briefed-minimal-translation-updates.md), and [lightweight routine documentation translation](../../archived/process/2026-08-08-lightweight-routine-documentation-translation.md). Documentation gates skip archived sources, so their references to deleted tooling remain as historical record instead of forcing edits to frozen files. A fifth note, [documentation structure, tiers, and budgets](2026-07-04-doc-tiers-and-budgets.md), kept its subject and lost only the clause that pointed at the removed contract.

The archive manifest still seals paths for the removed sidecars. `isRemovedSidecar()` treats a `.zh.md` or `.i18n.yaml` manifest entry as satisfied without a file, so prior seals stay valid and the frozen corpus is not rewritten to accommodate the deletion.

## Alternatives considered

**Keep the pairs and drop only the pairing gate.** Rejected because unenforced counterparts drift silently. A stale Chinese page that no gate checks and no reviewer reads is worse than no Chinese page, since it still presents itself as current.

**Delete the `.zh.md` files but keep the tooling dormant.** Rejected because dormant tooling still costs: the scripts stay typechecked and linted, the prompt snapshots stay in the repository, and the workflow remains discoverable to agents that would then find nothing to pair.

**Keep `zh.ts` in the locale package as an unshipped dictionary.** Rejected because an unshipped dictionary is dead weight that the build still typechecks and that still competes to define `CommonKey`. One shipped language means one source for the key union.

**Delete the superseded translation Agent Notes instead of archiving them.** Rejected because the archive exists for exactly this case. It preserves the rationale and the precedent at no maintenance cost, and archived sources are already exempt from the gates, so keeping the history costs nothing.

**Strip the translation rules from the standard but leave the i18n links in place.** Rejected because a rule that links to a deleted contract is not a rule. Every remaining reference resolved or was removed.

## Consequences

English is now the single source for every document, so nothing mechanically checks a second version, because there is no second version. Review burden drops to one language that reviewers actually read.

The documentation gates run without translation exemptions: the link gate checks 1031 files with no counterpart rule, the format gate no longer accepts a `.zh.md` skip, and the archive gate is stricter, rejecting a sidecar file as an error rather than tolerating it. A stray `.zh.md` in the active tree is now a structure failure in `agent-note-tree.ts` rather than a file that quietly passes.

Restoring bilingual support is a single indivisible change rather than a gradual one. It requires the pairing tooling, the sidecar format, the locale dictionary, the website route trees, and a counterpart for every document at once, since a partial restoration has no gate to keep the halves aligned. That cost is the reason this decision is recorded here.

Plugin repositories under `plugins/` keep their own conventions. `plugins/per-model-sampling/HANDOFF.md` still advises writing both languages, which is that repository's rule and not this one's.
