import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
const binScript = fileURLToPath(new URL('./fixtures/agent-plugin-host/snapshot.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/agent-plugin-host/cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const fixtureRoot = fileURLToPath(new URL('./fixtures/agent-plugin-host/bundle/', import.meta.url))
const fixtureMarker = fileURLToPath(new URL('./fixtures/agent-plugin-host/bundle/plugins/demo/', import.meta.url))

describe('agent plugin host assembled snapshot', () => {
  it('contributes an installed bundle through the shipped app', async () => {
    const run = await runLoaderSmoke({
      label: 'agent plugin host snapshot',
      tempDirPrefix: 'headless-snapshot-agent-plugin-host-',
      binScript,
      libBinScript: binScript,
      configPath,
      tsconfigPath,
      env: { DSH_AGENT_PLUGIN_FIXTURE: fixtureRoot },
    })

    expect(run.stderr).toBe('')
    const snapshot = JSON.parse(run.stdout.replaceAll(fixtureMarker, '{{fixtureMarker}}')) as unknown
    expect(snapshot).toMatchInlineSnapshot(`
      {
        "catalog": [
          {
            "text": "<system-reminder>
      A skill is a reusable set of task-specific instructions. The following skills are available in this session:

      <available_skills>
      - \`alpha\`: Fixture skill that resolves a reference two levels above its own directory.
      </available_skills>

      If the user names a skill, or the task clearly matches a skill's description, call the \`skill\` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
      A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the \`skill\` tool again for that skill.
      </system-reminder>",
            "type": "text",
          },
        ],
        "definitions": [
          {
            "deniedTools": [
              "write",
              "edit",
            ],
            "description": "Fixture agent definition. Use for reviewing a fixture, and route exploits to the exploit agent.",
            "instructions": "You are the \`reviewer\` fixture agent.

      Mission:
      - Review the fixture and report what it does.

      Workflow:
      1. Read the fixture.
      2. Report one finding.
      ",
            "model": "fixture-model",
            "name": "reviewer",
            "pluginId": "demo",
            "reasoningEffort": "high",
            "sandboxMode": "read-only",
            "skillReferences": [],
            "toolName": "reviewer",
          },
        ],
        "mcp": [
          {
            "actionable": false,
            "args": [
              "--directory",
              "/path/to/fixture",
              "run",
              "main.py",
            ],
            "command": "uv",
            "configuration": [
              "FIXTURE_URL",
            ],
            "entrypoint": "main.py",
            "name": "fixture_mcp",
            "pluginId": "demo",
            "secrets": [
              "FIXTURE_TOKEN",
            ],
            "type": "stdio",
          },
        ],
        "nodes": [
          "reviewer",
        ],
        "plugins": [
          {
            "agents": [
              "reviewer",
            ],
            "displayName": "Demo",
            "id": "demo",
            "mcpServers": [
              "fixture_mcp",
            ],
            "skills": [
              "alpha",
              "beta",
            ],
            "version": "1.0.0",
          },
        ],
        "reference": "Fixture reference reached only by resolving a relative path against the skill's
      resource base, two levels above the skill's own directory.
      ",
        "resourceBaseAbsolute": true,
        "result": {
          "content": [
            {
              "text": "<skill_content name="alpha">
      <skill_resources>
      Base directory for this skill: {{fixtureMarker}}skills/alpha
      Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
      </skill_resources>

      <skill_instructions>
      # Alpha

      - Read \`../../references/note.md\` before acting.
      </skill_instructions>
      </skill_content>",
              "type": "text",
            },
          ],
          "isError": false,
          "value": {
            "content": "# Alpha

      - Read \`../../references/note.md\` before acting.",
            "name": "alpha",
            "provider": "demo",
            "resourceBase": {
              "kind": "directory",
              "path": "{{fixtureMarker}}skills/alpha",
            },
          },
        },
        "worker": [],
      }
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
