import type { ComposerDraftAddress } from '@/app/chat/composer/plugin-image-attachment'

export const IMAGE_LIGHTBOX_ACTIONS_AREA = 'imageLightbox.actions'

export interface ImageLightboxActionContext {
  /** The selected image's alt text, or an empty string. */
  readonly alt: string
  /** The originating composer draft, if still available when the action was selected. */
  readonly draft: ComposerDraftAddress | null
  /** Lazily read the selected full-resolution `data:image/…` or live `blob:`
   * source (including bytes already materialized by the renderer from remote
   * media). Never reads a direct remote URL or file path. Returns null for a
   * stale, missing, unreadable, or ineligible source. The host checks the
   * declared image MIME type and encoded byte size (up to 16 MiB), not whether
   * the bytes decode. Treat them as untrusted and handle decoding safely. */
  readImage(): Promise<Blob | null>
}

/** Payload of an `imageLightbox.actions` contribution's `data`. */
export interface ImageLightboxActionContribution {
  label: string
  /** Called after the native lightbox closes and releases focus. */
  onSelect: (context: ImageLightboxActionContext) => void | Promise<void>
}

const MAX_IMAGE_BYTES = 16 * 1024 * 1024

export function isReadableLightboxImage(src: string): boolean {
  return /^blob:/i.test(src) || (/^data:image\//i.test(src) && src.length <= MAX_IMAGE_BYTES * 3 + 1024)
}

/** Read only already-resolved renderer sources; never reach a gateway or the native file bridge. */
export async function readLightboxImage(src: string): Promise<Blob | null> {
  if (!isReadableLightboxImage(src)) {
    return null
  }

  try {
    const response = await fetch(src, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' })
    const type = response.headers.get('content-type') ?? ''

    if (!response.ok || !/^image\//i.test(type) || !response.body) {
      await response.body?.cancel()

      return null
    }

    const reader = response.body.getReader()
    const chunks: BlobPart[] = []
    let size = 0

    for (;;) {
      const { done, value } = await reader.read()

      if (done) {
        return size ? new Blob(chunks, { type }) : null
      }

      size += value.byteLength

      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel()

        return null
      }

      chunks.push(value)
    }
  } catch {
    // A previously displayed blob URL may have been revoked before selection.
    return null
  }
}
