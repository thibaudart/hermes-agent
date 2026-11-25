import { Blob as NodeBlob } from 'node:buffer'
import { URL as NodeURL } from 'node:url'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { atom } from 'nanostores'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { registerFloatingComposer } from '@/app/chat/composer/floating-target'
import { attachImageToComposerDraft, registerComposerImageRecipient } from '@/app/chat/composer/plugin-image-attachment'
import { ComposerSurfaceProvider } from '@/app/chat/composer/scope'
import { UserMessageText } from '@/components/assistant-ui/thread/user-message-text'
import { registry } from '@/contrib/registry'
import { I18nProvider } from '@/i18n/context'
import {
  IMAGE_LIGHTBOX_ACTIONS_AREA,
  type ImageLightboxActionContext,
  readLightboxImage
} from '@/lib/image-lightbox-actions'
import { $activeSessionId } from '@/store/session'
import { registerTranscriptLightboxScope, resetTranscriptLightbox } from '@/store/transcript-lightbox'

import { GeneratedImage } from './generated-image-result'
import { ZoomableImage } from './zoomable-image'

vi.mock('./image-generation-placeholder', () => ({ DiffusionCanvas: () => null }))

const SRC = 'https://example.com/long-detail.png'
const ALT = 'long detail image'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQi1gAAAGuARekSxIOAAAAAElFTkSuQmCC'
const DATA_IMAGE = `data:image/png;base64,${PNG}`

async function renderImage() {
  let result!: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <I18nProvider configClient={{ getConfig: async () => ({}), saveConfig: async () => ({ ok: true }) }}>
        <ZoomableImage alt={ALT} src={SRC} />
      </I18nProvider>
    )
  })

  return result
}

async function openLightbox() {
  const trigger = screen.getByAltText(ALT).closest('button')
  expect(trigger).toBeTruthy()
  await act(async () => {
    fireEvent.click(trigger!)
  })
}

function lightboxImg(): HTMLImageElement {
  const dialog = screen.getByRole('dialog')

  return within(dialog).getByRole('img') as HTMLImageElement
}

function scaleOf(img: HTMLElement): number {
  const match = img.style.transform.match(/scale\(([0-9.]+)\)/)

  return match ? parseFloat(match[1]) : 1
}

