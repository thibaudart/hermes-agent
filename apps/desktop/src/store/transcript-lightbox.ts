import { atom, type ReadableAtom } from 'nanostores'

import type { ComposerDraftAddress } from '@/app/chat/composer/plugin-image-attachment'
import { isElementInHiddenPane } from '@/components/pane-shell/pane-visibility'
import { $activeSessionId } from '@/store/session'

export interface TranscriptLightboxSelection {
  alt?: string
  captureDraft?: () => ComposerDraftAddress | null
  imageId: string | null
  source?: TranscriptImageSource
  src: string
  surfaceId: string | null
}

interface TranscriptImageSource {
  /** Only occurrences with a message address can outlive their DOM node. */
  remountable: boolean
  /** `null` means an addressed image is re-rendering; `undefined` means stale. */
  opener: () => HTMLButtonElement | null | undefined
}

const MESSAGE = '[data-message-id]'
const CHAT = '[data-chat-surface]'
const TRIGGER = '[data-transcript-image-trigger]'
const triggerSources = new WeakMap<HTMLButtonElement, string>()
const triggerWaiters = new Set<() => void>()
const paneScopes = new Map<string, { generation: number; isCurrent: () => boolean }>()
let unscopedEpoch = 0

export function registerTranscriptImageTrigger(trigger: HTMLButtonElement, src: string): () => void {
  triggerSources.set(trigger, src)

  if (triggerWaiters.size) {
    // Resolve addresses after all the replacement leaves commit, not halfway
    // through a message whose image order is still being rebuilt.
    queueMicrotask(() => triggerWaiters.forEach(check => check()))
  }

  return () => triggerSources.delete(trigger)
}

function messageTriggers(message: Element) {
  return [...message.querySelectorAll<HTMLButtonElement>(TRIGGER)].filter(
    trigger => trigger.closest(MESSAGE) === message
  )
}

export function captureTranscriptImageSource(
  trigger: HTMLButtonElement,
  src: string,
  surfaceId: string | null
): TranscriptImageSource | undefined {
  const surface = trigger.closest(CHAT)
  const scope = surfaceId === null ? undefined : paneScopes.get(surfaceId)

  if (surface && surfaceId !== null && !scope?.isCurrent()) {
    return undefined
  }

  const message = trigger.closest<HTMLElement>(MESSAGE)
  const messageId = message?.dataset.messageId
  const occurrence = message && messageId && surface?.contains(message) ? messageTriggers(message).indexOf(trigger) : -1
  const rowSelector = occurrence >= 0 && messageId ? `[data-message-id="${CSS.escape(messageId)}"]` : null
  const generation = scope?.generation ?? unscopedEpoch
  let replaced = false

  const scopeIsCurrent = () =>
    surfaceId === null
      ? generation === unscopedEpoch
      : paneScopes.get(surfaceId) === scope && (!scope || (scope.generation === generation && scope.isCurrent()))

  return {
    remountable: rowSelector !== null,
    opener: () => {
      if (replaced || !scopeIsCurrent()) {
        return undefined
      }

      if (surface && (!surface.isConnected || isElementInHiddenPane(surface))) {
        return undefined
      }

      const row = rowSelector ? surface?.querySelector(rowSelector) : null
      const originalInRow = row && trigger.isConnected && trigger.closest(MESSAGE) === row
      const current = !rowSelector || originalInRow ? trigger : row && messageTriggers(row)[occurrence]
      const currentSrc = current && triggerSources.get(current)

      if (rowSelector && (!current || currentSrc === undefined)) {
        return null
      }

      if (
        current?.isConnected &&
        !current.disabled &&
        current.closest(CHAT) === surface &&
        !isElementInHiddenPane(current) &&
        currentSrc === src
      ) {
        return current
      }

      // A different image at this address is a replacement, not an empty slot
      // waiting on the renderer. Do not let a later render revive the click.
      replaced = true
    }
  }
}

/** Give already-rendering local media a short chance to restore its opener.
 * This does not start a media load or look outside the captured message. */
