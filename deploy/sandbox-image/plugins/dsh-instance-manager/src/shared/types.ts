/**
 * Shared contract between the two halves of dsh-instance-manager. Pure
 * JSON-safe data and shapes, bundled into both halves — deliberately free of
 * runtime dependencies, like every module in this directory.
 *
 * The whole feature rides one settings namespace (`instance-manager`): the
 * saved list and the requested action are written by the client, and the host
 * reconciles actual child processes to it and writes runtime status back.
 * That keeps the transport on the existing settings pipe with no extra RPC
 * surface, and the settings-file provider makes the list durable under
 * $DSH_HOME for free.
 */

/** One saved instance, as the user configured it. */
export interface SavedInstance {
  /** Unique, human, and the registry key. */
  readonly name: string
  /** Directory the instance's harness runs in (a container-internal path). */
  readonly workspace: string
  /** Fixed web port. Absent = auto-assign from the base port. */
  readonly port?: number
  /** Extra environment the instance should carry. */
  readonly env?: Readonly<Record<string, string>>
  /** Start automatically when the harness boots. */
  readonly autoStart?: boolean
}

/** Runtime view of one instance, written by the host into the same document. */
export interface InstanceRuntimeStatus {
  readonly state: 'running' | 'stopped' | 'starting' | 'error'
  /** The URL the harness reported, when it is running. */
  readonly url?: string
  /** Last failure, when the child died before or after readiness. */
  readonly error?: string
}

/** The whole settings document for the namespace. */
export interface InstanceManagerSection {
  /** Saved instances, keyed by name (the array form is for the UI list). */
  readonly instances: readonly SavedInstance[]
  /** The instance the last Connect click named; consumed (nulled) by the host. */
  readonly connect?: string | null
  /** The instance the last Stop click named; consumed (nulled) by the host. */
  readonly stop?: string | null
  /** Host-written runtime view, keyed by instance name. Read from the snapshot. */
  readonly runtime?: Readonly<Record<string, InstanceRuntimeStatus>>
}

/** The plugin's own config surface (Plugins settings page). */
export interface InstanceManagerConfig {
  /** First port auto-assignment uses; one instance takes the next free after it. */
  readonly basePort: number
  /** The harness CLI the children boot. Default is the image's path. */
  readonly harnessCli: string
}
