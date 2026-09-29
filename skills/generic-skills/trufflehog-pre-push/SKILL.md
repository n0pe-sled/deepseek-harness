---
name: trufflehog-pre-push
description: Scan a local git project for secrets with TruffleHog running in Docker before pushing to a remote — the filesystem and history scan commands, exit-code gating, path exclusions, how to read verified vs unverified results, and the caveat that pushed secrets stay in history
---

# Scan a git project for secrets with TruffleHog (Docker) before pushing

TruffleHog detects credentials (API keys, tokens, passwords, private keys,
database URIs, …) with hundreds of detectors + high-entropy heuristics. Running
it **in Docker** keeps the tool out of your PATH/toolchain and reproducible.
Use this before every push so a secret never reaches a remote in the first
place.

## Prerequisites

- Docker (Desktop is fine; share a path under the home dir — on macOS `$HOME`
  is shared by default, while `/tmp` may not be).
- The project on disk (uncommitted or committed — both scan fine).
- Network to pull `trufflesecurity/trufflehog:latest` on first run (or pin a
  tag for reproducibility).

## The filesystem gate (run before every push)

1. Keep an exclude file (regex per line) in the repo, gitignored — e.g.
   `.trufflehog-exclude`:

   ```text
   .git/
   node_modules/
   .pnpm-store/
   .trufflehog-exclude
   ```

2. Scan the working tree read-only, failing on any result:

   ```bash
   docker run --rm -v "$PWD:/scan:ro" trufflesecurity/trufflehog:latest \
     filesystem --fail --directory=/scan \
     --exclude-paths=/scan/.trufflehog-exclude --no-color
   echo $?   # 0 = clean; 183 = results found
   ```

3. Read the summary line on stderr:

   ```text
   chunks: N  bytes: N  verified_secrets: 0  unverified_secrets: 0
   ```

   - **verified** = TruffleHog confirmed the credential live against the
     service API → treat as a real, active compromise. Stop and rotate.
   - **unverified** = detected but not confirmed → triage each hit; many are
     placeholders or example values (`ghp_…`, `Bearer …`, `sk-…`).
   - `--fail` exits **183** when ANY result is emitted (default result set is
     `verified,unverified,unknown`), so it works as a hard gate in scripts and
     CI.

## Scan exactly what will be pushed

The push payload is the **tracked set**, not the whole working tree:

```bash
git ls-files -z | xargs -0 grep -IinE "PATTERN"        # inspect the tracked set
# or stage the tracked files into a temp dir and scan just those
```

Scanning the whole worktree (with vendor dirs excluded) is an acceptable
superset; excluding `node_modules/`, `.pnpm-store/`, `vendor/`, `.venv/` etc.
cuts noise and runtime. But do scan lockfiles — they can embed registry auth.

## Scanning git history (already-pushed secrets)

Removing a secret from the working tree does **not** remove it from history —
clone or point at the local repo and scan commits:

```bash
docker run --rm -v "$PWD:/scan:ro" trufflesecurity/trufflehog:latest \
  git file:///scan --fail --no-color --results=verified
# or a remote:  trufflehog git https://github.com/you/repo.git
```

If history is already tainted:

1. **Rotate/revoke the credential first** — assume it is compromised.
2. Purge history (`git filter-repo`) and coordinate a force-push rewrite.

Never rely on "delete the file and force-push" alone — unless the token was
rotated, it is still live.

## Key flags

| Flag | Effect |
|---|---|
| `--fail` | Exit 183 if results are found (gate for scripts/CI). |
| `--results=verified,unverified,unknown` | Which results to emit (default all). |
| `--no-verification` | Skip live API checks; everything is reported unverified (use in air-gapped/CI-without-egress). |
| `-x/--exclude-paths=FILE` | File of newline-separated **regexes** of paths to skip. |
| `--directory=DIR` / positional path | What to scan (filesystem source). |
| `--no-color` | Plain output for logs. |
| `--filter-unverified` / `--filter-entropy=3.0` | Reduce unverified noise. |
| `--json` / `--sarif` | Structured output for tooling/CI ingestion. |
| `--concurrency=N` / `--max-decode-depth` | Speed / decode depth (base64, archives). |

Verification contacts third-party APIs when a candidate targets a live service;
that is by design. In an environment with no egress, pass `--no-verification`
and treat every hit as unverified.

## Supplementary host-info check (not just secrets)

Secrets are not the only leak a public repo should avoid. Before pushing, also
sweep the tracked set for host-identifying artifacts:

```bash
git ls-files -z | xargs -0 grep -IinE "(${HOME##*/}|/Users/|/home/|([0-9]{1,3}\.){3}[0-9]{1,3})"
```

- **Absent** absolute local home paths (`/Users/<name>/…`, `/home/<name>/…`)
  and private/LAN IPs.
- A public repo URL or the owner's public handle is fine; a literal machine
  path is not.

## Pitfalls

- **Placeholders look like tokens** — verify the context before acting on an
  unverified hit; don't rubber-stamp either direction.
- **Exclude vendored dirs** to avoid thousands of third-party files in results,
  but keep lockfiles in scope.
- **macOS mounts**: volumes must be under a Docker-Desktop-shared path; prefer
  `$PWD` inside `$HOME`.
- **Exit codes**: remember `--fail` → 183 on findings; trufflehog otherwise
  exits 0 even when it printed results.
- **No PEM-key markers by hand**: never paste a real private key (or a
  full-looking one) even in docs/tests — it will trip detectors and can be
  mistaken for the real thing.

## Worked example (whole flow)

```bash
cd ~/projects/myapp
# 1. exclude helper (already gitignored)
printf '.git/\nnode_modules/\n' > .trufflehog-exclude
# 2. scan working tree; gate on the exit code
docker run --rm -v "$PWD:/scan:ro" trufflesecurity/trufflehog:latest \
  filesystem --fail --directory=/scan \
  --exclude-paths=/scan/.trufflehog-exclude --no-color
# 3. only when exit==0:
git add -A && git commit -m "..." && git push
```