export function waitForTranscriptImageOpener(
  source: TranscriptImageSource,
  isAllowed: () => boolean
): Promise<HTMLButtonElement | undefined> {
  const opener = isAllowed() ? source.opener() : undefined

  if (opener !== null) {
    return Promise.resolve(opener)
  }

  return new Promise(resolve => {
    const finish = (opener?: HTMLButtonElement) => {
      triggerWaiters.delete(check)
      clearTimeout(timeout)
      resolve(opener)
    }

    const check = () => {
      const current = isAllowed() ? source.opener() : undefined

      if (current !== null) {
        finish(current)
      }
    }

    const timeout = setTimeout(finish, 500)
    triggerWaiters.add(check)
  })
}

/** Keep the preview open when streaming replaces the selected leaf (#123018). */
export const $transcriptLightbox = atom<TranscriptLightboxSelection | null>(null)
let pendingAction: { dialog: EventTarget; finish: () => void } | undefined
let gestureVersion = 0

// Only viewers outside a mounted ChatView lack a pane lifecycle. A change
// in the primary route must never reset an unrelated split pane's preview.
$activeSessionId.listen(() => {
  unscopedEpoch += 1

  if ($transcriptLightbox.get()?.surfaceId === null) {
    $transcriptLightbox.set(null)
  }
})

/** One generation per pane/session. A recycled transcript row is not a new generation. */
export function registerTranscriptLightboxScope(
  surfaceId: string,
  sessionAtoms: readonly ReadableAtom<string | null>[] = []
): () => void {
  const sessionAtMount = sessionAtoms.map(atom => atom.get())
  const scope = { generation: 0, isCurrent: () => sessionAtoms.every((atom, i) => atom.get() === sessionAtMount[i]) }
  paneScopes.set(surfaceId, scope)

  const invalidate = () => {
    scope.generation += 1
    triggerWaiters.forEach(check => check())

    if ($transcriptLightbox.get()?.surfaceId === surfaceId) {
      $transcriptLightbox.set(null)
    }
  }

  // Observe only this pane's session. Invalidates queued events even if
  // React batches a navigation away and back into the same commit.
  const unsubscribe = sessionAtoms.map(atom => atom.listen(invalidate))

  return () => {
    unsubscribe.forEach(off => off())

    if (paneScopes.get(surfaceId) === scope) {
      paneScopes.delete(surfaceId)
      invalidate()
    }
  }
}

export function openTranscriptLightbox(selection: TranscriptLightboxSelection): void {
  if (selection.src) {
    gestureVersion += 1
    pendingAction = undefined
    triggerWaiters.forEach(check => check())
    $transcriptLightbox.set(selection)
  }
}

/** A click accepted by the viewer belongs to its closing focus scope, not its leaf. */
export function acceptTranscriptLightboxAction(
  selection: TranscriptLightboxSelection,
  dialog: EventTarget,
  finish: (isLatestGesture: () => boolean) => void
): void {
  if (!pendingAction && $transcriptLightbox.get() === selection) {
    const accepted = gestureVersion
    pendingAction = { dialog, finish: () => finish(() => accepted === gestureVersion) }
    $transcriptLightbox.set(null)
  }
}

export function finishTranscriptLightboxAction(dialog: EventTarget | null): boolean {
  if (!pendingAction || pendingAction.dialog !== dialog) {
    return false
  }

  const { finish } = pendingAction
  pendingAction = undefined
  finish()

  return true
}

/** Identity-guarded: only the row owning the currently-open source clears it. */
export function closeTranscriptLightbox(imageId: string): void {
  if ($transcriptLightbox.get()?.imageId === imageId) {
    $transcriptLightbox.set(null)
  }
}

/** Preserve the action capability only when the same occurrence can be found again. */
export function releaseTranscriptLightbox(imageId: string): void {
  const selection = $transcriptLightbox.get()

  if (selection?.imageId === imageId) {
    $transcriptLightbox.set({
      ...selection,
      captureDraft: selection.source?.remountable ? selection.captureDraft : undefined,
      source: selection.source?.remountable ? selection.source : undefined,
      imageId: null
    })
  }
}

/** Mount/test isolation: drop any open entry without a gesture. */
export function resetTranscriptLightbox(): void {
  gestureVersion += 1
  pendingAction = undefined
  triggerWaiters.forEach(check => check())
  $transcriptLightbox.set(null)
}
