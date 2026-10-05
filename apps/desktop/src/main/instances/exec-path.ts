/**
 * PATH assembly for spawned children.
 *
 * A macOS app started from Finder or the Dock does not inherit the login
 * shell's PATH; launchd hands it `/usr/bin:/bin:/usr/sbin:/sbin`. That covers
 * tar and ssh, but nothing a package manager installs, so the harness, its
 * Node runtime, and the container CLIs have to be searched for where they are
 * normally installed. Spawns that shell out build their PATH here instead of
 * trusting the inherited one.
 */
import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'

/** System directories added to the child PATH so dsh and its Node runtime resolve. */
const SYSTEM_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin', '/bin']

/**
 * Where a container CLI lives when nothing was symlinked into a directory
 * already on PATH. Docker Desktop carries its CLI inside the app bundle, and
 * the /usr/local/bin symlink into it is an install-time option, so the bundle
 * path is searched directly. Podman Desktop installs to /opt/podman by
 * default.
 */
const CONTAINER_CLI_SYSTEM_DIRS = ['/Applications/Docker.app/Contents/Resources/bin', '/opt/podman/bin']

/** The same, relative to the user's home: Docker's own bin, OrbStack, Rancher Desktop. */
const CONTAINER_CLI_HOME_DIRS = ['.docker/bin', '.orbstack/bin', '.rd/bin']

function joined(parts: readonly string[]): string {
  return [...new Set(parts.filter((part) => part !== ''))].join(':')
}

/** Append common user and system executable directories for LaunchServices apps. */
export function augmentPath(path: string, home?: string): string {
  const userPathDirs = home === undefined || home === '' ? [] : [`${home}/.local/bin`, `${home}/bin`]
  return joined([path, ...userPathDirs, ...SYSTEM_PATH_DIRS])
}

/**
 * A copy of `env` whose PATH carries the standard executable directories.
 *
 * A child that shells out resolves its own helpers through the PATH it is handed,
 * and ssh is one: its `ProxyCommand` runs through the user's shell, which
 * searches that PATH. An app started from Finder hands its ssh children
 * launchd's PATH, so a `ProxyCommand` naming an installed helper such as `ncat`
 * fails with "command not found" and ssh reports the connection closed with no
 * peer. Taking a copy leaves the caller's environment untouched.
 *
 * @param env - environment the child would otherwise inherit.
 * @returns a copy with the widened PATH and every other entry unchanged.
 */
export function augmentedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, PATH: augmentPath(env.PATH ?? '', env.HOME) }
}

/**
 * The PATH a container CLI runs with: `augmentPath` plus the directories the
 * CLI itself lives in. The CLI needs the widened PATH for more than its own
 * lookup, because it resolves credential helpers and plugins on PATH too, and
 * a `docker login` from a Dock-launched app otherwise fails to find
 * `docker-credential-osxkeychain`.
 */
export function containerPath(path: string, home?: string): string {
  const homeDirs = home === undefined || home === '' ? [] : CONTAINER_CLI_HOME_DIRS.map((dir) => `${home}/${dir}`)
  return joined([...augmentPath(path, home).split(':'), ...CONTAINER_CLI_SYSTEM_DIRS, ...homeDirs])
}

/**
 * The absolute path of the first executable named `name` on `pathValue`, or
 * undefined when it is on no directory there. Returning a path rather than a
 * name keeps the caller from resolving the binary twice, which is what let a
 * probe approve one docker and a later spawn run another.
 */
export function findExecutable(name: string, pathValue: string): string | undefined {
  for (const dir of pathValue.split(':')) {
    if (dir === '') continue
    const candidate = join(dir, name)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not an executable file here. The next directory may have it.
    }
  }
  return undefined
}
