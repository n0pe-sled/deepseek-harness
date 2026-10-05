# Agent Note: this fork carries only the CI workflows it can run

Status: implemented

## Problem

This checkout is a fork of DeepSeek Harness that no longer tracks the original repository, and it kept the original's twenty workflows. Most of them need credentials this fork has never configured: its Actions settings hold no repository variables at all and exactly five secrets, all Apple signing material for the desktop release.

An unreachable workflow is not neutral. `issue-lifecycle.yml` failed on every pull request and every issue event, because `actions/create-github-app-token` requires `vars.DSH_ISSUE_APP_CLIENT_ID` and `secrets.DSH_ISSUE_APP_PRIVATE_KEY`; a red check that can never go green trains a reader to ignore the check panel. The other seven could not fail a pull request because they are manual-dispatch only, so they were invisible cost: a reader has to open each one to learn that it cannot run here.

## Decision

The fork carries the eight workflows it cannot run nowhere: `issue-lifecycle.yml`, `docs-pages.yml`, `release-publish.yml`, `release-vendor-publish.yml`, `landlock-run-release.yml`, `python-release.yml`, `e2b-e2e.yml`, and `pi-ai-provider-e2e.yml`.

What stays is every workflow that produces signal here: the pull-request matrix in `ci.yml`, the master drill in `ci-master.yml`, `expected-filenames.yml`, `issue-policy.yml`, `sandbox.yml`, the real-API `e2e.yml`, `sandbox-release.yml`, the signed desktop release in `release-macos.yml`, and the three credential-free pack workflows (`release.yml`, `release-vendor.yml`, `landlock-run.yml`).

The pack workflows stay deliberately. They hold no credentials, they run on every pull request, and they are what proves the publish set still packs; publication is the half this fork does not perform. `release.yml` and `release-vendor.yml` keep a `workflow_dispatch` so a deployment that configures an npm token can still pack the exact bytes on the runner.

Removing a workflow also removes the guarantee its assertions provided, so `scripts/ci-workflow.spec.ts` loses the five groups that asserted these files and keeps the rest; `scripts/client-build-environment.client.spec.ts` drops the two filenames from its build-environment probe list.

Two consequences are accepted rather than worked around. The documentation site has no deployment path in this fork, so `pnpm run website:build` remains the only check on the site. And nothing here publishes to npm, PyPI, the vendored Cordis packages, or the Landlock launcher; a deployment that wants one of those restores its workflow together with the credential it needs.

## Consequences

A red check on a pull request now means something a reader can act on, and the check panel lists only jobs that can pass. Restoring any removed workflow means restoring its credential first; a workflow added back without one reintroduces a permanently red or permanently silent job.

This partially supersedes the release-sequence half of [the npm release sequences](2026-08-10-npm-release-sequences.md), which remains the owner of the pack/release-shaped partition, and the cache half of [pnpm action setup for symmetric CI caching](2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.md). It fully supersedes [documentation site tag release](../../archived/process/2026-08-21-documentation-site-tag-release.md) and [event-directed PR review status](../../archived/process/2026-08-10-event-directed-pr-review-status.md), both archived with this change.

## Alternatives considered

**Keep every workflow and configure the credentials.** Nine of the eight need an external account this fork does not have: a GitHub App, an npm token, a PyPI trusted publisher, Pages, and three provider keys. Configuring them to keep jobs green would be maintaining an identity the project has no use for.

**Delete the pack workflows with the publish workflows.** They hold no credentials, they run on every pull request, and they are the only check that the whole publish set still packs. Removing them would trade a real signal for tidiness.

**Disable the jobs with `if: false` instead of deleting the files.** A disabled job still appears in the check panel, so a reader still has to open it to learn it cannot run. Deletion is the version of this the panel can state.
