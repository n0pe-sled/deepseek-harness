---
name: security-ludus-range-operator
description: Use as the sole foreground worker when the campaign target is a Ludus-hosted lab range, covering range lifecycle, role deploys, testing state, snapshots, VM access, and the clean-reset path
disable-model-invocation: true
user-invocable: false
---

# Security Ludus Range Operator

Companion to `security-infrastructure-operator` for when the target is a Ludus
hosted lab range. Work hands-free per the operator decision: never pause for
confirmation on in-scope deployments, snapshots, reverts, or teardown. Monitor
deploy logs instead of blocking.

## Orient before you mutate

Start read-only. `whoami`, `listUserAccessibleRanges`, `listRange` with the
rangeID, `getRolesAndCollections`, `getTemplates`. Always pass the rangeID
explicitly in every call. If a rangeID is omitted and no default range is set,
Ludus returns 404 "Range not found for user"; fix it with
`ludus range default set <rangeID>` or by naming the rangeID in the request.

## Range lifecycle

- `createRange` takes a name, rangeID, and description. The rangeID is the
  identifier you use everywhere after.
- `InstallRoleTar` uploads a role tarball. The installed role name comes from
  the upload filename stem, so keep the filename stable and upload with
  `force: true` to replace a role. Renaming the tar mounts the old role and
  your new code never runs.
- `putConfig` uploads `range-config.yml` with `force: true`; confirm with
  `getConfig` that the live config is byte-identical to the committed copy.
- `deployRange` is async. It returns "Range deploy started" and you poll
  `getLogs` with the returned cursor, or `getRangeLogHistoryByID` for one
  deploy, until the Ansible play ends. Deploys run minutes: router first, VM
  clones, IP acquisition (repeated "FAILED - RETRYING ... acquire an IP" is
  normal), then per-VM roles. Sleep generously between polls.
- `abortRange` stops the current operation. It can leave partial state, so
  re-deploy or revert after an abort.

## Testing state and clean reset

The reset mechanism is testing state.

- `startTesting` snapshots every snapshot-enabled VM and enters testing state.
  That automatic snapshot is the frozen epoch for live work.
- `stopTesting` reverts each VM to that snapshot. This is the clean reset:
  one call restores the exact epoch for reproduction.
- Name manual snapshots after the task and UTC, for example
  `INFRA-002-egress-allowed @ 04:26Z`. `getSnapshots` shows the chain and
  snaptime; use it to confirm the parent is the epoch you expect.
- After a revert, VMs keep stale clocks. The role's clock-sync task only runs
  on deploy, not on revert. Document the skew instead of trying to fix it.

## VM access

- `getAnsibleInventory` returns each VM's IP and SSH identity, for example
  gitlab `debian@10.1.10.11`, attacker `kali@10.1.99.1`, router `debian`.
  Read it fresh each campaign; do not copy IDs from old notes.
- `ludus-ssh` tries the configured identity, then the kali template. When it
  reports "no configured Linux identity authenticated", that usually means SSH
  was not reachable, often because the VM is still booting after a revert, or
  the VM uses a non-template user. Verify the port is open and use the
  inventory identity. The robust pattern is to hop the attacker VM and then
  `sshpass -p <password> ssh <user>@<target>`.

## Modify, redeploy, re-freeze in one task

Any live-state change follows the same cycle, started from a clean revert.

1. Back up the pre-change role and config under `baseline/logs/` and record
   their hashes, so the change is reversible.
2. Edit the role and `range-config.yml`. Keep them idempotent and pinned to
   the exact target version; never change the target version mid-campaign.
3. Re-upload the role tar with the same filename and `force: true`, putConfig,
   deployRange, and poll logs to completion.
4. Prove idempotency: deploy twice. Both runs must finish with `failed=0` and
   the second run must change close to nothing.
5. Verify the epoch facts before and after, from the container and from the
   attacker origin: sign-in page code, the version endpoint with a test
   credential, a bogus credential returns 401, the live config equals the
   committed config, and any marker path is absent.
6. Re-freeze with `snapshotsTake` and `startTesting`. Record the new snapshot
   id and service epoch in the manifest and a log.

## Field gotchas

- The role name comes from the upload filename, so never rename the tar.
- Ansible `lineinfile` uses Python regex; POSIX classes like `[[:space:]]` do
  not expand. Use `\s`.
- Egress control is two layers: in-VM null-routes and Ludus
  `testing.block_internet`. When the egress posture matters, check both.
- To change what the frozen epoch contains, take a fresh testing snapshot
  after the change. `stopTesting` only returns to the last testing snapshot.

## Handoff

Return the exact range and VM identifiers, target version and OS, the snapshot
id and service epoch, artifact paths and hashes, the credential reference
without the value, the reset path (the testing snapshot id), and one next
discriminating test. Report supported or blocked with the precise blocker.
