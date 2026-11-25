import { atom } from 'nanostores'

import type { ComposerDraftAddress } from '@/app/chat/composer/plugin-image-attachment'
import { $activeSessionId } from '@/store/session'

export interface TranscriptLightboxSelection {
  alt?: string
  captureDraft?: () => ComposerDraftAddress | null
  imageId: string | null
  opener?: HTMLButtonElement
  src: string
  surfaceId: string | null
}

/**
 * The transcript lightbox's open source, hoisted out of `ZoomableImage`.
 *
 * Transcript rows — and the markdown leaves inside them — legitimately remount
 * while a turn streams (the render-budget slice drops older rows; the markdown
 * AST re-parses as text grows), and the dialog's open flag used to be
 * component-local `useState`. A user-opened preview therefore closed itself
 * with no gesture the moment its row recycled (#123018). Keying the flag by
 * source identity here lets a remounted row re-present its own open dialog.
 *
 * One preview at a time (same as the component-local flag ever allowed),
 * process-memory only, cleared by an explicit close (Escape, backdrop, or
 * click) — never by a remount — and on a session switch, so a new transcript
 * never inherits the previous chat's open preview.
 */
export const $transcriptLightbox = atom<TranscriptLightboxSelection | null>(null)

// A stale open entry must not follow the user into another chat: the same
// media path can legitimately appear in two sessions, and a lightbox opening
// with no gesture there would be the bug again, inverted.
$activeSessionId.subscribe(() => resetTranscriptLightbox())

export function openTranscriptLightbox(selection: TranscriptLightboxSelection): void {
  if (selection.src) {
    $transcriptLightbox.set(selection)
  }
}

/** Identity-guarded: only the row owning the currently-open source clears it. */
export function closeTranscriptLightbox(imageId: string): void {
  if ($transcriptLightbox.get()?.imageId === imageId) {
    $transcriptLightbox.set(null)
  }
}

/** Preserve zoom through streaming remounts, but not the old click's action capability. */
export function releaseTranscriptLightbox(imageId: string): void {
  const selection = $transcriptLightbox.get()

  if (selection?.imageId === imageId) {
    $transcriptLightbox.set({
      alt: selection.alt,
      imageId: null,
      src: selection.src,
      surfaceId: selection.surfaceId
    })
  }
}

/** Mount/test isolation: drop any open entry without a gesture. */
export function resetTranscriptLightbox(): void {
  $transcriptLightbox.set(null)
}
