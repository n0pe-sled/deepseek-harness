/**
 * Installing a downloaded disk image over the running app bundle.
 *
 * The app cannot replace its own bundle while it runs, so it hands the swap to a
 * detached bash script that waits for this process to exit. The script stages a
 * copy of the image's app beside the installed bundle and moves it into place
 * only once that copy is complete, so a failure at any earlier step leaves the
 * installed app untouched. Past that point the previous bundle is kept at
 * `<app>.dsh-backup` rather than deleted, and a failed relaunch leaves that
 * backup in place for a manual recovery. The script records every step in the log
 * file the plan names, because the app is quitting and nothing is left reading
 * the script's own output.
 *
 * Nothing here imports Electron, so the module loads under plain Node in tests.
 */
import { spawn } from 'node:child_process'

/** One install of a downloaded disk image over the running app bundle. */
export interface InstallerPlan {
  /** Directory of the `.app` this install replaces. */
  appBundle: string
  /** The verified `.dmg` to install from. */
  dmgPath: string
  /** File the installer script appends its progress to. */
  logPath: string
  /** PID of the running app, whose exit the installer waits for. */
  pid: number
}

/** Suffix that makes a path segment an application bundle. */
const BUNDLE_SUFFIX = '.app'

/** Seconds the app gets to exit before the installer gives up on the install. */
const EXIT_WAIT_SECONDS = 120

/** Seconds between polls of the app's PID. */
const EXIT_POLL_SECONDS = 0.5

/** Polls in the wait, so the 120 second bound survives a change to either value. */
const EXIT_WAIT_POLLS = EXIT_WAIT_SECONDS / EXIT_POLL_SECONDS

/**
 * The `.app` directory containing an executable, or undefined when the path is
 * not inside one.
 *
 * The outermost bundle wins: a helper or framework nested inside the running
 * app's bundle belongs to the app the user installed, which is the one an install
 * has to replace.
 *
 * @param execPath - path of an executable, normally `process.execPath`.
 * @returns the bundle directory, or undefined when no path segment ends in `.app`.
 */
export function enclosingBundle(execPath: string): string | undefined {
  const segments = execPath.split('/')
  const end = segments.findIndex((segment) => segment.endsWith(BUNDLE_SUFFIX))
  if (end === -1) return undefined
  return segments.slice(0, end + 1).join('/')
}

/**
 * Build the plan for installing `dmgPath` over the app running at `execPath`.
 *
 * @param execPath - path of the running executable, normally `process.execPath`.
 * @param dmgPath - the verified image to install.
 * @param logPath - file the installer appends its progress to.
 * @param pid - the process the installer waits for, defaulting to this one.
 * @returns the plan the installer script is built from.
 * @throws when `execPath` is not inside a `.app` bundle, which is the case for a
 *   development run: there is no bundle to replace, and an install that guessed
 *   one would write over an unrelated directory.
 */
export function installPlan(
  execPath: string,
  dmgPath: string,
  logPath: string,
  pid: number = process.pid,
): InstallerPlan {
  const appBundle = enclosingBundle(execPath)
  if (appBundle === undefined) {
    throw new Error(`cannot update: ${execPath} is not inside a .app bundle`)
  }
  return { appBundle, dmgPath, logPath, pid }
}

/**
 * Quote a value for one of the generated script's double-quoted assignments.
 *
 * A path is not under this module's control, so the four characters bash still
 * expands inside double quotes are escaped. Without that, a bundle or image under a
 * directory whose name holds a quote or a dollar sign would produce a script that
 * assigns the wrong path or fails to parse at all.
 *
 * @param value - the path to embed.
 * @returns the value wrapped in double quotes, ready to follow `VAR=`.
 */
function doubleQuoted(value: string): string {
  return `"${value.replace(/[\\"$`]/gu, (char) => `\\${char}`)}"`
}

/**
 * The detached installer script.
 *
 * The program waits for the app's PID to exit, attaches the image read only,
 * copies the app it carries into `<app>.dsh-new`, moves the installed bundle to
 * `<app>.dsh-backup`, moves the copy into place, detaches the image, relaunches,
 * and only then removes the backup. Each step that can fail logs its cause and
 * exits nonzero, so the log is the record of how far the install got. Bash is
 * given the program on stdin, so no temporary script file is written.
 *
 * @param plan - the install the script performs.
 * @returns the complete bash program text.
 */
