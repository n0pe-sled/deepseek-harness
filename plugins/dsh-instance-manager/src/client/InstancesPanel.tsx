/**
 * The Instances settings panel: a saved-instance list with live state plus an
 * add form. Inline styles on the --dsw-alias-* tokens only — the client
 * platform has no CSS pipeline for plugin bundles.
 *
 * Components never see ctx: props are the bound settings scope (through the
 * hooks compartment) and the action callbacks the entry passes in.
 */
import type { InstanceManagerSection, SavedInstance } from '../shared/types.ts'

export interface InstancesPanelProps {
  hooks: { instanceManagerSettings: { getSnapshot(): { status: string; value?: InstanceManagerSection } } }
  add(instance: SavedInstance): Promise<void>
  remove(name: string): Promise<void>
  connect(name: string): Promise<void>
  stop(name: string): Promise<void>
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  padding: '6px 0',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
}
const buttonStyle: React.CSSProperties = {
  font: 'inherit',
  padding: '2px 10px',
  cursor: 'pointer',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 4,
}
const inputStyle: React.CSSProperties = {
  font: 'inherit',
  flex: 1,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 4,
  padding: '4px 8px',
}

export function InstancesPanel(props: InstancesPanelProps) {
  const section = props.hooks.instanceManagerSettings.getSnapshot().value
  const runtime = section?.runtime ?? {}

  return (
    <div style={{ font: 'inherit', color: 'var(--dsw-alias-label-primary)', margin: '4px 0' }}>
      {(section?.instances ?? []).map((instance) => {
        const state = runtime[instance.name]?.state ?? 'stopped'
        return (
          <div key={instance.name} style={rowStyle}>
            <strong style={{ minWidth: 120 }}>{instance.name}</strong>
            <code style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }}>{instance.workspace}</code>
            <span style={{ color: state === 'running' ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)' }}>
              {state}
            </span>
            {runtime[instance.name]?.url !== undefined ? (
              <code style={{ fontSize: 12 }}>{runtime[instance.name]?.url}</code>
            ) : null}
            <button type="button" style={buttonStyle} onClick={() => void props.connect(instance.name)}>Connect</button>
            <button type="button" style={buttonStyle} onClick={() => void props.stop(instance.name)}>Stop</button>
            <button type="button" style={buttonStyle} onClick={() => void props.remove(instance.name)}>Remove</button>
          </div>
        )
      })}
      {(section?.instances ?? []).length === 0 ? (
        <em style={{ color: 'var(--dsw-alias-label-secondary)' }}>No saved instances yet — add one below.</em>
      ) : null}
      <form
        style={{ display: 'flex', gap: 8, marginTop: 12 }}
        onSubmit={(event) => {
          event.preventDefault()
          const form = event.currentTarget
          const name = form.elements.namedItem('name') as HTMLInputElement
          const workspace = form.elements.namedItem('workspace') as HTMLInputElement
          if (name.value.trim() === '' || workspace.value.trim() === '') return
          void props.add({ name: name.value.trim(), workspace: workspace.value.trim() })
          form.reset()
        }}
      >
        <input name="name" placeholder="Name" required style={inputStyle} />
        <input name="workspace" placeholder="Workspace path inside the container (e.g. /workspace)" required style={inputStyle} />
        <button type="submit" style={buttonStyle}>Add instance</button>
      </form>
    </div>
  )
}
