import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // The real 'electron' module is provided by the Electron runtime; the
        // npm wrapper must never be bundled (it would try to download/re-run).
        external: ['electron'],
        input: { index: resolve(root, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        external: ['electron'],
        input: {
          manager: resolve(root, 'src/preload/manager.ts'),
          dsh: resolve(root, 'src/preload/dsh.ts'),
        },
        output: {
          // CJS preloads: deterministic and free of ESM-preload constraints.
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    build: {
      rollupOptions: {
        // One page per shell window: the top bar (which also serves the add
        // modal, the connection log window, and the in-tab connection view)
        // and the instance manager.
        input: {
          index: resolve(root, 'src/renderer/index.html'),
          instances: resolve(root, 'src/renderer/instances.html'),
        },
      },
    },
  },
})
