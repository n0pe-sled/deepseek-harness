# Agent Note: Desktop app self-update

Status: implemented

## Problem

DSH Desktop reaches a user as a `.dmg` that the user copies into `/Applications` by hand, and nothing in the app looked for a newer build of itself. A user learned about a new release only by watching this repository or by being handed a file. The app also carries the harness closure it spawns for a local instance, so an app that never updates keeps running the harness revision it was installed from.

One property of this repository ruled out the standard macOS answer: the published build has no Developer ID signature, so Squirrel.Mac has no identity it will accept for a replacement bundle. Deciding that raised a second question, whether the check needs a credential at all, and the answer came from the repository rather than from the design: it is public, so a release reads with no token and the machine needs none.

## Decision

### Entry points

The app menu carries **Check for Updates…** (⌘U), and one check runs five seconds after launch. The launch check reports nothing while the running version is current, and a check that cannot reach GitHub stays quiet instead of raising a dialog about a network blip. When it finds a newer release it adds an update button to the session bar and nothing else: the check does not open the update window itself, because a window that opened on its own would take the screen away from the session being worked in. `DSH_UPDATE_AUTOSTART=0` turns the launch check off, and an unpackaged development build reports `unsupported` with the reason that it cannot replace itself, rather than offering an install it cannot perform.

### Choosing a release

The running app version is compared against each release tag, parsed as three numeric parts with an optional prerelease. A tag that does not parse is skipped, because ordering an unknown tag as older would hide a real release. A running version ahead of every published release reports up to date. A skipped version is recorded in `skipped-update.json` under the app's `userData` directory, so the choice survives a restart and lifts only when a strictly newer release appears.

The update state and the version comparison live in `apps/desktop/src/shared/update.ts`, which imports no Electron, filesystem, or network module, so the ordering rules are exercised directly.

A check reads the twenty newest releases, keeps the newest one carrying a parsable tag, and selects the `.dmg` asset published for this build's architecture. Requests time out after 15 seconds, because one check runs at launch and must not hold the app there.

### Token

The check reads a token from the machine at check time, from the environment first and then from `gh auth token`, because a token shipped inside the `.dmg` can be read out of the asar. A Finder launch inherits launchd's PATH, which holds none of the package-manager directories, so the `gh` search appends `/opt/homebrew/bin`, `/usr/local/bin`, and `/usr/bin` before concluding that no `gh` is installed. The token is written nowhere, and it reaches no log line and no error message.

### Install

The install target is the `.app` bundle containing the running executable, resolved from the executable path, and the outermost bundle wins so that a helper nested inside the app resolves to the app the user installed. Replacing it needs no admin prompt, because an app its owner dragged into `/Applications` is writable by that user. A development run resolves no bundle and reports `unsupported`. The `.dmg` downloads into the app's `userData` directory, and the app records the image's SHA-256 and whether the release published one to compare it against. The window claims no verification without a published digest.

Starting an install stops the running instances and quits the app. The swap runs in a shell script that the app pipes to `/bin/bash` in a detached process, so the script outlives the app it replaces and no script file is left for a later run to find. The script waits up to 120 seconds for the app to exit, mounts the image, copies the bundle with `ditto --rsrc --extattr` into `<bundle>.dsh-new` beside the installed bundle, strips `com.apple.quarantine` from the copy, checks that the copy holds an executable in `Contents/MacOS`, and swaps the bundles by rename.

### Install contract

Every step before the swap leaves the installed bundle in place. The download, the mount, the copy, the quarantine strip, and the executable check all run while the old version is installed, so a failure in any of them costs a retry and nothing else. The swap is two renames rather than one, so the bundle is briefly absent from `/Applications` between them, and that window is what the backup exists for.

The backup is the installed bundle moved aside in the same directory as `<bundle>.dsh-backup`, so restoring it is a rename that cannot cross a filesystem. The script deletes the backup only after the relaunch, and it leaves the backup in place when the relaunch fails. A failure before the swap leaves the running version installed, a failure during the swap moves the backup back, and an image the installer cannot use is revealed in Finder so the user can install it by hand. Every exiting step records its cause in the log.

### If the app gets a Developer ID signature

Squirrel.Mac would accept a replacement bundle signed by the running app's own identity, so `electron-updater`'s macOS installer would become usable and could replace the script. The feed would not change.

## Alternatives considered

**`electron-updater`.** It lost on the install alone. It applies macOS updates through Squirrel.Mac, which validates the replacement against the running app's signing identity, and this build has no Developer ID signature to validate. Fetching the update would have succeeded and applying it would have been refused. Its GitHub provider also reads the release through `app-update.yml` and a token compiled into the app, which this feed does not need at all.

**An embedded read-only token.** A deploy key or a fine-grained token limited to release reads could have shipped in the bundle, which would have removed the check-time lookup. It lost because the asar is not a secret store. The app ships to users who own their copy, and rotating a leaked token needs a release that the leak already reaches.

**An in-process swap.** The app could mount the image and rename the bundle itself, which would have kept the whole install in TypeScript. It lost because the process performing the swap is the process being replaced, and an app cannot relaunch itself after it exits.

**Installing beside the running bundle.** The app could unpack the new version into `~/Applications` and leave the launched bundle alone. It lost because the install target has to be the bundle the user launched, and a second copy leaves two installs that disagree about which one is current.

**Installing a downloaded image without checking a published digest.** It lost because the window would then present an image as verified when nothing verified it. A release that publishes no digest gets the honest report instead.

## Consequences

A public release feed means an install needs no credential, so a user with no `gh` and no token still updates. A private fork that mirrors this app answers 404 to an anonymous request, and the report names the missing credential rather than reporting a repository that publishes nothing.

The install path uses macOS tooling and replaces the running bundle, so it happens only on a real machine. The release feed, the tag ordering, and the asset selection take an injected fetch and an injected `gh` runner, so tests cover them without a network or a signed-in CLI.

No release is published yet, so the empty-feed report is the path a fresh install exercises. Asset selection reads this build's architecture, so a release has to publish one `.dmg` per architecture for both builds to update.

The [app README](../../../../apps/desktop/README.md#self-update) states what a user sees and what updating requires; this note records why the mechanism is built this way.
