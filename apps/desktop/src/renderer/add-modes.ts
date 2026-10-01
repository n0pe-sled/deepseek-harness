/**
 * The add-instance forms, in one place because two pages build instances: the
 * top bar's add modal and the instance manager's new-instance pane. Field specs,
 * the DOM the fields render into, and the submit wiring live here so both pages
 * send identical requests.
 */
import { DEFAULT_SANDBOX_IMAGE } from '../shared/instance.ts'
import type { InstanceView } from '../shared/instance.ts'
import type { AddKind } from '../shared/ipc.ts'
import type { DshManagerApi } from '../shared/manager.ts'

/** Shown as the image field's placeholder; the default image resolves in main. */
export const DEFAULT_IMAGE_PLACEHOLDER = DEFAULT_SANDBOX_IMAGE

export interface FieldSpec {
  key: string
  label: string
  placeholder: string
  type?: 'text' | 'number' | 'toggle'
  required?: boolean
  /** Help text under the control, for options whose effect is not obvious. */
  hint?: string
  /** Toggles only: start switched on. */
  defaultOn?: boolean
}

/** One instance kind's form. */
export interface AddMode {
  /** Tab label in the instance manager's new-instance pane. */
  tab: string
  title: string
  fields: FieldSpec[]
  submit(api: DshManagerApi, values: Record<string, string>): Promise<InstanceView>
}

/** Kinds in the order the instance manager shows their tabs. */
export const ADD_KINDS: readonly AddKind[] = ['local', 'ssh', 'raw']

/** The forms, keyed by kind. */
export const MODES: Record<AddKind, AddMode> = {
  local: {
    tab: 'Local',
    title: 'Add local dsh instance',
    fields: [
      {
        key: 'sandbox',
        label: 'Sandbox in a container (recommended)',
        placeholder: '',
        type: 'toggle',
        defaultOn: true,
        hint: 'Runs dsh inside a Docker/Podman container: filesystem, processes, and every helper it spawns stay in the sandbox. '
          + 'Only mounted directories are shared. Switching this off runs dsh directly on this machine.',
      },
      { key: 'name', label: 'Name', placeholder: 'My local dsh', required: true },
      { key: 'image', label: 'Container image (optional)', placeholder: DEFAULT_IMAGE_PLACEHOLDER },
      { key: 'dshPath', label: 'dsh executable (no sandbox only)', placeholder: 'dsh' },
      { key: 'dshHome', label: 'DSH_HOME (no sandbox only)', placeholder: '/Users/me/.dsh' },
    ],
    async submit(api, values) {
      const env = values.dshHome !== '' && values.dshHome !== undefined ? { DSH_HOME: values.dshHome } : undefined
      const sandboxOn = values.sandbox === 'true'
      return await api.addLocal({
        name: values['name'] ?? 'local',
        ...(!sandboxOn && values.dshPath !== undefined && values.dshPath !== '' ? { dshPath: values.dshPath } : {}),
        ...(!sandboxOn && env !== undefined ? { env } : {}),
        ...(sandboxOn
          ? { sandbox: { enabled: true, ...(values.image !== undefined && values.image !== '' ? { image: values.image } : {}) } }
          : { sandbox: { enabled: false } }),
      })
    },
  },
  ssh: {
    tab: 'SSH',
    title: 'Add SSH remote',
    // The two switches come first: they decide how the connection is made at all,
    // and the fields below only describe where it lands.
    fields: [
      {
        key: 'provision',
        label: 'Ship this app\'s harness to the host',
        placeholder: '',
        type: 'toggle',
        defaultOn: true,
        hint: 'Runs our own staged harness there instead of using a dsh you installed. '
          + 'Needs key-based ssh, node on the host, and about 300MB of disk. '
          + 'With this on, the remote dsh port below is ignored.',
      },
      {
        key: 'sandbox',
        label: 'Run it in a sandbox container on the host (recommended)',
        placeholder: '',
        type: 'toggle',
        defaultOn: true,
        hint: 'Pulls the prebuilt sandbox image on the host and runs the harness in a container there. '
          + 'Needs Docker on the remote host, and no node install or closure shipping. Switching this off '
          + 'ships the bare closure and uses the host\'s own node. Only applies while this app\'s harness is shipped.',
      },
      { key: 'name', label: 'Name', placeholder: 'Work server', required: true },
      { key: 'host', label: 'SSH host', placeholder: 'server.example.com', required: true },
      { key: 'user', label: 'SSH user (optional)', placeholder: 'me' },
      { key: 'port', label: 'SSH port (optional)', placeholder: '22', type: 'number' },
      { key: 'remotePort', label: 'Remote dsh port', placeholder: '3000', type: 'number' },
      { key: 'identityFile', label: 'Identity file (optional)', placeholder: '~/.ssh/id_ed25519' },
      { key: 'sandboxImage', label: 'Container image (optional)', placeholder: DEFAULT_IMAGE_PLACEHOLDER },
    ],
    async submit(api, values) {
      const provision = values['provision'] === 'true'
      const sandboxOn = values['sandbox'] === 'true'
      return await api.addSsh({
        name: values['name'] ?? 'ssh',
        ssh: {
          host: values['host'] ?? '',
          ...(values['user'] !== undefined && values['user'] !== '' ? { user: values['user'] } : {}),
          ...(numbers(values, 'port') !== undefined ? { port: numbers(values, 'port') } : {}),
          // remotePort only means anything for a plain forward; a provisioned
          // instance discovers its port, so storing the field would be a lie.
          ...(!provision && numbers(values, 'remotePort') !== undefined ? { remotePort: numbers(values, 'remotePort') } : {}),
          ...(values['identityFile'] !== undefined && values['identityFile'] !== '' ? { identityFile: values['identityFile'] } : {}),
          ...(provision
            ? {
                provision: {},
                ...(sandboxOn
                  ? { sandbox: { enabled: true, ...(values['sandboxImage'] !== undefined && values['sandboxImage'] !== '' ? { image: values['sandboxImage'] } : {}) } }
                  : { sandbox: { enabled: false } }),
              }
            : {}),
        },
      })
    },
  },
  raw: {
    tab: 'URL',
    title: 'Add remote URL (advanced)',
    fields: [
      { key: 'name', label: 'Name', placeholder: 'Home box', required: true },
      { key: 'url', label: 'URL (http/https)', placeholder: 'https://dsh.example.com', required: true },
    ],
    async submit(api, values) {
      return await api.addRaw({ name: values['name'] ?? 'raw', url: values['url'] ?? '' })
    },
  },
}

