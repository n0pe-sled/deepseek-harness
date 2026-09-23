import type { AddLocalInput, AddRawInput, AddSshInput, InstanceView } from './instance.ts'
import type { AddKind, AppTheme } from './ipc.ts'

/** The manager API exposed to the shell page as window.dshManager. */
export interface DshManagerApi {
  list(): Promise<InstanceView[]>
  addLocal(input: AddLocalInput): Promise<InstanceView>
  addSsh(input: AddSshInput): Promise<InstanceView>
  addRaw(input: AddRawInput): Promise<InstanceView>
  remove(id: string): Promise<void>
  connect(id: string): Promise<InstanceView>
  disconnect(): Promise<void>
  active(): Promise<string | undefined>
  pickDsh(): Promise<string | null>
  /** Ask main to open the add-instance modal window (shell buttons; the File menu opens it directly). */
  openAdd(kind: AddKind): void
  /** Show (true) or hide (false) the top session bar. Main owns the layout. */
  setTopbarVisible(visible: boolean): void
  /** Mirror of the visibility main actually applied, for persistence. */
  onTopbarChanged(cb: (visible: boolean) => void): () => void
  onUpdate(cb: (views: InstanceView[]) => void): () => void
  onActiveChanged(cb: (id: string | undefined) => void): () => void
  /** Subscribe to the active dsh theme so the shell can match it. */
  onTheme(cb: (theme: AppTheme) => void): () => void
  /** Pull the current theme on boot (side-steps a startup race). */
  getTheme(): Promise<AppTheme | undefined>
}
