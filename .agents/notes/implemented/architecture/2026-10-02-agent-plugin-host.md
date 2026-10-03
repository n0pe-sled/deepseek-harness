# Agent Note: hosting an installed agent-plugin bundle

Status: implemented

## Problem

Upstream publishes agent plugins in a layout this repository cannot read. A plugin is a directory holding `skills/`, optional `agents/*.toml`, optional `mcp/manifest.json`, and a `.codex-plugin/plugin.json`, and its README installs it with `codex plugin marketplace add <source>` followed by an install from the marketplace. Three things blocked that here.

`dsh-skill-filesystem` reads one level of a skill root, and a plugin's skills sit three levels down at `plugins/<plugin>/skills/<name>/SKILL.md`, so the pinned `skills/specterops-skills` submodule contributed no skills at all: staging discovered fourteen skills and none from SpecterOps. Copying each skill directory up to a watched root, which is what the manual install instructions did, breaks the other half of the layout: those bodies reference `../../references/…`, which resolves against the plugin directory and not against the skill.

`dsh plugin --profile <name> add <package>` is a pnpm forwarder, so it can only install something pnpm can resolve. An agent-plugin bundle ships no package manifest, and the Codex and Claude Code marketplaces are a directory convention rather than a registry, so there was nothing to fetch and nothing to reconcile.

No dsh surface made an upstream agent definition callable. The twenty-one `agents/*.toml` files name a model, a reasoning effort, a sandbox mode, and a `developer_instructions` body that routes work between agents by name, and an installed agent that cannot reach another installed agent is not the thing upstream ships.

## Decision

A new package group, `packages/plugin-host/`, hosts an installed bundle. `dsh-agent-plugin-host` reads one bundle root in place: it contributes the bundle's skills to `ctx.skills`, mounts one model-facing delegation tool per agent definition, and exposes the bundle's MCP declarations on `ctx.agentPlugins` for a consumer that writes MCP client rows.

**Reading in place is what preserves a skill's relative resources.** A skill's resource base is its own directory resolved through `realpath`, never the link or the copy a person installed it through, so `../../references/…` resolves to the installed plugin's own subdirectories. This is also why the provider is separate from `dsh-skill-filesystem` rather than a nesting flag on it: its README documents one-level discovery as deliberate, and its resource base is the root for a flat skill and the bundle directory for a bundle, neither of which is a plugin's own directory.

Upstream keeps its twenty-one shared agent definitions at the bundle root rather than under a plugin, and its own ownership records attribute one of them to as many as eight plugins at once, so a root definition belongs to the bundle: it is discovered once, attributed to the bundle name from the marketplace manifest, and mounted once rather than once per plugin that names it.

**A definition becomes one delegation tool rather than a named subagent provider.** `dsh-configurable-subagents` adds a model-facing `provider` field that selects the child's LLM route, not its `ctx.subagents` backend, so one provider per definition would have left the definitions unreachable. The shipped subagent consumer carries the persona and the tool scope already, so one instance per definition reaches the child with its own `developer_instructions` and its own `toolFilter` and needs no new capability.

**An installed agent can call another installed agent** because the definitions mount under their own tool names, which `dsh-configurable-subagents` does not wrap. It wraps the shipped `subagent` and `subagent_fork` names, so its one-level setting bars those two tools from nesting; the installed agents' own tools are outside that set, and their depth cap is the tool's configured one.

**The install writes three things and records all three.** `dsh plugin marketplace add` resolves a local path where it already lives and clones an `owner/repo` otherwise, and reads the Codex marketplace manifest as the authoritative plugin list: it lists all twenty-five upstream plugins while the Claude Code one lists only the twenty published to that surface. `dsh plugin install <plugin>@<marketplace>` then appends one row to the profile's own `cordis.patch.yml` naming `dsh-agent-plugin-host` with the installed directory, records the install under `$DSH_HOME/agent-plugins.json`, and turns `dsh-configurable-subagents`' `singleLevel` off when the plugin contributes a definition and the key is absent. The profile patch is a layer the CLI already watches, so an install reaches a running session with no restart, and the command claims only the `<plugin>@<marketplace>` form whose marketplace was actually added, so every other argument still reaches pnpm.

The upstream boundary holds: discovery reports and skips a malformed child rather than throwing, so one unusable file cannot hide the rest of an installed bundle; a bundle root that is absent or is not a directory fails loud, because the install writes it and its absence is a fault; and a plugin whose two manifests disagree on a shared identity field is reported, because upstream's own catalog generator enforces that agreement and a disagreement means the tree is not what it claims.

The MCP half stays a declaration. Upstream ships no runner and documents that a person clones each server and supplies its command and secrets, and both of its own declarations still carry a `/path/to/…` placeholder, so a declaration is reported with the credential and configuration names it needs and an `actionable` flag, and no row is written for it.

A plugin-level `agents/<name>.md` is not an agent definition. Upstream's own `go-review` skill states that those filenames are worker protocol prompts and must not be assumed to be callable agent names, so only the TOML location contributes a tool. A definition's `model` and `model_reasoning_effort` are recorded provenance: a route must be registered to be pinned, and no dsh adapter serves the ids upstream names.

## Consequences

The staged closure carries no SpecterOps content. `dsh-base` carries the host package, the two CLI verbs fetch a bundle, and nothing is redistributed, so the Apache-2.0 submodule needs no notice entry and no build carries seventy-five offensive-security skills into every user's catalog. What ships is the capability; what a person installs is the content.

A staged skill ranks below the bundled row, below a person's own user roots, and below their project's, so an installed bundle can never shadow content that was already there. Installing two bundles keeps their provider names apart because the install writes each plugin id as its own provider name.

The new `apps/cli/tests/agent-plugin-host.snapshot.ts` lane pins the whole chain through a real Loader tree: the catalog carries the fixture bundle's model-invocable skill and not the one whose interface metadata forbids it, the loaded body resolves a reference two levels above its own directory, one delegation tool exists per definition with the read-only definition's tool denial, and the bundle's MCP declaration is reported as unactionable rather than written as a row.

## Alternatives considered

**Flatten each skill into a watched skill root.** This is what the manual install instructions did, and it is what breaks `../../references/…`: the body resolves two levels above the skill directory, which is the plugin directory in the installed tree and an unrelated directory under a watched root. It also needs seventy-five copies kept in step with the pinned commit by hand.

**Add a nesting flag to `dsh-skill-filesystem`.** Its one-level rule is deliberate and documented, and its resource base is the root for a flat skill, so nesting inside it would either change what a flat skill's resources resolve against or leave the case it was added for broken. A second provider was already anticipated by its own README.

**One `ctx.subagents` provider per definition.** The model cannot select a backend: the field `dsh-configurable-subagents` adds to the shipped tools selects the child's LLM route. Reaching a definition would then need a new capability and a new way to name one.

**A generated agent preset per definition.** A preset is a human-picked session mode, so an agent inside one could not reach a different preset's agents, and a deployment would carry twenty-one compositions it did not choose.

**Vendor the bundle into the closure.** It would redistribute seventy-five offensive-security skills into every build and need an enablement layer to keep them off, which is more machinery than installing the one plugin a person asked for.

**Turn `singleLevel` off whenever any bundle is installed.** The setting also removes the one-level sentence from the shipped tools' guidance, which is the only thing telling a delegating agent it may nest, so the install writes it only when the plugin contributes a definition and leaves a value the person set to `true` alone.