export function buildInstallScript(plan: InstallerPlan): string {
  const lines = [
    '#!/bin/bash',
    '#',
    '# Install a downloaded disk image over this app bundle and relaunch it. The app',
    '# quits as soon as this script starts, so the script waits for that exit before',
    '# it touches the bundle and records every step in the log file it appends to.',
    '#',
    '# Individual exit codes are checked below, where each failure has a recovery, so',
    '# the script continues into its own rollback instead of aborting on the first',
    '# failing command.',
    'set -u',
    '',
    `APP=${doubleQuoted(plan.appBundle)}`,
    `DMG=${doubleQuoted(plan.dmgPath)}`,
    `LOG=${doubleQuoted(plan.logPath)}`,
    `PID=${String(plan.pid)}`,
    '',
    '# How long the app gets to quit, and how often its PID is polled.',
    `EXIT_WAIT_SECONDS=${String(EXIT_WAIT_SECONDS)}`,
    `EXIT_POLL_SECONDS=${String(EXIT_POLL_SECONDS)}`,
    `EXIT_WAIT_POLLS=${String(EXIT_WAIT_POLLS)}`,
    '',
    '# Set once the staged copy is in place. Every removal and rollback checks it,',
    '# and it marks the point past which the previous bundle must be kept.',
    'SWAPPED=0',
    '',
    '# Append one timestamped line to the log and echo it, so the log survives the',
    '# app that started this script and a manual run still shows progress.',
    'log() {',
    '  log_line="$(date \'+%Y-%m-%d %H:%M:%S\') $1"',
    '  printf \'%s\\n\' "${log_line}" >> "$LOG"',
    '  printf \'%s\\n\' "${log_line}"',
    '}',
    '',
    '# A nonzero exit before the swap is complete must not leave a staged copy beside',
    '# the app. Steps that know about their own failures remove it themselves, and',
    '# this trap covers the failures that leave through some other path, such as a',
    '# command they did not check. Past the swap there is no staged copy to remove,',
    '# so the trap stops there and a failed relaunch keeps the new bundle.',
    'cleanup() {',
    '  local status=$?',
    '  if [ "${status}" -ne 0 ] && [ "${SWAPPED}" -eq 0 ]; then',
    '    rm -rf "${APP}.dsh-new"',
    '  fi',
    '}',
    'trap cleanup EXIT',
    '',
    '# The mount point is the last tab-separated field of the last device line in the',
    '# attach output. A device line that names no mount point leaves the variable',
    '# alone rather than clearing a mount point an earlier line named.',
    'mount_from_attach() {',
    '  local mount_point=""',
    '  local device_line',
    '  while IFS= read -r device_line; do',
    '    case "${device_line}" in',
    '      /dev/*$\'\\t\'*) mount_point="${device_line##*$\'\\t\'}" ;;',
    '    esac',
    '  done <<< "$1"',
    '  printf \'%s\' "${mount_point}"',
    '}',
    '',
    'mkdir -p "$(dirname "$LOG")"',
    'log "installing ${DMG} over ${APP}, waiting for pid ${PID} to exit"',
    '',
    '# The bundle cannot be moved while the app that runs it is alive, so this is the',
    '# first wait. A PID that never exits leaves the installed app in place.',
    'waited=0',
    'while kill -0 "$PID" 2>/dev/null; do',
    '  waited=$((waited + 1))',
    '  if [ "${waited}" -ge "${EXIT_WAIT_POLLS}" ]; then',
    '    log "pid ${PID} was still running ${EXIT_WAIT_SECONDS} seconds after the install started; nothing was installed"',
    '    open -R "$DMG"',
    '    exit 1',
    '  fi',
    '  sleep "${EXIT_POLL_SECONDS}"',
    'done',
    'log "pid ${PID} has exited"',
    '',
    '# On a bare assignment, $? holds the status of the command substitution',
    '# until the next command runs, so each check in this script is the line',
    '# directly after its command.',
    'ATTACH_OUT="$(hdiutil attach "$DMG" -nobrowse -readonly -noverify 2>&1)"',
    'if [ $? -ne 0 ]; then',
    '  log "could not attach ${DMG}: ${ATTACH_OUT}"',
    '  exit 1',
    'fi',
    '',
    'MOUNT="$(mount_from_attach "${ATTACH_OUT}")"',
    'if [ -z "${MOUNT}" ]; then',
    '  log "could not find a mount point in the attach output for ${DMG}; the image stays attached"',
    '  open -R "$DMG"',
    '  exit 1',
    'fi',
    '',
    '# The image holds one app at its root. Anything else is a layout this installer',
    '# does not know how to swap, so the image is left attached for a manual install.',
    'VOLUME_APP=""',
    'VOLUME_APPS=0',
    'for candidate in "${MOUNT}"/*.app; do',
    '  if [ -d "${candidate}" ]; then',
    '    VOLUME_APP="${candidate}"',
    '    VOLUME_APPS=$((VOLUME_APPS + 1))',
    '  fi',
    'done',
    'if [ "${VOLUME_APPS}" -ne 1 ]; then',
    '  log "${MOUNT} holds ${VOLUME_APPS} .app bundles and the install needs exactly one; the image stays attached"',
    '  open -R "$DMG"',
    '  exit 1',
    'fi',
    'log "installing ${VOLUME_APP} from ${MOUNT}"',
    '',
    '# Staging beside the app keeps the swap a rename inside one directory, and it',
    '# means the installed bundle is untouched until the copy is known to be complete.',
    'COPY_ERR="$(ditto --rsrc --extattr "${VOLUME_APP}" "${APP}.dsh-new" 2>&1)"',
    'if [ $? -ne 0 ]; then',
    '  log "could not copy ${VOLUME_APP} to ${APP}.dsh-new: ${COPY_ERR}"',
    '  rm -rf "${APP}.dsh-new"',
    '  exit 1',
    'fi',
    '',
    'STAGED_EXECUTABLE=""',
    'for candidate in "${APP}.dsh-new/Contents/MacOS"/*; do',
    '  if [ -f "${candidate}" ] && [ -x "${candidate}" ]; then',
    '    STAGED_EXECUTABLE="${candidate}"',
    '    break',
    '  fi',
    'done',
    'if [ -z "${STAGED_EXECUTABLE}" ]; then',
    '  log "${APP}.dsh-new holds no executable in Contents/MacOS, so the copy is not an app"',
    '  rm -rf "${APP}.dsh-new"',
    '  exit 1',
    'fi',
    'log "staged ${APP}.dsh-new"',
    '',
    '# A copy made from a mounted image carries no quarantine attribute, and one',
    '# already stripped is the same result, so a failed strip is not a failure.',
    'if xattr -dr com.apple.quarantine "${APP}.dsh-new" 2>/dev/null; then',
    '  log "stripped the quarantine attribute from the staged copy"',
    'else',
    '  log "the staged copy carries no quarantine attribute to strip"',
    'fi',
    '',
    '# The version of the staged copy, which is what the app reports after it comes',
    '# back. A copy without a readable version is still installable.',
    'VERSION="$(defaults read "${APP}.dsh-new/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null)"',
    'if [ -z "${VERSION}" ]; then',
    '  log "could not read a version from the staged copy"',
    'else',
    '  log "the staged copy carries version ${VERSION}"',
    'fi',
    '',
    '# The swap: the installed bundle moves aside, and the staged copy takes its',
    '# place. A failure before the new bundle is in place puts the old one back.',
    'rm -rf "${APP}.dsh-backup"',
    '',
    'MOVE_ERR="$(mv "${APP}" "${APP}.dsh-backup" 2>&1)"',
    'if [ $? -ne 0 ]; then',
    '  log "could not move ${APP} aside: ${MOVE_ERR}"',
    '  rm -rf "${APP}.dsh-new"',
    '  exit 1',
    'fi',
    '',
    'MOVE_ERR="$(mv "${APP}.dsh-new" "${APP}" 2>&1)"',
    'if [ $? -ne 0 ]; then',
    '  log "could not move the staged copy into ${APP}: ${MOVE_ERR}"',
    '  if mv "${APP}.dsh-backup" "${APP}" 2>/dev/null; then',
    '    log "the previous bundle is back in ${APP}"',
    '  else',
    '    log "the previous bundle could not be moved back and stays at ${APP}.dsh-backup"',
    '  fi',
    '  open -R "$DMG"',
    '  exit 1',
    'fi',
    'SWAPPED=1',
    'log "the new bundle is in ${APP}"',
    '',
    '# A volume that is still busy is not a failed install, and the image can be',
    '# ejected by hand, so the detach failure is logged and ignored.',
    'if hdiutil detach "${MOUNT}" >/dev/null 2>&1; then',
    '  log "detached ${MOUNT}"',
    'else',
    '  log "could not detach ${MOUNT}; the install continues"',
    'fi',
    '',
    'OPEN_ERR="$(open "$APP" 2>&1)"',
    'if [ $? -ne 0 ]; then',
    '  log "the new version is installed but could not be launched: ${OPEN_ERR}"',
    '  log "the previous bundle stays at ${APP}.dsh-backup"',
    '  exit 1',
    'fi',
    'log "launched ${APP}"',
    '',
    'rm -rf "${APP}.dsh-backup"',
    'log "install complete"',
    'exit 0',
  ]
  return `${lines.join('\n')}\n`
}

/**
 * Start the installer, detached from this process so it survives the app quitting.
 *
 * The script waits for this process to exit before it touches the bundle, so it
 * cannot be a child that dies with the app: `detached` puts it in its own session,
 * and `unref` keeps it out of this process's event loop so the app can quit as soon
 * as the caller asks. The program arrives on stdin, which avoids a temporary script
 * file the next run would have to find and clean up. Both output streams are ignored
 * because the script writes to the log file the plan names instead, and nothing would
 * be left to read them.
 *
 * @param plan - the install to run.
 * @returns the child PID, or 0 when the spawn produced no process.
 */
export function launchInstaller(plan: InstallerPlan): number {
  const child = spawn('/bin/bash', [], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  child.stdin?.end(buildInstallScript(plan))
  child.unref()
  return child.pid ?? 0
}
