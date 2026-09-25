/**
 * Browser half of dsh-instance-manager: an Instances section on the Settings
 * page listing saved instances with their runtime state, plus a small add
 * form and Connect/Stop/Remove actions.
 *
 * All writes go through the bound settings scope: adding and removing mutate
 * the `instances` array; Connect and Stop write request fields the host
 * consumes and clears. Status is read from the snapshot's `runtime` map — the
 * host is the only authority on it, and the read-back discipline is the same
 * as every settings surface: render the snapshot, never predict it.
 *
 * The bound scope is created ONCE in apply (observable identity must stay
 * stable so the renderer's hook binding is cached per source). Export
 * discipline (packages/client/AGENTS.md): this entry exports only apply/
 * inject and shared types; the component stays internal.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls in the settings.section slot declaration + ctx.settingsScope merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: ctx.slots and the SlotMap types.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { SavedInstance } from '../shared/types.ts'
import { InstancesPanel, type InstancesPanelProps } from './InstancesPanel.tsx'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'settingsScope']

export type { SavedInstance }

/** Register the Instances section (see InstancesPanel for the rendering). */
export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<InstanceManagerSectionLike>({ namespace: 'instance-manager' })

  const readInstances = (): readonly SavedInstance[] => scope.getSnapshot().value?.instances ?? []

  const add = async (instance: SavedInstance): Promise<void> => {
    const current = readInstances()
    await scope.set('instances', [...current.filter((i) => i.name !== instance.name), instance])
    // Write-back verification: the host is the authority on what landed.
    if (scope.getSnapshot().value?.instances.some((i) => i.name === instance.name) !== true) {
      throw new Error(`the instance "${instance.name}" did not persist`)
    }
  }

  const remove = async (name: string): Promise<void> => {
    await scope.set('instances', readInstances().filter((i) => i.name !== name))
  }

  const connect = async (name: string): Promise<void> => {
    await scope.set('connect', name)
  }

  const stop = async (name: string): Promise<void> => {
    await scope.set('stop', name)
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'instance-manager',
    order: 210,
    label: 'Instances',
    inject: () => ({
      hooks: { instanceManagerSettings: scope },
      add,
      remove,
      connect,
      stop,
    } satisfies InstancesPanelProps),
  }, InstancesPanel))
}

/** Narrowed client-side view of the bound scope (set/unset reject on refusal). */
interface InstanceManagerSectionLike {
  getSnapshot(): { status: string; value?: import('../shared/types.ts').InstanceManagerSection }
  set(field: keyof import('../shared/types.ts').InstanceManagerSection, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}