function translateX(img: HTMLElement): number {
  const match = img.style.transform.match(/translate\(([-0-9.]+)px/)

  return match ? parseFloat(match[1]) : 0
}

function percentageText(): string {
  const node = screen.getByText(/\d+%/)

  return node.textContent ?? ''
}

it('reads a live image Blob URL but rejects it once revoked', async () => {
  const src = NodeURL.createObjectURL(
    new NodeBlob([Uint8Array.from(atob(PNG), char => char.charCodeAt(0))], { type: 'image/png' })
  )

  try {
    expect(await readLightboxImage(src)).toMatchObject({ type: 'image/png' })
  } finally {
    NodeURL.revokeObjectURL(src)
  }

  await expect(readLightboxImage(src)).resolves.toBeNull()
})

it('bounds the decoded byte count of image Blob URLs', async () => {
  const src = NodeURL.createObjectURL(new NodeBlob([new Uint8Array(16 * 1024 * 1024 + 1)], { type: 'image/png' }))

  try {
    await expect(readLightboxImage(src)).resolves.toBeNull()
  } finally {
    NodeURL.revokeObjectURL(src)
  }
})

describe('ZoomableImage lightbox', () => {
  let unregisterComposer: (() => void) | undefined

  afterEach(() => {
    unregisterComposer?.()
    unregisterComposer = undefined
    cleanup()
    resetTranscriptLightbox()
  })

  it('opens the lightbox when the inline image is activated', async () => {
    await renderImage()
    await openLightbox()

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(lightboxImg()).toBeTruthy()
  })

  it('hands only the selected full-resolution image to a plugin after closing the viewer', async () => {
    const read = vi.spyOn(globalThis, 'fetch')

    const onSelect = vi.fn(async ({ alt, readImage }: { alt: string; readImage: () => Promise<Blob | null> }) => {
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(alt).toBe('selected image')
      const blob = await readImage()
      expect(blob?.type).toBe('image/png')
      expect(await blob?.arrayBuffer()).toEqual(Uint8Array.from(atob(PNG), char => char.charCodeAt(0)).buffer)

      return blob
    })

    const unregister = registry.register({
      area: IMAGE_LIGHTBOX_ACTIONS_AREA,
      id: 'test',
      data: { label: 'Edit image', onSelect }
    })

    try {
      await renderWithI18n(<ZoomableImage alt="selected image" src={THUMB} transcriptActions zoomSrc={DATA_IMAGE} />)
      fireEvent.click(screen.getByAltText('selected image'))
      expect(read).not.toHaveBeenCalled()
      expect(onSelect).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Edit image' }))
      await waitFor(() => expect(onSelect).toHaveBeenCalledOnce())
      await expect(onSelect.mock.results[0]?.value).resolves.toBeInstanceOf(Blob)
    } finally {
      unregister()
      read.mockRestore()
    }
  })

  it.each([false, true])('does not dispatch a disposed action (same ID re-registered: %s)', async replace => {
    const onSelect = vi.fn()

    const register = () =>
      registry.register({
        area: IMAGE_LIGHTBOX_ACTIONS_AREA,
        id: 'test',
        data: { label: 'Edit image', onSelect }
      })

    const unregister = register()
    let unregisterReplacement: (() => void) | undefined

    try {
      await renderWithI18n(<ZoomableImage alt="selected image" src={DATA_IMAGE} transcriptActions />)
      fireEvent.click(screen.getByRole('button', { name: 'Open image' }))
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Edit image' }))
        unregister()

        if (replace) {
          unregisterReplacement = register()
        }
      })
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })

      expect(screen.queryByRole('dialog')).toBeNull()
      expect(onSelect).not.toHaveBeenCalled()
    } finally {
      unregisterReplacement?.()

      if (!replace) {unregister()}
    }
  })

  it('revokes a disposed action’s lazy read, including one already in flight', async () => {
    let finishRead!: (response: Response) => void

    const fetchImage = vi.spyOn(globalThis, 'fetch').mockReturnValue(
      new Promise(resolve => {
        finishRead = resolve
      })
    )

    const onSelect = vi.fn<(context: ImageLightboxActionContext) => void>()

    const unregister = registry.register({
      area: IMAGE_LIGHTBOX_ACTIONS_AREA,
      id: 'test',
      data: { label: 'Edit image', onSelect }
    })

    try {
      await renderWithI18n(<ZoomableImage alt="selected image" src={DATA_IMAGE} transcriptActions />)
      fireEvent.click(screen.getByRole('button', { name: 'Open image' }))
      fireEvent.click(screen.getByRole('button', { name: 'Edit image' }))
      await waitFor(() => expect(onSelect).toHaveBeenCalledOnce())
      const { readImage } = onSelect.mock.calls[0]![0]
      const pending = readImage()
      await waitFor(() => expect(fetchImage).toHaveBeenCalledOnce())
      unregister()
      finishRead(new Response('declared image bytes', { headers: { 'content-type': 'image/png' } }))

      await expect(pending).resolves.toBeNull()
      await expect(readImage()).resolves.toBeNull()
      expect(fetchImage).toHaveBeenCalledOnce()
    } finally {
      unregister()
      fetchImage.mockRestore()
    }
  })

  it.each([false, true])('restores the selected occurrence before handoff (image re-resolves: %s)', async resolving => {
    const leaveSession = registerTranscriptLightboxScope('source')

    const onSelect = vi.fn(({ readImage }: ImageLightboxActionContext) => ({
      dialog: screen.queryByRole('dialog'),
      focus: globalThis.document.activeElement,
      image: readImage()
    }))

    const unregister = registry.register({
      area: IMAGE_LIGHTBOX_ACTIONS_AREA,
      id: 'test',
      data: { label: 'Edit image', onSelect }
    })

    const ui = (key: string | null) => (
      <I18nProvider configClient={null} initialLocale="en">
        <ComposerSurfaceProvider value="source">
          <div data-chat-surface="" data-composer-surface-id="source">
            <div data-message-id="reply">
              <ZoomableImage alt="selected image" src={DATA_IMAGE} transcriptActions />
              {key && <ZoomableImage alt="selected image" key={key} src={DATA_IMAGE} transcriptActions />}
            </div>
          </div>
        </ComposerSurfaceProvider>
      </I18nProvider>
    )

    try {
      const { rerender } = render(ui('before'))
      const original = screen.getAllByRole('button', { name: 'Open image' })[1]!
      original.focus()
      fireEvent.click(original)
      fireEvent.click(screen.getByRole('button', { name: 'Edit image' }))

      if (resolving) {
        rerender(ui(null))
        // Local media may briefly return to its ordinary loading placeholder.
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 0))
        })
      }

      rerender(ui('after'))
      const replacement = screen.getAllByRole('button', { name: 'Open image' })[1]!
      expect(replacement).not.toBe(original)

      await waitFor(() => expect(onSelect).toHaveBeenCalledOnce(), { timeout: 1_000 })
      const result = onSelect.mock.results[0]!.value
      expect(result.dialog).toBeNull()
      expect(result.focus).toBe(replacement)
      await expect(result.image).resolves.toMatchObject({ type: 'image/png' })
    } finally {
      leaveSession()
      unregister()
    }
  })

  it.each(['source replaced', 'pane hidden'])('revokes a lazy read when its %s', async invalidation => {
    const onSelect = vi.fn<(context: ImageLightboxActionContext) => void>()

    const unregister = registry.register({
      area: IMAGE_LIGHTBOX_ACTIONS_AREA,
      id: 'test',
      data: { label: 'Edit image', onSelect }
    })

    const read = vi.spyOn(globalThis, 'fetch')
    const image = (src: string) => <ZoomableImage alt="selected image" src={src} transcriptActions />

    try {
      const { container, rerender } = await renderWithI18n(image(DATA_IMAGE))
      fireEvent.click(screen.getByRole('button', { name: 'Open image' }))
      fireEvent.click(screen.getByRole('button', { name: 'Edit image' }))
      await waitFor(() => expect(onSelect).toHaveBeenCalledOnce())

      if (invalidation === 'pane hidden') {
        container.setAttribute('data-pane-hidden', '')
      } else {
        rerender(
          <I18nProvider configClient={null} initialLocale="en">
            {image(THUMB)}
          </I18nProvider>
        )
      }

      await expect(onSelect.mock.calls[0]![0].readImage()).resolves.toBeNull()
      expect(read).not.toHaveBeenCalled()
    } finally {
      unregister()
      read.mockRestore()
    }
  })

  it('does not dispatch to an identical image in a new session on the same pane', async () => {
    const onSelect = vi.fn()

    const unregister = registry.register({
      area: IMAGE_LIGHTBOX_ACTIONS_AREA,
      id: 'test',
      data: { label: 'Edit image', onSelect }
    })

    const session = atom('original-session')
    const leaveSession = registerTranscriptLightboxScope('source', [session])

    try {
      await renderWithI18n(
        <ComposerSurfaceProvider value="source">
          <div data-chat-surface="">
            <div data-message-id="same-id">
              <ZoomableImage alt="selected image" src={DATA_IMAGE} transcriptActions />
            </div>
          </div>
        </ComposerSurfaceProvider>
      )
      fireEvent.click(screen.getByRole('button', { name: 'Open image' }))
      fireEvent.click(screen.getByRole('button', { name: 'Edit image' }))
      act(() => session.set('replacement-session'))
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })

      expect(screen.queryByRole('dialog')).toBeNull()
      expect(onSelect).not.toHaveBeenCalled()
    } finally {
      leaveSession()
      unregister()
    }
  })

  it('does not close a split-pane lightbox when the primary session changes', async () => {
    const onSelect = vi.fn()

    const unregister = registry.register({
      area: IMAGE_LIGHTBOX_ACTIONS_AREA,
      id: 'test',
      data: { label: 'Use tile image', onSelect }
    })

    const original = $activeSessionId.get()
    const leavePrimary = registerTranscriptLightboxScope('primary', [$activeSessionId])
    const leaveTile = registerTranscriptLightboxScope('tile')

    try {
      await renderWithI18n(
        <>
          <ComposerSurfaceProvider value="primary">
            <div data-chat-surface="">
              <ZoomableImage alt="primary image" src={DATA_IMAGE} transcriptActions />
            </div>
          </ComposerSurfaceProvider>
          <ComposerSurfaceProvider value="tile">
            <div data-chat-surface="">
              <ZoomableImage alt="tile image" src={DATA_IMAGE} transcriptActions />
            </div>
          </ComposerSurfaceProvider>
        </>
      )
      fireEvent.click(screen.getByAltText('tile image'))
      act(() => $activeSessionId.set('another-primary-session'))
      fireEvent.click(screen.getByRole('button', { name: 'Use tile image' }))
      await waitFor(() => expect(onSelect).toHaveBeenCalledOnce())
    } finally {
      leavePrimary()
      leaveTile()
      $activeSessionId.set(original)
      unregister()
    }
  })

  it('cancels an accepted action if its exact draft is replaced before focus teardown', async () => {
    const registerDraft = () =>
      registerComposerImageRecipient({
        attach: vi.fn(async () => true),
        capture: () => () => true,
        sessionKey: 'original-draft',
        surfaceId: 'source',
        target: 'main'
      })

    const removeDraft = registerDraft()
    let removeReplacement: (() => void) | undefined
    const onSelect = vi.fn()

    const unregister = registry.register({
      area: IMAGE_LIGHTBOX_ACTIONS_AREA,
      id: 'test',
      data: { label: 'Edit image', onSelect }
    })

    try {
      await renderWithI18n(
        <ComposerSurfaceProvider value="source">
          <div data-composer-surface-id="source" data-composer-target="main">
            <ZoomableImage alt="selected image" src={DATA_IMAGE} transcriptActions />
          </div>
        </ComposerSurfaceProvider>
      )
      fireEvent.click(screen.getByRole('button', { name: 'Open image' }))
      fireEvent.click(screen.getByRole('button', { name: 'Edit image' }))
      removeDraft()
      removeReplacement = registerDraft()
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(onSelect).not.toHaveBeenCalled()
    } finally {
      removeDraft()
      removeReplacement?.()
      unregister()
    }
  })

  it.each([false, true])('targets the originating surface (composer replaced: %s)', async replaced => {
    const mainAttach = vi.fn(async () => true)
    const sourceAttach = vi.fn(async () => true)

    const register = (surfaceId: string, attach: typeof sourceAttach) =>
      registerComposerImageRecipient({
        attach,
        capture: () => () => true,
        sessionKey: surfaceId,
        surfaceId,
        target: 'main'
      })

    const removeMain = register('other', mainAttach)
    const removeSource = register('source', sourceAttach)
    let removeReplacement: (() => void) | undefined
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ close: vi.fn(), height: 1, width: 1 }))
    )

    const onSelect = vi.fn(async ({ draft, readImage }: ImageLightboxActionContext) => {
      const blob = await readImage()
      expect(blob).toBeInstanceOf(Blob)

      return draft && blob ? attachImageToComposerDraft(draft, blob) : null
    })

    const unregister = registry.register({
      area: IMAGE_LIGHTBOX_ACTIONS_AREA,
      id: 'test',
      data: { label: 'Send edit', onSelect }
    })

    try {
      await renderWithI18n(
        <>
          <div data-composer-surface-id="other" data-composer-target="main">
            <ComposerSurfaceProvider value="other">
              <ZoomableImage alt="other image" src={DATA_IMAGE} transcriptActions />
            </ComposerSurfaceProvider>
          </div>
          <div data-composer-surface-id="source" data-composer-target="main">
            <ComposerSurfaceProvider value="source">
              <ZoomableImage alt="origin image" src={DATA_IMAGE} transcriptActions />
            </ComposerSurfaceProvider>
          </div>
        </>
      )
      fireEvent.click(screen.getByAltText('origin image'))
      expect(lightboxImg().alt).toBe('origin image')

      if (replaced) {
        removeSource()
        removeReplacement = register('source', mainAttach)
      }

      fireEvent.click(screen.getByRole('button', { name: 'Send edit' }))
      await waitFor(() => expect(onSelect).toHaveBeenCalledOnce())
      await expect(onSelect.mock.results[0]?.value).resolves.toBe(replaced ? null : true)
      expect(mainAttach).not.toHaveBeenCalled()
      expect(sourceAttach).toHaveBeenCalledTimes(replaced ? 0 : 1)
    } finally {
      unregister()
      removeMain()
      removeSource()
      removeReplacement?.()
      vi.unstubAllGlobals()
    }
  })

  it('offers actions on the generated-image transcript card', async () => {
    const onSelect = vi.fn()

    const unregister = registry.register({
      area: IMAGE_LIGHTBOX_ACTIONS_AREA,
      id: 'test',
      data: { label: 'Edit generated image', onSelect }
    })

    try {
      await renderWithI18n(
        <ComposerSurfaceProvider value="source">
          <GeneratedImage result={{ image: DATA_IMAGE, success: true }} />
        </ComposerSurfaceProvider>
      )
      fireEvent.click(screen.getByRole('button', { name: 'Open image' }))
      fireEvent.click(screen.getByRole('button', { name: 'Edit generated image' }))
      await waitFor(() => expect(onSelect).toHaveBeenCalledOnce())
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ alt: 'Generated image', draft: null }))
    } finally {
      cleanup()
      unregister()
    }
  })

  it('offers actions on embedded images in sent user messages', async () => {
    const onSelect = vi.fn()

    const unregister = registry.register({
      area: IMAGE_LIGHTBOX_ACTIONS_AREA,
      id: 'test',
      data: { label: 'Edit sent image', onSelect }
    })

    try {
      await renderWithI18n(<UserMessageText text={`Image: ${DATA_IMAGE}`} transcriptActions />)
      fireEvent.click(screen.getByRole('button', { name: 'Open image' }))
      fireEvent.click(screen.getByRole('button', { name: 'Edit sent image' }))
      await waitFor(() => expect(onSelect).toHaveBeenCalledOnce())
    } finally {
      cleanup()
      unregister()
    }
  })

  it.each(['file:///private/image.png', 'https://example.test/image.png?token=opaque', 'data:text/plain,not-an-image'])(
    'keeps unsupported sources in the built-in viewer without offering plugin reads (%s)',
    async src => {
      const onSelect = vi.fn()

      const unregister = registry.register({
        area: IMAGE_LIGHTBOX_ACTIONS_AREA,
        id: 'test',
        data: { label: 'Read image', onSelect }
      })

      const read = vi.spyOn(globalThis, 'fetch')

      try {
        await renderWithI18n(<ZoomableImage alt="unsupported source" src={src} transcriptActions />)
        fireEvent.click(screen.getByRole('button', { name: 'Open image' }))
        const dialog = within(screen.getByRole('dialog'))
        expect(dialog.getByRole('button', { name: 'Download image' })).toBeTruthy()
        expect(dialog.queryByRole('button', { name: 'Read image' })).toBeNull()
        expect(onSelect).not.toHaveBeenCalled()
        expect(read).not.toHaveBeenCalled()
      } finally {
        cleanup()
        unregister()
        read.mockRestore()
      }
    }
  )

  it('requires a new selection after the open source is replaced', async () => {
    const original = (src: string) => <ZoomableImage alt="changing image" src={src} transcriptActions />
    const onSelect = vi.fn()

    const unregister = registry.register({
      area: IMAGE_LIGHTBOX_ACTIONS_AREA,
      id: 'test',
      data: { label: 'Read source', onSelect }
    })

    try {
      const { rerender } = await renderWithI18n(original(DATA_IMAGE))
      fireEvent.click(screen.getByRole('button', { name: 'Open image' }))
      expect(screen.getByRole('button', { name: 'Read source' })).toBeTruthy()
      rerender(
        <I18nProvider configClient={null} initialLocale="en">
          {original(THUMB)}
        </I18nProvider>
      )
      expect(screen.queryByRole('dialog')).toBeNull()
      rerender(
        <I18nProvider configClient={null} initialLocale="en">
          {original(DATA_IMAGE)}
        </I18nProvider>
      )
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(onSelect).not.toHaveBeenCalled()
    } finally {
      cleanup()
      unregister()
    }
  })

  it.each(['Escape', 'image click'] as const)(
    'returns focus to the transcript opener after closing via %s',
    async closeWith => {
      const { container } = await renderImage()
      container.dataset.chatSurface = ''
      container.dataset.composerSurfaceId = 'image-chat'
      const host = globalThis.document.createElement('div')
      host.dataset.composerOwner = 'image-chat'
      const editor = globalThis.document.createElement('div')
      editor.dataset.slot = 'composer-rich-input'
      editor.tabIndex = -1
      host.append(editor)
      container.append(host)
      unregisterComposer = registerFloatingComposer('image-chat', { groupId: 'image-zone', target: 'main' })

      const trigger = screen.getByRole('button', { name: /open image/i })
      fireEvent.keyDown(globalThis.document, { key: 'Tab' })
      trigger.focus()
      fireEvent.keyUp(trigger, { key: 'Tab' })
      fireEvent.keyDown(trigger, { key: 'Enter' })
      await openLightbox()

      await act(async () => {
        if (closeWith === 'Escape') {
          fireEvent.keyDown(globalThis.document, { key: 'Escape' })
        } else {
          fireEvent.click(lightboxImg())
        }
      })

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(globalThis.document.activeElement).toBe(trigger)
      })
    }
  )

  it('wheel zooms toward the cursor and prevents the page from scrolling', async () => {
    await renderImage()
    await openLightbox()
    const img = lightboxImg()

    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, deltaY: -100 })
    const preventDefault = vi.spyOn(wheel, 'preventDefault')

    await act(async () => {
      img.dispatchEvent(wheel)
    })

    expect(preventDefault).toHaveBeenCalled()
    expect(scaleOf(img)).toBeGreaterThan(1)
  })

  it('zoom buttons update the zoom percentage', async () => {
    await renderImage()
    await openLightbox()

    const zoomIn = screen.getByRole('button', { name: /zoom in/i })
    const reset = screen.getByRole('button', { name: /reset/i })
    const zoomOut = screen.getByRole('button', { name: /zoom out/i })

    await act(async () => {
      fireEvent.click(zoomIn)
    })
    expect(percentageText()).toBe('125%')

    await act(async () => {
      fireEvent.click(reset)
    })
    expect(percentageText()).toBe('100%')

    await act(async () => {
      fireEvent.click(zoomOut)
    })
    // 1 / 1.25 = 0.8 → 80%
    expect(percentageText()).toBe('80%')
  })

  it('pans after zoom but does not close the lightbox', async () => {
    await renderImage()
    await openLightbox()
    const img = lightboxImg()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /zoom in/i }))
    })
    expect(scaleOf(img)).toBeCloseTo(1.25, 5)

    await act(async () => {
      fireEvent.pointerDown(img, { clientX: 10, clientY: 10, pointerId: 1 })
    })
    await act(async () => {
      fireEvent.pointerMove(img, { clientX: 60, clientY: 10, pointerId: 1 })
    })
    await act(async () => {
      fireEvent.pointerUp(img, { clientX: 60, clientY: 10, pointerId: 1 })
    })

    expect(translateX(img)).not.toBe(0)
    // A pan must NOT close the lightbox.
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('closes the lightbox on a clean click (no pan/pinch)', async () => {
    await renderImage()
    await openLightbox()
    const img = lightboxImg()

    await act(async () => {
      fireEvent.click(img)
    })

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('pinch zooms with two pointers', async () => {
    await renderImage()
    await openLightbox()
    const img = lightboxImg()

    await act(async () => {
      fireEvent.pointerDown(img, { clientX: 100, clientY: 100, pointerId: 1 })
    })
    await act(async () => {
      fireEvent.pointerDown(img, { clientX: 200, clientY: 100, pointerId: 2 })
    })
    await act(async () => {
      fireEvent.pointerMove(img, { clientX: 50, clientY: 100, pointerId: 1 })
    })
    await act(async () => {
      fireEvent.pointerMove(img, { clientX: 250, clientY: 100, pointerId: 2 })
    })

    expect(scaleOf(img)).toBeGreaterThan(1)

    await act(async () => {
      fireEvent.pointerUp(img, { clientX: 50, clientY: 100, pointerId: 1 })
    })
    await act(async () => {
      fireEvent.pointerUp(img, { clientX: 250, clientY: 100, pointerId: 2 })
    })
  })

  it('recovers from pointercancel and treats the next single-pointer gesture as a pan, not a pinch', async () => {
    await renderImage()
    await openLightbox()
    const img = lightboxImg()

    // Zoom in so panning engages (pan only applies above scale 1).
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /zoom in/i }))
    })
    expect(scaleOf(img)).toBeCloseTo(1.25, 5)

    // Start a gesture with pointer 1, then the browser cancels it (e.g. it
    // steals the gesture for a scroll). Without cleanup the stale pointer
    // lingers and the next pointerdown is misread as a pinch.
    await act(async () => {
      fireEvent.pointerDown(img, { clientX: 100, clientY: 100, pointerId: 1 })
    })
    await act(async () => {
      fireEvent.pointerCancel(img, { clientX: 100, clientY: 100, pointerId: 1 })
    })

    // A fresh single pointer (id 2) should pan cleanly by 60px (100 → 160).
    await act(async () => {
      fireEvent.pointerDown(img, { clientX: 100, clientY: 100, pointerId: 2 })
    })
    await act(async () => {
      fireEvent.pointerMove(img, { clientX: 160, clientY: 100, pointerId: 2 })
    })
    await act(async () => {
      fireEvent.pointerUp(img, { clientX: 160, clientY: 100, pointerId: 2 })
    })

    // Scale is unchanged (no pinch zoom), and the image panned the expected 60px.
    expect(scaleOf(img)).toBeCloseTo(1.25, 5)
    expect(translateX(img)).toBeCloseTo(60, 5)
  })
})