/**
 * Build one mode's controls into `container`.
 *
 * Toggles render as a switch (a checkbox styled by `.toggle-track`) whose label
 * and hint sit beside the track; every other type renders as a labelled input.
 * @param container - element to fill; cleared first.
 * @param fields - the mode's field specs, in display order.
 */
export function renderFields(container: HTMLElement, fields: readonly FieldSpec[]): void {
  container.textContent = ''
  for (const field of fields) container.append(renderField(field))
}

/** One field's control, ready to append. */
function renderField(field: FieldSpec): HTMLElement {
  const label = document.createElement('label')
  const input = document.createElement('input')
  input.name = field.key
  input.placeholder = field.placeholder
  input.type = field.type === 'number' ? 'number' : 'text'
  input.required = field.required ?? false

  if (field.type === 'toggle') {
    label.className = 'field field-toggle'
    input.type = 'checkbox'
    // The checkbox shares the values map with every other field, so a switch
    // that is on reads as the string 'true' rather than a separate shape.
    input.value = 'true'
    input.checked = field.defaultOn ?? false
    const track = document.createElement('span')
    track.className = 'toggle-track'
    track.setAttribute('aria-hidden', 'true')
    const text = document.createElement('span')
    text.className = 'toggle-text'
    const name = document.createElement('span')
    name.className = 'toggle-label'
    name.textContent = field.label
    text.append(name)
    if (field.hint !== undefined) {
      const hint = document.createElement('small')
      hint.className = 'field-hint'
      hint.textContent = field.hint
      text.append(hint)
    }
    label.append(input, track, text)
    return label
  }

  label.className = 'field'
  const name = document.createElement('span')
  name.textContent = field.label
  label.append(name, input)
  if (field.hint !== undefined) {
    const hint = document.createElement('small')
    hint.className = 'field-hint'
    hint.textContent = field.hint
    label.append(hint)
  }
  return label
}

/**
 * Read one mode's values out of the DOM.
 *
 * A switch that is off contributes nothing, so `values[key]` is absent rather
 * than 'false' and every submit path tests for the string 'true'.
 * @param container - the element `renderFields` filled.
 * @returns the trimmed value of every present control.
 */
export function collectValues(container: HTMLElement): Record<string, string> {
  const values: Record<string, string> = {}
  for (const input of container.querySelectorAll<HTMLInputElement>('input')) {
    if (input.type === 'checkbox' && !input.checked) continue
    values[input.name] = input.value.trim()
  }
  return values
}

/** Parse one numeric field, or undefined when it is blank or not a number. */
export function numbers(values: Record<string, string>, key: string): number | undefined {
  const raw = values[key]
  if (raw === undefined || raw === '') return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}
