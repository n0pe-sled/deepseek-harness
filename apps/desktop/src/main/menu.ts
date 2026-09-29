/**
 * Native macOS application menu. The shell chrome lives in the window's top bar,
 * so the menu carries the things that bar cannot: the instance manager, the
 * per-kind add-instance entries, and the switch that hides the bar itself.
 */
import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { AddKind } from '../shared/ipc.ts'

export interface ShellMenuHandlers {
  onAdd(kind: AddKind): void
  /** Open the instance manager: the one place an instance is launched from. */
  onLaunchInstance(): void
  onToggleTopbar(): void
  /** Look for a newer release and show the result in the update window. */
  onCheckForUpdates(): void
}

/** Stable id so the check state can be refreshed after a toggle. */
const TOPBAR_ITEM = 'shell-topbar-toggle'

/** Stable id so the update item can dim itself while a build cannot update. */
const UPDATES_ITEM = 'shell-check-for-updates'

export function buildShellMenu(handlers: ShellMenuHandlers): Menu {
  const template: MenuItemConstructorOptions[] = [
    // macOS builds the App menu from `role: 'appMenu'`, which carries no place
    // for an item of our own, so the submenu is spelled out here instead. The
    // roles below it are what that role installs.
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        {
          id: UPDATES_ITEM,
          label: 'Check for Updates…',
          accelerator: 'CmdOrCtrl+U',
          click: () => handlers.onCheckForUpdates(),
        },
        { type: 'separator' },
        { role: 'services', submenu: [] },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'Launch Instance…',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => handlers.onLaunchInstance(),
        },
        { type: 'separator' },
        {
          label: 'New Local Instance…',
          accelerator: 'CmdOrCtrl+L',
          click: () => handlers.onAdd('local'),
        },
        {
          label: 'New SSH Remote…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => handlers.onAdd('ssh'),
        },
        {
          label: 'Add Remote URL…',
          accelerator: 'CmdOrCtrl+Shift+U',
          click: () => handlers.onAdd('raw'),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          id: TOPBAR_ITEM,
          label: 'Show Session Bar',
          accelerator: 'CmdOrCtrl+B',
          type: 'checkbox',
          checked: true,
          click: () => handlers.onToggleTopbar(),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]

  const menu = Menu.buildFromTemplate(template)
  return menu
}

/** Reflect the current bar visibility in the View menu checkmark. */
export function setTopbarChecked(menu: Menu, visible: boolean): void {
  const item = menu.getMenuItemById(TOPBAR_ITEM)
  if (item !== null) item.checked = visible
}

/**
 * Enable or dim the update check.
 *
 * A build that did not come from a bundle has no bundle to replace, so the item
 * stays visible but dim rather than disappearing, which would leave a user hunting
 * for a menu item their build never had.
 *
 * @param menu - the shell menu.
 * @param enabled - whether this build can check for an update.
 */
export function setUpdatesEnabled(menu: Menu, enabled: boolean): void {
  const item = menu.getMenuItemById(UPDATES_ITEM)
  if (item !== null) item.enabled = enabled
}
