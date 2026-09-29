# Skills review: Dreadnode and Trail of Bits

Reviewed for fit with the DeepSeek Harness (dsh). What I looked at, what's worth
porting, and which MCP servers are worth wiring up to go with them.

Sources, cloned at their latest default-branch state in late August:

| Repo | What it is | License | Size |
|---|---|---|---|
| [dreadnode/capabilities](https://github.com/dreadnode/capabilities) | The skills Dreadnode ships to app.dreadnode.io, bundled into "capabilities" (manifest + agents + tools + skills + MCP servers) | MIT per capability | 27 capabilities, ~142 skill packs |
| [trailofbits/skills](https://github.com/trailofbits/skills) | Trail of Bits' own Claude Code skill marketplace | CC BY-SA 4.0 | 42 plugins, ~80 skills |
| [trailofbits/skills-curated](https://github.com/trailofbits/skills-curated) | ToB-vetted community and OpenAI-converted skills | CC BY-SA 4.0 | 20 plugins, ~31 skills |

All three are compatible with dsh's `<name>/SKILL.md` bundle format. The
frontmatter they use (`name`, `description`, `allowed-tools`) maps onto dsh's
(`name`, `description`, `whenToUse`). `allowed-tools` is Claude-specific and
gets dropped. Resource folders (scripts, references) below a bundle are fine,
dsh supports them.

## Trail of Bits marketplace: the strongest source

This is a security auditor's toolbox, and the narrowness is the point. Most of
the value is prose methodology that ports with minimal edits: vulnerability
checklists, fuzzing playbooks, triage frameworks, review question sets. It needs
almost no plugin machinery to be useful inside dsh.

### My top picks

These are the ones I'd install first. They need only the tools dsh already runs
(`Read`, `Grep`, `Glob`, `Bash`) or a CLI you can install:

| Skill | Why | Extra deps |
|---|---|---|
| `audit-context-building` | Understand a codebase before hunting. Runs before any bug pass. | none |
| `vulnerability-triage-brocards` | 7-rule accept/dismiss framework. Filters findings before human review. | none |
| `differential-review` | Security PR review: blame, blast radius, test-gap checks. | git |
| `sharp-edges` | Footgun/API-misuse review lens (the "pit of success" check). | none |
| `fp-check` | Systematic true/false-positive verification. Directly attacks the worst weakness of LLM bug hunting. | none |
| `variant-analysis` | "Are there others like this?" for an interesting bug. | rg, semgrep, codeql |
| `static-analysis` | Semgrep + CodeQL scans with SARIF parsing. The workhorse. | semgrep, codeql; bundled scripts need rewiring |
| `semgrep-rule-creator` | Turns findings into durable detections, test-first. | semgrep |
| `property-based-testing` | Hypothesis, proptest, Echidna authoring/triage. | none |
| `building-secure-contracts` | 11 skills: vuln checklists for EVM, Solana, Cosmos, Cairo, TON, Algorand, Substrate. | slither (optional) |
| `testing-handbook-skills` | 13 fuzzing skills (AFL++, libFuzzer, cargo-fuzz, Atheris, ASan, Wycheproof). The appsec.guide corpus as skills. | fuzzer CLIs |
| `constant-time-analysis` | Detect timing side channels down to asm/IR. | bundled python |
| `zeroize-audit` | Find missing/compiler-removed secret zeroization in C/C++ and Rust. | serena MCP, clang |

Also solid: `dimensional-analysis`, `entry-point-analyzer`, `modern-cpp`,
`modern-python`, `open-sourcing` (overlaps the existing `trufflehog-pre-push`
skill), `supply-chain-risk-auditor` (its bundled Python collector is portable),
`dwarf-expert`, `yara-authoring`, `mutation-testing`, `github-triage`,
`spec-to-code-compliance`, `second-opinion`.

### Trail of Bits: skills that need real work or a skip

`code-improver`, `git-cleanup`, and `insecure-defaults` are built on Claude
Code's JS workflow/hook machinery rather than a SKILL.md, so they don't port.
That said, `insecure-defaults` ships reference catalogs (default credentials,
fail-open security, weak crypto, fallback secrets) that are worth having. The
catalogs are the prize; they just need a SKILL.md written around them.

`gh-cli` is a Claude-specific hook that intercepts curl and MCP fetch tools and
redirects to `gh`. Skip: the value is the enforcement plumbing, and dsh already
has a GitHub MCP in this session.

`claude-in-chrome-troubleshooting` debugs Claude-specific plumbing. Skip.
`culture-index` is an HR skill. Skip unless you really want it.
`let-fate-decide` is a Tarot-card randomness helper. Fun, zero deps, low value.

`rust-review` and `c-review` hold genuinely good bug-class knowledge but their
orchestration (parser-assigned coverage units, named subagents) is
Claude-specific. The methodology is worth extracting; the machinery is not.

`trailmark` is 14 skills hinging on the `trailmark` Python package. Worth a
look once the package is installed; the `crypto-protocol-diagram` and
`mermaid-to-proverif` sub-skills stand alone.

## Dreadnode capabilities: the web-security playbooks

Dreadnode's skills are written for their own `dn` runtime, which is the main
difference from ToB. The bodies freely reference custom Python tools
(`desync_fingerprint`, `execute_http`, `desync_build_payload`, `credence`,
`granted`) and a wide MCP surface. Porting is not cut-and-paste; it's either
"add the MCP server" or "use the skill as methodology and let the agent
substitute curl/sockets/openssl".

### web-security: the standout

84 attack playbooks. This is the most specific web-application-testing content
I've seen published as skills. Coverage: request smuggling (CL.TE, TE.CL, CL.0,
TE.0, H2C, response queue poisoning), cache poisoning and deception, SSRF in
every mode, SSTI, CSP bypass, parser differentials, OAuth flow hijack, GraphQL
and gRPC-Web, DOM vulnerabilities, AEM/Sling, Next.js, Salesforce Aura, data
exfiltration, race conditions, and more.

Roughly a quarter are curl-centric and port with light edits. The ones I'd
bring over first, because I read them and they stand on their own:

- `403-bypass`, `csp-bypass`, `ssrf-ip-filter-bypass`, `ssrf-redirect-loop`
- `subdomain-takeover-check` (ground-truths against can-i-take-over-xyz)
- `graphql-pentest`, `ssti-error-based-detection`, `timing-attack-recon`
- `oauth-flow-hijack`, `content-type-mime-diff`, `crlf-response-splitting`
- `unicode-normalization-bypass`, `type-confusion-testing`,
  `web-cache-deception-path`, `write-path-to-rce`, `xslt-injection`
- `apache-confusion-attacks`, `nextjs-cache-poisoning`, `blind-ssrf-chains`,
  `sqli-to-rce-escalation`, `http-query-method`
- `vuln-kb` (local CWE reference with per-stack playbooks) and `vuln-critic`
  (adversarial pre-filter for findings), both read as harness-agnostic

The rest assume the full proxy/JX/AST stack. `http-desync-smuggling` is
excellent but its payload builder is a custom tool; keep the prose, drop the
tool calls, or reimplement. Same for `h2-waf-bypass`, `h2c-websocket-smuggling`,
`race-condition-single-packet`, `dom-vulnerability-detection`.

The thing that makes web-security worth taking seriously: Dreadnode ships the
MCP servers alongside these skills, so the pairing is explicit. More on that
below.

### Other Dreadnode capabilities worth a look

- `vuln-assessment-methodology`. Global auditing discipline: source-to-sink
  tracing, disprove-first analysis, threat-model-aware severity. Pure
  methodology, fully portable. High value as a base skill.
- `network-ops`. AD enumeration and attack playbooks (Kerberoasting, AS-REP,
  RBCD, AD CS, DCSync, relay). Mostly methodology over LDAP/tooling. Good if
  you do AD work; the `bloodhound` and `bloodhound-enterprise` skills pair with
  a BloodHound MCP server.
- `secure-software`. Supply-chain triage (Spectra Assure, OSV, Scorecard).
  Useful but leans on the ReversingLabs API.
- `memory-forensics`, `ios-forensics`, `android-apk-research`, `binary-analysis`,
  `dotnet-reversing`. Solid forensic/RE skill packs, but each needs its own
  heavy toolchain (volatility, mvt, jadx/apkid, ghidra). Port only if you
  actually do that work.
- `ai-red-teaming`. The AIRT pack (OWASP LLM Top 10, MITRE ATLAS) is tied to
  Dreadnode's assessment API. Interesting if you want LLM red teaming; expect
  to reimplement the API calls.
- `sliver-c2`, `mythic-c2`, `ghostwriter-readonly`. Tied to the C2/GhostWriter
  MCP servers. Skip unless you operate those.

## skills-curated: small set of keepers

ToB doesn't author most of these; it vets them. The security ones are worth the
look:

- `ffuf-web-fuzzing`. The best ffuf runbook I've seen: directory, subdomain,
  parameter fuzzing, calib, filters. CLI only.
- `ghidra-headless`. Headless decompile/defuse workflows. CLI only.
- `scv-scan`. Solidity audit workflow over 36 vulnerability classes. Useful
  with the smart-contract skills above.
- `wooyun-legacy`. Web testing methodology distilled from 88,636 WooYun cases.
  Good companion to the Dreadnode playbooks.
- `security-awareness`. Hardens the agent itself against phishing and social
  engineering. Pure prompt; I'd add it regardless.
- `planning-with-files`, `skill-extractor`. DSH already has goal/planning
  tooling, but both are portable and cheap.

The rest lean on OpenAI-CLI-converted flows (Cloudflare/Netlify deploys, PDFs,
screenshots) or external APIs (`last30days`, `x-research` need keys). Fine to
skip or cherry-pick `openai-gh-*` and `openai-security-threat-model` if you
want GitHub-CLI-driven workflows.

## MCP servers to consider adding

The skills above motivate a short list. dsh runs stdio and HTTP MCP servers
natively, and Dreadnode publishes MIT-licensed server implementations inside
`dreadnode/capabilities` (mostly `mcp/<name>.py`, runnable via `uv run`), so
several of these are nearly drop-in.

| MCP server | Motivated by | Notes |
|---|---|---|
| Caido | the whole web-security playbook suite (`caido-proxy`, `caido-sdk`, `http-desync-smuggling` replay) | The skill set is written around Caido, not Burp. Two server implementations in-repo: `mcp/caido.py` (lightweight) and `caido-go` (c0tton-fluff/caido-mcp-server, full 60+ tool surface). Pair with a local Caido instance. |
| Burp | `burpsuite-project-parser` (ToB), `burp-suite` (Dreadnode web-security) | Your instinct is right; Dreadnode ships `mcp/burp.py` too. If you already run Burp Pro, this is the clearest addition. The ToB parser skill additionally needs the burpsuite-project-file-parser extension in Burp. |
| Serena | ToB `zeroize-audit` | `uvx` stdio server wrapping clangd. No infra, one config block. |
| JXscout | Dreadnode `jxscout-*` (client-side JS static analysis) | In-repo `mcp/jxscout.py`. High value for DOM-vuln and source-map work. |
| HackerOne | Dreadnode `hackerone-recon`, `report-preflight` | Program scope, prior disclosures, report submission. API-key based; only if you do bug bounty. |
| agent-browser | Dreadnode `agent-browser` and several web playbooks | Headless browser for testing. In-repo `mcp/agent_browser.py`. Playwright MCP is the generic alternative. |
| BloodHound | Dreadnode `bloodhound-*`, `network-ops` AD playbooks | Only if you do AD security assessments. |
| Sliver / Mythic | Dreadnode `sliver-c2`, `mythic-c2` | Red-team C2 only. Optional. |
| Spectra Assure | Dreadnode `secure-software` | ReversingLabs license required. |
| Jira/Confluence, Linear, Azure DevOps, GitLab | Dreadnode connector skills | GitHub MCP is already active in this session; these fill the gaps if you work across trackers. |

Order to start with, given a pentest/audit focus: Caido (or Burp if you're
already a Burp shop), Serena, JXscout, then agent-browser. HackerOne and
BloodHound only if the work warrants them.

## How porting works in practice

For each skill you keep:

1. Copy the pack: any `<name>/SKILL.md` whose content you want, plus its
   `scripts/` and `references/` if they exist. Both orgs keep those next to the
   SKILL.md, which is exactly dsh's layout.
2. Edit frontmatter: keep `name` and `description`, drop `allowed-tools`, add
   `whenToUse` if it's not in the body already. ToB's `name` values are already
   kebab-case; the nested ToB plugins may need a rename to avoid collisions
   with Dreadnode skills (e.g. `insecure-defaults` exists on both sides).
3. Install where dsh's filesystem provider watches: symlink or copy into
   `~/.agents/skills/` or `$DSH_HOME/skills/`, same as the three skills already
   in this repo.
4. For Dreadnode skills that name custom tools (`desync_fingerprint`,
   `execute_http`, `credence`), either add the tool/MCP or strike the tool calls
   and let the model fall back to curl, sockets, and openssl. The prose stays
   intact either way.

## Necessity check: trim before you install

Bulk-installing these would be bloat. A skill catalog is a routing problem, not
a library shelf. The model picks skills by their descriptions, and 84
overlapping attack playbooks make selection worse, not better. SSRF alone spans
eight of them. Dreadnode built that many for an RL-trained agent that memorized
the routing. A general model gets more value from a few canonical playbooks and
its own reasoning. Every third-party skill is also untrusted instructions you
are gifting execution authority; ToB gates third-party skills for that exact
reason, because published skills have shipped backdoors.

So: a small core that applies broadly, a conditional set for work you actually
do, and skip the rest. A reasonable cap for a security catalog is 10-12 skills.

**Necessary.** These apply to any review or audit, regardless of what is on the
calendar. Roughly seven or eight:

- `audit-context-building`, to understand a codebase before looking for bugs
- `fp-check`, to verify findings (the highest-leverage skill in either repo)
- `differential-review`, for PR and diff review
- one static-analysis path (`static-analysis`), because scanning is the one
  thing the model will not reliably do from memory
- `supply-chain-risk-auditor` (or Dreadnode's `secure-software`), which pairs
  with the secrets hygiene you already run in `trufflehog-pre-push`
- `vuln-assessment-methodology`, as the base discipline
- `security-awareness`, to stop the agent itself being phished

**Conditional.** Add these only when the work is actually coming:

- Web pentesting: port 3-5 canonical Dreadnode playbooks (`csp-bypass`,
  `ssrf-ip-filter-bypass`, `graphql-pentest`, `403-bypass`, one smuggling pack).
  Not the whole web-security layer.
- Fuzzing: `testing-handbook-skills`, only if you fuzz.
- Smart contracts: `building-secure-contracts`, only if you audit Solidity.

**Skip.** The RE, forensics, Android and iOS packs, the C2 and BloodHound
skills, the HR and novelty skills, and the OpenAI CLI deploy conversions. They
are good content for the teams that wrote them. They do no work in this harness.

ToB's marketplaces were built for a Claude Code audit team hardening a review
pipeline. Useful as reference, but for a personal harness half a dozen well
chosen skills beat two hundred in the catalog.

## License notes

ToB's marketplaces are CC BY-SA 4.0, so any copied content should carry the
attribution and the same license. Dreadnode capabilities are MIT, simpler.
Both allow this use; just keep the notices when you copy a pack in.
