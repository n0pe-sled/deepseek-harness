# plugin-host/ — host an installed third-party agent plugin

A **agent plugin** here is the Claude Code / Codex distribution unit: one directory carrying `skills/`, optional `agents/`, optional `mcp/`, and a `.codex-plugin/plugin.json` (with a `.claude-plugin/plugin.json` for the subset published to that surface). Upstream publishes those bundles with no package manifest at all, so `dsh plugin --profile <name> add <package>` cannot install one — pnpm has nothing to fetch or resolve. `dsh plugin marketplace add` plus `dsh plugin install <plugin>@<marketplace>` fetch the bundle and mount this host over it instead.

The name is deliberate: `plugins/` in this repository holds Cordis plugin submodules, and a dsh **bundle** is an installable profile patch layer. Neither survives contact with an upstream agent-plugin bundle, so the group is named for the role this package plays rather than for the directory upstream happens to ship.

| Package | Role | ctx key |
|---|---|---|
| [`agent-plugin-host/`](agent-plugin-host/README.md) | Reads one installed bundle and contributes its skills, agent definitions, and MCP declarations | provides `ctx.agentPlugins` |

The install surface is the CLI: `dsh plugin marketplace add <path-or-owner/repo>` writes the row this package is mounted by, and `dsh plugin install <plugin>@<marketplace>` mounts it.
