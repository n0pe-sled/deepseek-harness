# deepseek-harness-skills

A personal collection of 14 reusable **skills** for the
[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness), plus a
git submodule that brings in 75 more from
[SpecterOps/skills](https://github.com/SpecterOps/skills). Each skill is a
standard skill bundle (`<name>/SKILL.md` with YAML frontmatter) that any dsh
filesystem provider discovers and any agent can load.

## Layout

Skills live in four category folders. The folders are source organization only.
dsh discovers skills flat, one level deep per root, so installation flattens
every bundle into the watched root by its name.

| Folder | Contents |
|---|---|
| `security-review-skills/` | The security research campaign skills: scope, orchestration, discovery, simulation, validation, findings, delta hunts, infrastructure, Ludus, and session export. |
| `generic-skills/` | Self-authored skills that apply to any development flow: dsh plugin authoring and pre-push secret scanning. |
| `specterops-skills/` | A git submodule pinned to [SpecterOps/skills](https://github.com/SpecterOps/skills). 75 offensive-security and engineering skills across 25 upstream plugin bundles. Apache-2.0. |
| `third-party-skills/` | The vendored `unslop` writing skill, kept with its source attribution. |

## Generic skills

| Skill | What it does |
|---|---|
| [`dsh-plugin-authoring`](generic-skills/dsh-plugin-authoring/SKILL.md) | Guidance distilled from a working session on **authoring a third-party dsh plugin** (node half, browser client half, or both): the bundle/profile installation model, the real client-bundle contract, and the deltas between the published plugin docs' sample code and the shipped harness. Plus package layout, node/browser half rules, verification, and current version facts. |
| [`trufflehog-pre-push`](generic-skills/trufflehog-pre-push/SKILL.md) | **Scan a git project for secrets with TruffleHog in Docker before pushing** and gate on zero results. Filesystem/history scan commands, `--fail` (exit 183) semantics, path exclusions, how to read verified vs unverified hits, the pushed-secrets-stay-in-history caveat, and a supplementary host-info sweep. |

## Security research skills

These run one campaign in the two-agent security-research preset: a root
orchestrator and one foreground worker at a time. They are general, not tied to
any one target.

| Skill | What it does |
|---|---|
| [`security-scope-interview`](security-review-skills/security-scope-interview/SKILL.md) | Run a targeted scope conversation to produce a concrete `SCOPE.md`: authorization, attacker access, allowed and forbidden actions, baseline collection, a repeatable success proof, and resource bounds. |
| [`security-campaign-orchestration`](security-review-skills/security-campaign-orchestration/SKILL.md) | Root-session routing: one causal gate per task packet, foreground-only delegation, reopen conditions on every closed family, mid-campaign scope amendments, restart handling, and closeout. |
| [`security-vulnerability-discovery`](security-review-skills/security-vulnerability-discovery/SKILL.md) | Read-only discovery worker: map attacker-controlled paths to effects, cover the web front end and anonymous surface, and stop at the first unsupported edge. |
| [`security-anonymous-oracle-audit`](security-review-skills/security-anonymous-oracle-audit/SKILL.md) | Enumerate and differential-test anonymous web routes (meta, slug, ID lookups) with the known-vs-unknown check before any read surface is certified clean. |
| [`security-attack-simulation`](security-review-skills/security-attack-simulation/SKILL.md) | Simulation worker: build a bounded experiment with one semantic mutation, positive and negative controls, and before/after observations on the exact target epoch. |
| [`security-adversarial-validation`](security-review-skills/security-adversarial-validation/SKILL.md) | Independent validation worker: falsify or reproduce a promoted candidate from frozen inputs on a clean target, returning supported, refuted, or inconclusive. |
| [`security-findings-triage`](security-review-skills/security-findings-triage/SKILL.md) | Classify off-objective findings, decide compose vs park, and keep a parked finding's unpark condition attached so it is not lost. |
| [`security-release-delta-hunt`](security-review-skills/security-release-delta-hunt/SKILL.md) | Diff the pinned epoch against prior releases (patch and feature windows) and decide whether new code carries a reachable primitive before live work. |
| [`security-infrastructure-operator`](security-review-skills/security-infrastructure-operator/SKILL.md) | Generic infrastructure worker for AWS, Ludus, Docker, and local labs: baseline, readiness, cleanup, and the live-equals-committed-equals-frozen invariant. |
| [`security-ludus-range-operator`](security-review-skills/security-ludus-range-operator/SKILL.md) | Ludus-specific guide: range lifecycle, role deploys, testing state as the clean-reset mechanism, snapshots, VM access, and re-freezing after changes. |
| [`security-session-log-export`](security-review-skills/security-session-log-export/SKILL.md) | Freeze a campaign's session record into auditable transcripts and metadata at closeout, with the secrets policy stated up front. |

## SpecterOps skills

A git submodule pinned to one upstream commit, not a copy of the tree. Apache-2.0.
We do not edit these in place.

| Bundle | What it does |
|---|---|
| [`specterops-skills`](specterops-skills/) | **75 offensive-security and engineering skills** from [SpecterOps](https://github.com/SpecterOps/skills). BloodHound attack paths, Cobalt Strike / Mythic / Outflank C2 development, BOF authoring, SCCM takeover validation, recon and OSINT, appsec review, payloads and platform tradecraft, report drafting, reverse engineering, social engineering, and a Ludus range skill. Grouped below. |

| Group | Bundles |
|---|---|
| Attack paths | `bloodhound` (BloodHound, AzureHound, GitHound/JamfHound/OktaHound) |
| C2 | `c2-cobaltstrike`, `c2-mythic`, `c2-outflankc2`, `c2-extensions` |
| Internal ops | `ops-sccm`, `ops-reconnaissance`, `ops-appsec`, `ops-infrastructure`, `ops-adcs` and `ops-mssql` (placeholders, no skills yet) |
| Payloads and tradecraft | `payloads`, `tradecraft-windows`, `tradecraft-mac`, `tradecraft-linux` |
| Deliverables | `report-drafting`, `report-timeline` |
| Code review | `go-review`, `code-review-and-qa`, plus `cwe-code-review`, `owasp-security-code-review`, `openssf-python-review` at the upstream `skills/` dir |
| Other | `reverse-engineering`, `social-engineering`, `ludus`, `codex-observability`, `workflows-research`, `workflows-development` |

Upstream also ships 21 agent definitions in `agents/*.toml` and Codex/Claude plugin
manifests. dsh reads neither. No skill name collides with a skill we own.

### Bumping the pin

`git pull` in this repo does not move the submodule. It stays at the pinned commit
until you advance it and commit the new pointer:

```bash
git submodule update --remote specterops-skills
git add specterops-skills
git commit -m "Bump SpecterOps skills submodule"
```

Pin a specific commit instead of tracking `main` if you want the move to be
deliberate:

```bash
git -C specterops-skills checkout <sha>
git add specterops-skills && git commit -m "Pin SpecterOps skills at <sha>"
```

## Third-party skills

| Skill | What it does |
|---|---|
| [`unslop`](third-party-skills/unslop/SKILL.md) | **Cut AI tells from any writing** and add human voice. Scans for 31 patterns (puffery, AI vocabulary, overused em dashes and colons, chatbot phrases, filler, jargon), then guides a rewrite that keeps meaning and the intended tone. Must always apply when writing. Original source: [cursor/plugins: pstack/skills/unslop](https://github.com/cursor/plugins/tree/main/pstack/skills/unslop). |

## Skill format

Skills follow `@deepseek-ai/dsh-skill-filesystem` conventions:

- **Bundle form**: `<name>/SKILL.md` with `---` frontmatter carrying `name`
  (kebab-case) and `description`, plus optional `whenToUse`,
  `disable-model-invocation`, and `user-invocable`.
- **Flat form**: `<name>.md` at a root's top level (same frontmatter).

Discovery is one level deep per root, and the standard roots are:

| Root | Location |
|---|---|
| project | `<project>/.dsh/skills`, `<project>/.agents/skills` |
| user (dsh) | `$DSH_HOME/skills` |
| user (agents) | `$DSH_AGENTS_HOME/skills` (default `~/.agents/skills`) |

## Install

Clone the repo somewhere stable, then copy (or symlink) each skill bundle into
a user root the filesystem provider watches. The install scripts below walk the
category folders and emit each bundle flat by its name.

Clone with the submodule, or the SpecterOps folder arrives empty:

```bash
git clone --recurse-submodules \
  https://github.com/n0pe-sled/deepseek-harness-skills.git ~/dsh-skills
# already cloned? fill it in:
git -C ~/dsh-skills submodule update --init --recursive
```

Our own 14 bundles sit one level under a category folder:

```bash
# into the shared agent user root (~/.agents/skills also hosts installed skills)
mkdir -p ~/.agents/skills
for d in generic-skills security-review-skills third-party-skills; do
  find ~/dsh-skills/$d -mindepth 2 -maxdepth 2 -name SKILL.md \
    -exec sh -c 'cp -R "$(dirname "$1")" ~/.agents/skills/' _ {} \;
done

# or symlink each bundle instead, so `git pull` updates them in place:
for d in generic-skills security-review-skills third-party-skills; do
  find ~/dsh-skills/$d -mindepth 2 -maxdepth 2 -name SKILL.md \
    -exec sh -c 'ln -s "$(dirname "$1")" ~/.agents/skills/' _ {} \;
done
```

The SpecterOps bundles sit deeper, at `plugins/<plugin>/skills/<name>/SKILL.md`,
with three more at the upstream `skills/` dir:

```bash
find ~/dsh-skills/specterops-skills -mindepth 3 -maxdepth 5 -name SKILL.md \
  -exec sh -c 'cp -R "$(dirname "$1")" ~/.agents/skills/' _ {} \;
```

That drops all 75 into the same root. The catalog gets long, and most of it is
irrelevant to a given engagement. To install selectively, narrow the walk to the
bundles you want:

```bash
for p in bloodhound ops-reconnaissance ludus; do
  find ~/dsh-skills/specterops-skills/plugins/$p -name SKILL.md \
    -exec sh -c 'cp -R "$(dirname "$1")" ~/.agents/skills/' _ {} \;
done
```

The provider watches these roots, so a skill appears in the next catalog
observation. Newly added skills show up on a running session's next load
without a restart.

### Using `$DSH_HOME/skills` instead

If you would rather keep dsh skills separate from `~/.agents` (which a
third-party GitHub-skill installer also manages via `~/.agents/.skill-lock.json`):

```bash
mkdir -p "$DSH_HOME/skills"     # or "$HOME/.dsh/skills"
# same walks as above, destination swapped:
for d in generic-skills security-review-skills third-party-skills; do
  find ~/dsh-skills/$d -mindepth 2 -maxdepth 2 -name SKILL.md \
    -exec sh -c 'cp -R "$(dirname "$1")" "$DSH_HOME/skills/"' _ {} \;
done
find ~/dsh-skills/specterops-skills -mindepth 3 -maxdepth 5 -name SKILL.md \
  -exec sh -c 'cp -R "$(dirname "$1")" "$DSH_HOME/skills/"' _ {} \;
```

## Verify

```bash
# the skill is discoverable when it appears in the catalog; for the web GUI,
# start a session and reference the skill by name, or list it via:
ls ~/.agents/skills/dsh-plugin-authoring/SKILL.md
ls ~/.agents/skills/trufflehog-pre-push/SKILL.md
ls ~/.agents/skills/unslop/SKILL.md
ls ~/.agents/skills/security-*/SKILL.md  # all security research skills
ls ~/.agents/skills/bloodhound-query/SKILL.md ~/.agents/skills/ludus-development/SKILL.md
ls ~/.agents/skills/*/SKILL.md | wc -l   # 89 if you installed everything
```

## Updating

```bash
git -C ~/dsh-skills pull
```

`git pull` does not move the submodule. It stays at the pinned commit until you
advance it. See [Bumping the pin](#bumping-the-pin).

Copy-installed skills need the copy refreshed (re-`cp`); symlinked skills pick
up the new content automatically.
