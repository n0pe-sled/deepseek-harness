/**
 * Shell (top bar) preload: exposes a typed instance-management API to the
 * shell page via window.dshManager.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/ipc.ts'
import type { AppTheme, ConnectionLogSnapshot } from '../shared/ipc.ts'
import type { UpdateSnapshot } from '../shared/update.ts'
import type { AddLocalInput, AddRawInput, AddSshInput, InstanceView } from '../shared/instance.ts'
import type { DshManagerApi } from '../shared/manager.ts'

const api: DshManagerApi = {
  list: () => ipcRenderer.invoke(IPC.managerList),
  addLocal: (input) => ipcRenderer.invoke(IPC.managerAddLocal, input),
  addSsh: (input) => ipcRenderer.invoke(IPC.managerAddSsh, input),
  addRaw: (input) => ipcRenderer.invoke(IPC.managerAddRaw, input),
  remove: (id) => ipcRenderer.invoke(IPC.managerRemove, id),
  connect: (id) => ipcRenderer.invoke(IPC.managerConnect, id),
  disconnect: () => ipcRenderer.invoke(IPC.managerDisconnect),
  active: () => ipcRenderer.invoke(IPC.managerActive),
  pickDsh: () => ipcRenderer.invoke(IPC.managerPickDsh),
  openInstances: () => ipcRenderer.send(IPC.managerOpenInstances),
  closeInstances: () => ipcRenderer.send(IPC.managerCloseInstances),
  getLog: (id) => ipcRenderer.invoke(IPC.managerGetLog, id),
  openLog: (id) => ipcRenderer.send(IPC.managerOpenLog, id),
  // The log window knows which instance it is showing from its own URL, the same
  // way the add modal reads `?add=<kind>`. Main validates the id against the store.
  logTarget: () => Promise.resolve(new URLSearchParams(window.location.search).get('log') ?? undefined),
  onLogUpdate: (cb) => subscribe<ConnectionLogSnapshot>(IPC.managerLogUpdate, cb),
  setTopbarVisible: (visible) => ipcRenderer.send(IPC.uiTopbarSet, visible),
  onTopbarChanged: (cb) => subscribe<boolean>(IPC.uiTopbarChanged, cb),
  onUpdate: (cb) => subscribe(IPC.managerUpdate, cb),
  onActiveChanged: (cb) => subscribe(IPC.managerActiveChanged, cb),
  onTheme: (cb) => subscribe<AppTheme>(IPC.managerTheme, cb),
  getTheme: () => ipcRenderer.invoke(IPC.managerGetTheme),
  // The update window shares this preload: it is a shell page like the others,
  // so it reaches the updater through this API rather than one of its own.
  update: {
    get: () => ipcRenderer.invoke(IPC.updateGet),
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    download: () => ipcRenderer.invoke(IPC.updateDownload),
    install: () => ipcRenderer.invoke(IPC.updateInstall),
    skip: () => ipcRenderer.invoke(IPC.updateSkip),
    log: () => ipcRenderer.invoke(IPC.updateLog),
    openRelease: (url) => ipcRenderer.send(IPC.updateOpenRelease, url),
    openWindow: () => ipcRenderer.send(IPC.updateOpenWindow),
    onState: (cb) => subscribe<UpdateSnapshot>(IPC.updateState, cb),
  },
}

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, value: T): void => cb(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

Object.defineProperty(globalThis, 'dshManager', {
  value: api,
  writable: false,
  configurable: false,
})
