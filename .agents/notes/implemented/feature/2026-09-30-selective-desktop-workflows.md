# Agent Note: Local previews and optional scheduled work

Status: implemented

## Problem

The desktop host serves a customized Web client with workspace references, shell execution, and remote-instance provisioning. Document previews, task scheduling controls, and a discoverable composer menu must fit those interfaces without replacing the host or enabling additional outbound reporting.

## Decision

The composer uses the existing command registry, image intake, and workspace-reference picker. Its actions preserve the current draft and retain the configured shell providers. The [deliverables plugin](../../../../packages/client/ui-deliverables/README.md) reads produced files through the existing Connection transport and converts documents locally. Preview reads require trusted-host authority, an existing session workspace, containment checks, and configured size limits. Canonical-path checks reject static symlink escapes and recheck the opened file identity; they do not provide a kernel-enforced guarantee against adversarial ancestor-directory swaps. Browser conversion uses Mammoth for DOCX and ExcelJS for XLSX; DOMPurify removes active content before a sandboxed frame renders it under a network-denying Content Security Policy. Previewing does not create a model request.

The [Schedule bundle](../../../../packages/schedule/schedule/README.md) is opt-in. Explicit task records execute saved instructions through ordinary conversation turns and existing permission checks; records without task mode retain reminder semantics. The [sidebar clock button](../../../../packages/client/ui-schedule/README.md) opens a task dialog that prepares editable requests and requires the user to send them. Draft writes verify the selected conversation and its editable state; changing conversations closes the dialog. Schedules remain session-local: the host and owning conversation must be live, and reopening a session can process overdue work. Fixed intervals retain the five-minute minimum and latest-only catch-up. The existing [durability decision](2026-08-05-durable-web-schedule.md), [recurrence decision](../simplification/2026-08-09-bounded-fixed-rate-schedule.md), and [no-receipt decision](../simplification/2026-08-09-conversational-schedule-delivery.md) continue to own those guarantees. The task dialog adds no second dispatch receipt or durable authority. Knip excludes only the two Schedule dependencies mounted from YAML; Cordis configuration validation checks their declarations and resolution. The preview test allowance for `mkfifo` names the system binary used to prove non-regular files cannot block preview reads.

Beta desktop releases use a prerelease version and a matching tag on the `beta` branch. GitHub marks them as prereleases without replacing the latest stable release. Sandbox images publish a separate `beta` channel and version/revision tags; prereleases never publish `latest`. Plugin submodule commits pin the exact beta sources included in the image. Frozen plugin installations supply their production dependencies before image assembly; image layers do not resolve npm packages. Portable plugin dependencies reject native addons and platform-restricted packages; native peers come from each target-specific harness closure.

### Outbound-data review

The comparison reference is upstream `639ed015397290b3745d163aafe02ffee4aa3f84`. Its base composition defaults telemetry to `FEEDBACK_ONLY` and configures `dsh-otel-collector.deepseeksvc.com`. This integration retains the fork's [explicit telemetry opt-in](2026-08-10-telemetry-default-off.md) and imports no telemetry configuration. Configured model requests remain separate from telemetry: sending a draft or executing a scheduled task uses the user's existing model provider and can send that conversation's content to it.

The reviewed direct parser versions are Mammoth 1.13.0 and ExcelJS 4.4.0; DOMPurify 3.4.11 and fflate reuse existing resolved versions. The lockfile adds 73 resolved packages without changing existing package resolutions. Installation uses `--ignore-scripts`. New-package manifests contain no `preinstall`, `install`, or `postinstall` hooks; Mammoth and dingbat-to-unicode declare source-development `prepare` commands. Registry integrity hashes pin downloaded archives. Desktop staging also uses modern frozen-lockfile deployment with lifecycle scripts disabled: legacy deployment can resolve newer cached versions despite an unchanged lockfile. Scoped packages and npm aliases resolve through the installed pnpm store; the staged dependency inventory is checked against the reviewed lockfile before local packaging.

Source inspection covers the parser entry points, browser bundles, external-file handling, and added-package network/telemetry call sites. Mammoth's browser file adapter rejects external reads. ExcelJS parses supplied workbook bytes without evaluating formulas or loading hyperlinks. Unzipper includes optional URL/S3 readers requiring a caller-supplied transport; the preview does not use them. No DeepSeek reporting endpoint or telemetry client was found in these additions. An independent Chromium check observed no requests during sanitization of hostile image, frame, stylesheet, SVG, redirect, and CSS URL inputs. Static inspection is not a proof against every dependency vulnerability; the renderer also removes external document resources and denies frame network access. Native opening remains an explicit action outside the preview's isolation.

## Alternatives considered

**Merge the current upstream application.** Its client, host, and desktop changes span thousands of commits and would replace customized behavior unrelated to these workflows. Adapting the specific interactions keeps the existing deployment and provider selection.

**Use remote Office conversion.** Sending documents to a converter would create an additional data recipient. Local parsing avoids that dependency and its credentials, at the cost of incomplete Office layout fidelity.

**Enable upstream telemetry defaults.** Feedback-triggered upload still changes the fork's consent policy. The disabled default and explicit deployment opt-in remain unchanged.

**Run cold-session tasks through a new global scheduler.** Host discovery, startup recovery, ownership, and shutdown policy require a separate lifecycle design. The existing durable session scheduler supplies explicit task execution while exposing its live-session limitation.

## Consequences

The desktop shell and shell providers remain unchanged by this integration. DOCX previews preserve semantic content rather than exact page layout; XLSX previews display bounded cell data rather than a full spreadsheet editor. Document CSS, scripts, and external resources are removed from previews. Produced-file chips use the preview; prose references retain native opening, and terminal-only outputs remain outside the existing successful-file-mutation tracking. Scheduler output and tool details use the existing conversation transcript. Local parser packages increase the installation and client bundle size, and upgrades require repeating the outbound-data review.
