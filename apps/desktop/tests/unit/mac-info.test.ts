import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as {
  build: {
    appId?: string
    mac?: { extendInfo?: Record<string, string> }
  }
}

describe('macOS packaging metadata', () => {
  it('declares why the app accesses the local network', () => {
    // Chromium hides an app from the macOS Local Network pane and may silently
    // deny LAN fetches until this Info.plist declaration is present.
    expect(manifest.build.appId).toBe('ai.deepseek.dshdesktop')
    expect(manifest.build.mac?.extendInfo?.NSLocalNetworkUsageDescription)
      .toBe('DSH Desktop needs local network access to connect to local AI model servers.')
  })
})