async function renderWithI18n(ui: ReactNode) {
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <I18nProvider configClient={{ getConfig: async () => ({}), saveConfig: async () => ({ ok: true }) }}>
        {ui}
      </I18nProvider>
    )
  })

  return result!
}

const THUMB = 'data:image/png;base64,dGh1bWJuYWls'
const FULL = 'data:image/png;base64,ZnVsbHJlc29sdXRpb24='

describe('ZoomableImage zoomSrc', () => {
  afterEach(() => {
    cleanup()
    resetTranscriptLightbox()
  })

  it('paints the bounded src inline but enlarges the full-resolution zoomSrc (#93204)', async () => {
    await renderWithI18n(<ZoomableImage alt="shot" src={THUMB} zoomSrc={FULL} />)

    // Inline stays the cheap thumbnail — no multi-MB paint.
    const inline = screen.getByAltText('shot') as HTMLImageElement
    expect(inline.getAttribute('src')).toBe(THUMB)

    // Click to zoom: the lightbox must show the original, not the thumbnail.
    fireEvent.click(inline)

    await waitFor(() => {
      const full = screen.getAllByAltText('shot').find(img => img.getAttribute('src') === FULL)
      expect(full).toBeDefined()
    })

    expect(screen.queryAllByAltText('shot').some(img => img.getAttribute('src') === THUMB)).toBe(true)
  })

  it('falls back to src for the lightbox when no zoomSrc is given', async () => {
    await renderWithI18n(<ZoomableImage alt="shot" src={THUMB} />)

    fireEvent.click(screen.getByAltText('shot'))

    await waitFor(() => {
      // Both inline and lightbox use src — backward compatible with callers that
      // pass a single source.
      expect(screen.getAllByAltText('shot').every(img => img.getAttribute('src') === THUMB)).toBe(true)
    })
  })

  // #123018: transcript rows remount routinely while a turn streams (render-
  // budget slice recycling, markdown AST re-parse). The open flag lives in a
  // store keyed by source identity, so a remounted row re-presents its own
  // open lightbox instead of dropping it.
  it('re-presents an open lightbox after the row unmounts and remounts (#123018)', async () => {
    const { unmount } = await renderWithI18n(<ZoomableImage alt="shot" src={THUMB} zoomSrc={FULL} />)

    fireEvent.click(screen.getByAltText('shot'))

    await waitFor(() => {
      expect(screen.getAllByAltText('shot').some(img => img.getAttribute('src') === FULL)).toBe(true)
    })

    // The row recycles — component-local state dies with it.
    unmount()
    await renderWithI18n(<ZoomableImage alt="shot" src={THUMB} zoomSrc={FULL} />)

    await waitFor(() => {
      expect(screen.getAllByAltText('shot').some(img => img.getAttribute('src') === FULL)).toBe(true)
    })
  })

  it('keeps only one preview open at a time and only the owning row can close it', async () => {
    await renderWithI18n(
      <>
        <ZoomableImage alt="one" src={THUMB} zoomSrc={FULL} />
        <ZoomableImage alt="two" src={THUMB} zoomSrc={THUMB} />
      </>
    )

    fireEvent.click(screen.getAllByAltText('one')[0]!)

    await waitFor(() => {
      expect(screen.getAllByAltText('one').some(img => img.getAttribute('src') === FULL)).toBe(true)
    })

    // Opening the second preview replaces the first — same one-at-a-time UX
    // as the component-local flag.
    fireEvent.click(screen.getAllByAltText('two')[0]!)

    await waitFor(() => {
      expect(screen.getAllByAltText('two').some(img => img.getAttribute('src') === THUMB)).toBe(true)
      expect(screen.queryAllByAltText('one').every(img => img.getAttribute('src') !== FULL)).toBe(true)
    })
  })
})
