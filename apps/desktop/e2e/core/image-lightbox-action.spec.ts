import * as fs from 'node:fs'
import * as path from 'node:path'

import { expect, test } from '@playwright/test'

import { coreAppEnv, createCoreSandbox, launchCoreApp, send, waitForInteractive, writeProviderHome } from './harness'
import { startScriptedProvider } from './provider'

// 160×100, large enough to click reliably in the transcript and attachment preview.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAAAsUlEQVR42u3RAQkAAAgEsY9kKxPazxoig0twy1TrcbEAsAALsAALsAALMGABFmABFmABFmDAAizAAizAAizAAgxYgAVYgAVYgAUYsAALsAALsAALMGABFmABFmABFmABBizAAizAAizAAgxYgAVYgAVYgAUYsAuABViABViABViAAQuwAAuwAAuwAAMWYAEWYAEWYAEWYMACLMACLMACLMCABViABViABViAAQuwAOteC0rNEsC6dC/GAAAAAElFTkSuQmCC'

const PLUGIN = `
import { atom, COMPOSER_AREAS, Dialog, DialogContent, DialogTitle, host, IMAGE_LIGHTBOX_ACTIONS_AREA, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
const selected = atom(null)
function ImageDialog() {
  const selection = useValue(selected)
  return jsx(Dialog, { open: Boolean(selection), onOpenChange: open => { if (!open) selected.set(null) }, children:
    jsxs(DialogContent, { children: [
      jsx(DialogTitle, { children: 'Image action test' }),
      jsx('input', { 'aria-label': 'Image caption' }),
      jsx('output', { children: (selection?.image?.type ?? 'No image') + ' / ' + (selection?.draft ? 'Draft ready' : 'No draft') }),
      jsx('button', { children: 'Attach selected image', onClick: async () => {
        const { draft, image } = selection
        if (draft && image && await host.composer.attachImage(draft, image, { filename: 'lightbox-result.png' })) {
          selected.set(null)
        }
      } })
    ] })
  })
}
export default { id: 'test-lightbox-action', name: 'Image action test', register(ctx) {
  ctx.register({ id: 'dialog', area: COMPOSER_AREAS.leading, render: () => jsx(ImageDialog, {}) })
  ctx.register({ id: 'open', area: IMAGE_LIGHTBOX_ACTIONS_AREA, data: {
    label: 'Use this image', onSelect: async ({ draft, readImage }) => selected.set({ draft, image: await readImage() })
  } })
} }
`

test('a runtime plugin receives the selected transcript image after the lightbox releases focus', async () => {
  const provider = await startScriptedProvider()
  const sandbox = createCoreSandbox('image-action')
  const plugins = path.join(sandbox.hermesHome, 'desktop-plugins', 'test-lightbox-action')
  fs.mkdirSync(plugins, { recursive: true })
  fs.writeFileSync(path.join(plugins, 'plugin.js'), PLUGIN)
  const image = path.join(sandbox.root, 'test-image.png')
  fs.writeFileSync(image, Buffer.from(PNG, 'base64'))
  writeProviderHome(sandbox.hermesHome, provider.url, 'display:\n  language: en\n')
  provider.script('U1-imageaction', [{ text: [`MEDIA:${image}\n\nImage action reply`] }])

  const { app, page } = await launchCoreApp(coreAppEnv(sandbox))

  try {
    await waitForInteractive(app, page)
    await send(page, 'U1-imageaction')
    await expect(page.getByText('Image action reply')).toBeVisible()
    const transcript = page.locator('[data-slot="aui_thread-viewport"]')
    await transcript.getByRole('button', { name: 'Open image', exact: true }).click()
    const lightbox = page.locator('[data-variant="media-lightbox"]')
    await lightbox.getByRole('button', { name: 'Use this image', exact: true }).click({ timeout: 10_000 })
    const modal = page.getByRole('dialog', { name: 'Image action test' })
    await expect(modal.getByRole('textbox', { name: 'Image caption' })).toBeFocused()
    await expect(lightbox).toHaveCount(0)
    await expect(modal.getByText('image/png / Draft ready')).toBeVisible({ timeout: 5_000 })
    await modal.getByRole('button', { name: 'Attach selected image' }).click()
    await expect(modal).toHaveCount(0, { timeout: 10_000 })

    const attachment = page
      .locator('[data-slot="composer-attachments"]')
      .getByRole('button', { name: /^Preview.*lightbox-result_.*\.png$/i })

    await expect(attachment).toBeVisible()
    const stagedImages = fs.readdirSync(path.join(sandbox.userDataDir, 'composer-images'))
    expect(stagedImages).toHaveLength(1)
    expect(fs.readFileSync(path.join(sandbox.userDataDir, 'composer-images', stagedImages[0]!))).toEqual(
      Buffer.from(PNG, 'base64')
    )
    await attachment.click()
    await expect(lightbox.getByRole('button', { name: 'Download image' })).toBeAttached()
    await expect(lightbox.getByRole('button', { name: 'Use this image' })).toHaveCount(0)
  } finally {
    await app.close().catch(() => undefined)
    await provider.close()
    sandbox.cleanup()
  }
})
