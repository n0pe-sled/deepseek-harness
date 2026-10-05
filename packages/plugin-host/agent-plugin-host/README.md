# @deepseek-ai/dsh-agent-plugin-host

Hosts one installed Claude Code / Codex **agent-plugin bundle**: it contributes the bundle's skills to `ctx.skills`, mounts one model-facing delegation tool per `agents/*.toml` definition, and exposes the bundle's `mcp/manifest.json` declarations to consumers that write MCP client rows.

The install writes the row; this package reads it. `dsh plugin marketplace add <path-or-owner/repo>` followed by `dsh plugin install <plugin>@<marketplace>` fetches the bundle and appends one row naming this plugin with the installed directory, so nothing here decides where a bundle lives. Uninstalling removes the row and every directory this package's presets stay clear of.

## Plugin

Requires `ctx.skills` (`inject: ['skills']`).

### Config

| Field | Default | Meaning |
|---|---|---|
| `bundleRoot` | required | Absolute path of the installed bundle root: one plugin directory, or a marketplace directory holding `plugins/`. |
| `providerName` | the first discovered plugin's id | Unique name this bundle registers on `ctx.skills`. The install writes the plugin id, so two installed plugins never collide. |
| `subagentProvider` | `spawn` | `ctx.subagents` provider every definition's delegation tool starts runs on. |
| `backgroundMode` | `continuable` | Whether a delegated child can be followed up and resumed; `continuable` matches the shipped presets and requires a provider with the `prepareContinuable` capability. |

## Contribution

**Skills.** Every `<bundleRoot>/skills/<name>/SKILL.md`, plus every `plugins/<plugin>/skills/<name>/SKILL.md` when the root is a marketplace. `resourceBase` is the skill's own directory resolved to its real path, so a body that references `../../references/…` resolves against the installed plugin and never against the link a person installed it through. Frontmatter `name` and `description` are required and the name must equal its directory, matching the filesystem provider. Upstream's `license` and `metadata` keys pass through as provider metadata.

A skill whose `agents/openai.yaml` sets `policy.allow_implicit_invocation: false` is discovered with `modelInvocable: false`, so only a person's `/`-gesture reaches it. A skill whose interface metadata is unreadable is dropped rather than defaulted, because ignoring unreadable invocation data would expose a skill on a disabled surface.

Skills rank at `AGENT_PLUGIN_SKILL_RANK` (650), above the bundled root (600), so a person's own project, custom, and user roots and the deployment's bundled row all win a duplicate name.

**Agent definitions.** Every `agents/<name>.toml` becomes one model-facing delegation tool named by the definition, carrying its `developer_instructions` as the child's persona and its `description` as the tool's own routing guidance. Upstream keeps its shared definitions at the bundle root as well as under a plugin, so both locations contribute, and a root definition's `pluginId` names the bundle: upstream's own ownership record attributes one shared definition to several plugins at once, which no single plugin id can state. A `read-only` definition denies the child `write` and `edit`. The definition's `model` and `model_reasoning_effort` are recorded provenance, never a pinned route: a route must be registered to be pinned, and no shipped adapter serves the ids upstream names. Delegation depth is the tool's own configured cap, so an installed agent can call another installed agent.

A plugin-level `agents/<name>.md` is not an agent definition. Upstream's own `go-review` skill states that those filenames are worker protocol prompts and must not be assumed to be callable agent names, so they stay prompts.

**MCP declarations.** Every `plugins/<plugin>/mcp/manifest.json`, with the `secrets` and `configuration` names the server requires and an `actionable` flag. Upstream ships declarations only: it documents that a person clones each server and supplies its command and secrets, and both of its own declarations still carry a `/path/to/…` placeholder. This package therefore writes no `mcp-client` row — a declaration becomes a row when `actionable` is true and a consumer completes it.

## Services

| Service | Usage |
|---|---|
| `ctx.skills` | Registers this bundle's skill provider |
| `ctx.subagents` | The delegation tools resolve the configured provider |
| `ctx.tools` | The delegation tools register through the shipped subagent consumer |

### Provided: `agentPlugins`

An `AgentPluginDirectory` exposing the installed bundle to out-of-process consumers — the Web GUI's Skills & MCP settings section — which cannot import Host runtime types. `list()`, `listAgentDefinitions()`, and `listMcpServers()` re-read the tree on every call, so an upgrade or an edit reaches the next read without a restart. An unreadable root is reported and read as empty rather than thrown from, because this face serves a display surface.

## Model Experience

### Delegation tool catalog

#### What the model sees

One delegation tool per agent definition, under this instance's configured name for each. The tool's description carries the upstream definition's own `Use for …` routing guidance, and its schema is the shipped subagent consumer's: `description`, `prompt`, `run_in_background` (continuable mode makes background the default), and the opt-in `provider`/`model`/`reasoning_effort` fields when `dsh-configurable-subagents` is composed. Installing a bundle adds its definitions to every session's catalog, including sessions on a preset mounted before the install.

#### Token effect

Fixed schema cost per definition tool on every request where it is visible; a bundle whose definitions are many adds that many schemas.

#### KV Cache effect

Prefix-stable while the installed set is unchanged. An install or uninstall changes the tool catalog, so parent reuse is invalidated from the first changed definition.

### Skill catalog

#### What the model sees

The session catalog carries this provider's invocable names and capped descriptions, rendered by `dsh-tool-skill`, and a selected body plus resource-base guidance enters retained tool history when the model loads one.

#### Token effect

The catalog grows by one entry per discovered skill; a loaded body is retained tool history.

#### KV Cache effect

A body-only edit leaves the catalog digest unchanged and adds nothing; adding or removing a skill appends a replacement catalog through the consumer.

## Known Limitations and Deferred Work

- **A definition's model choice is provenance only** — dsh's model route is a host-plane session fact pinned at creation, and no preset or bundle row can express a per-agent route. An upstream definition naming a model with no registered adapter leaves the child on its delegating agent's route.
- **`sandbox_mode` maps to a tool denial, not to `sandbox/mode`** — a `read-only` definition denies `write` and `edit`, so it can still be asked to write through a tool this bundle does not know about. The session's own permission preset remains the enforcement the person controls.
- **Discovery re-reads the whole bundle on every catalog read** — there is no watcher, so an unreadable mirror costs one full walk per observation; the catalog is cached by the skill registry between revisions.
- **An MCP declaration is never activated automatically** — upstream ships no runner and leaves each server's checkout, command, and secrets to the person, so an unactionable declaration is reported and left to a consumer's add flow.
- **Upstream's two marketplace manifests disagree** — the Codex one lists every plugin and the Claude Code one lists only those published to that surface, so the Codex manifest is authoritative and the Claude Code one is a cross-check.
