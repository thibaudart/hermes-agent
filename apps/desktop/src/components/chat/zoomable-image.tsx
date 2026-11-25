'use client'

import { useStore } from '@nanostores/react'
import { type ComponentProps, type MouseEvent, useCallback, useEffect, useId, useLayoutEffect, useRef } from 'react'

import { composerDraftCaptureForSurface, composerDraftIsCurrent } from '@/app/chat/composer/plugin-image-attachment'
import { useComposerSurfaceId } from '@/app/chat/composer/scope'
import { isElementInHiddenPane, usePaneVisible } from '@/components/pane-shell/pane-visibility'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useZoomPan } from '@/components/ui/use-zoom-pan'
import { useContributions } from '@/contrib/react/use-contributions'
import { registry } from '@/contrib/registry'
import type { Contribution } from '@/contrib/types'
import { useImageDownload } from '@/hooks/use-image-download'
import { useI18n } from '@/i18n'
import { Download, ZoomIn, ZoomOut } from '@/lib/icons'
import {
  IMAGE_LIGHTBOX_ACTIONS_AREA,
  type ImageLightboxActionContribution,
  isReadableLightboxImage,
  readLightboxImage
} from '@/lib/image-lightbox-actions'
import { cn } from '@/lib/utils'
import {
  $transcriptLightbox,
  acceptTranscriptLightboxAction,
  captureTranscriptImageSource,
  closeTranscriptLightbox,
  finishTranscriptLightboxAction,
  openTranscriptLightbox,
  registerTranscriptImageTrigger,
  releaseTranscriptLightbox,
  type TranscriptLightboxSelection,
  waitForTranscriptImageOpener
} from '@/store/transcript-lightbox'

export interface ZoomableImageProps extends ComponentProps<'img'> {
  /** Classes for the click target around the image, e.g. a definite height inside a reserved frame. */
  buttonClassName?: string
  containerClassName?: string
  slot?: string
  /** Only opt in from a chat transcript, never a private image viewer. */
  transcriptActions?: boolean
  /** Full-resolution source for the lightbox and download. When set, the inline
   * `<img>` keeps its bounded `src` (avoiding heavy inline paints) while the
   * zoom view and Save action use the original — so a click-to-zoom shows real
   * detail instead of an upscaled thumbnail. Defaults to `src`. */
  zoomSrc?: string
}

export interface ImageActionCopy {
  downloadImage: string
  savingImage: string
  zoomIn: string
  zoomOut: string
  resetZoom: string
}

export function useImageLightbox(src: string, alt: string | undefined, transcriptActions = false) {
  const imageId = useId()
  const surfaceId = useComposerSurfaceId()
  const visible = usePaneVisible()
  const selection = useStore($transcriptLightbox)
  const trigger = useRef<HTMLButtonElement | null>(null)

  const ref = useCallback(
    (node: HTMLButtonElement | null) => {
      if (node && transcriptActions) {
        trigger.current = node
        const unregister = registerTranscriptImageTrigger(node, src)

        return () => {
          trigger.current = null
          unregister()
        }
      }
    },
    [src, transcriptActions]
  )

  const matches = visible && selection?.surfaceId === surfaceId && selection.src === src && selection.alt === alt

  useLayoutEffect(() => {
    if (!selection || $transcriptLightbox.get() !== selection) {
      return
    }

    if (selection.imageId === imageId && !matches) {
      closeTranscriptLightbox(imageId)
    }

    // An addressed preview can only be reclaimed by that exact occurrence.
    if (matches && selection.imageId === null && (!selection.source || selection.source.opener() === trigger.current)) {
      openTranscriptLightbox({ ...selection, imageId })
    }
  }, [imageId, matches, selection])

  useLayoutEffect(() => () => releaseTranscriptLightbox(imageId), [imageId])

  const open = matches && selection.imageId === imageId

  return {
    open,
    openFrom: (event: MouseEvent<HTMLButtonElement>) => {
      const source = transcriptActions ? captureTranscriptImageSource(event.currentTarget, src, surfaceId) : undefined

      if (transcriptActions && !source) {
        return
      }

      openTranscriptLightbox({
        alt,
        captureDraft: source ? composerDraftCaptureForSurface(surfaceId) : undefined,
        imageId,
        source,
        src,
        surfaceId
      })
    },
    close: () => closeTranscriptLightbox(imageId),
    selection: open && transcriptActions && selection.source ? selection : undefined,
    triggerProps: { 'data-transcript-image-trigger': transcriptActions ? '' : undefined, ref }
  }
}

export function ZoomableImage({
  buttonClassName,
  className,
  containerClassName,
  src,
  zoomSrc,
  alt,
  slot,
  transcriptActions,
  ...props
}: ZoomableImageProps) {
  const { t } = useI18n()
  const copy = t.desktop
  // The lightbox and Save action prefer the full-resolution source; the inline
  // thumbnail (`src`) stays the cheap paint.
  const fullSrc = zoomSrc || src || ''
  const { download, saving } = useImageDownload(fullSrc)
  const lightbox = useImageLightbox(fullSrc, alt, transcriptActions)
  const canOpen = Boolean(src)

  return (
    <>
      <span
        className={cn('group/image relative inline-block max-w-full align-top', containerClassName)}
        data-slot={slot ?? 'aui_zoomable-image'}
      >
        <button
          aria-label={canOpen ? copy.openImage : undefined}
          className={cn(
            'block max-w-full focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2',
            buttonClassName
          )}
          disabled={!canOpen}
          onClick={lightbox.openFrom}
          type="button"
          {...lightbox.triggerProps}
        >
          <img alt={alt ?? ''} className={className} src={src} {...props} />
        </button>
        {src && (
          <ImageActionButton className="group-hover/image:opacity-100" copy={copy} onClick={download} saving={saving} />
        )}
      </span>
      {src && (
        <ImageLightbox
          alt={alt}
          copy={copy}
          onClick={download}
          onOpenChange={open => !open && lightbox.close()}
          open={lightbox.open}
          saving={saving}
          selection={lightbox.selection}
          src={fullSrc}
        />
      )}
    </>
  )
}

export function ImageLightbox({
  alt,
  copy,
  onClick,
  onOpenChange,
  open,
  saving,
  selection,
  src
}: {
  alt?: string
  copy: ImageActionCopy
  onClick: () => void
  onOpenChange: (open: boolean) => void
  open: boolean
  saving: boolean
  selection?: TranscriptLightboxSelection
  src: string
}) {
  const focusScope = useRef<{ dialog: EventTarget | null; opener: () => HTMLElement | null | undefined } | null>(null)

  // Shared pan/zoom mechanics (wheel zoom, drag pan, pinch) come from
  // useZoomPan — the same hook the diagram/artifact viewer uses, so there is a
  // single source of truth for this gesture math. `moved` lets us close the
  // lightbox on a clean click while leaving pans/pinches alone.
  const { moved, panning, ref, reset, scale, stageProps, style, zoomIn, zoomOut } = useZoomPan<HTMLImageElement>({
    enabled: open
  })

  // Reset zoom whenever the lightbox opens.
  useEffect(() => {
    if (open) {
      reset()
    }
  }, [open, reset])

  const onImageClick = () => {
    // A pan/pinch gesture must not close the lightbox; only a clean click.
    if (!moved) {
      onOpenChange(false)
    }
  }

  const cursor = scale > 1 ? (panning ? 'grabbing' : 'grab') : 'zoom-out'

  const selectAction = (entry: Contribution, action: ImageLightboxActionContribution['onSelect']) => {
    const dialog = focusScope.current?.dialog
    const source = selection?.source
    const isRegistered = () => registry.getArea(IMAGE_LIGHTBOX_ACTIONS_AREA).includes(entry)

    if (!dialog || !source || $transcriptLightbox.get() !== selection || !isRegistered() || !source.opener()) {
      return
    }

    const draft = selection.captureDraft?.() ?? null
    const isAllowed = () => isRegistered() && (!draft || composerDraftIsCurrent(draft))
    const isCurrent = () => isAllowed() && Boolean(source.opener())

    acceptTranscriptLightboxAction(selection, dialog, isLatestGesture => {
      let image: Promise<Blob | null> | undefined

      const readImage = async () => {
        if (!(await waitForTranscriptImageOpener(source, isAllowed)) || !isCurrent()) {
          return null
        }

        const blob = await (image ??= readLightboxImage(src))

        return (await waitForTranscriptImageOpener(source, isAllowed)) && isCurrent() ? blob : null
      }

      const focusAfterClose = globalThis.document.activeElement
      // Radix removes the old focus scope after the close event returns.
      void Promise.resolve()
        .then(async () => {
          const mayRestoreFocus = () => isLatestGesture() && globalThis.document.activeElement === focusAfterClose
          const mayDispatch = () => mayRestoreFocus() && isAllowed()
          const opener = source.opener() ?? (await waitForTranscriptImageOpener(source, mayDispatch))

          if (opener && mayRestoreFocus() && source.opener() === opener) {
            opener.focus({ preventScroll: true })

            if (isLatestGesture() && isAllowed() && source.opener() === opener) {
              await action({ alt: alt ?? '', draft, readImage })
            }
          }
        })
        .catch(() => console.warn(`[${IMAGE_LIGHTBOX_ACTIONS_AREA}] ${entry.id} onSelect() failed`))
    })
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        bodyClassName="block overflow-visible p-0"
        chrome={
          open && (
            <div
              className="fixed bottom-4 left-1/2 z-50 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-full border border-border/70 bg-background/85 p-1 shadow-lg backdrop-blur"
              onClick={event => event.stopPropagation()}
              onPointerDown={event => event.stopPropagation()}
            >
              <button
                aria-label={copy.zoomOut}
                className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                disabled={scale <= 0.25}
                onClick={() => zoomOut()}
                type="button"
              >
                <ZoomOut className="size-4" />
              </button>
              <button
                aria-label={copy.resetZoom}
                className="min-w-14 rounded-full px-2 text-center text-xs font-medium tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => reset()}
                type="button"
              >
                {Math.round(scale * 100)}%
              </button>
              <button
                aria-label={copy.zoomIn}
                className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                disabled={scale >= 8}
                onClick={() => zoomIn()}
                type="button"
              >
                <ZoomIn className="size-4" />
              </button>
              {selection && isReadableLightboxImage(src) && <LightboxActions onSelect={selectAction} />}
            </div>
          )
        }
        className="w-auto max-h-[calc(100vh-12rem)] max-w-[calc(100vw-12rem)] border-0 bg-transparent! shadow-none!"
        // The media-lightbox shell variant. styles.css paints every
        // [data-slot='dialog-content'] with the themed elevated background +
        // --shadow-md — fine for opaque dialogs, but this shell is meant to be
        // an invisible frame around the image: when a zoomed/panned image moves
        // inside it, that paint shows as a stray box of shell area the image
        // no longer covers. tailwind-merge cannot drop the base `shadow-nous`
        // (unknown class group, so it survives next to `shadow-none`), and the
        // attribute selector out-specifies the plain utilities — hence the
        // important utilities and the data-variant opt-out in styles.css.
        data-variant="media-lightbox"
        // These viewers open through state rather than DialogTrigger. Preserve
        // the real opener instead of letting Radix's missing trigger lose focus.
        onCloseAutoFocus={event => {
          event.preventDefault()

          if (finishTranscriptLightboxAction(event.target)) {
            return
          }

          const scope = focusScope.current
          const opener = scope && scope.dialog === event.target ? scope.opener() : null

          if (opener?.isConnected && !isElementInHiddenPane(opener)) {
            opener.focus({ preventScroll: true })
          }
        }}
        onOpenAutoFocus={event => {
          const opener = globalThis.document.activeElement
          focusScope.current = {
            dialog: event.target,
            opener: selection?.source?.opener ?? (() => (opener instanceof HTMLElement ? opener : null))
          }
        }}
        overlayClassName="bg-black/60"
        showCloseButton={false}
      >
        <div className="group/lightbox relative inline-block">
          <img
            alt={alt ?? ''}
            className={cn(
              'block max-h-[calc(100vh-12rem)] max-w-[calc(100vw-12rem)] select-none rounded-lg object-contain shadow-2xl',
              panning && 'cursor-grabbing'
            )}
            onClick={onImageClick}
            ref={ref}
            src={src}
            style={{ ...style, cursor, touchAction: 'none' }}
            {...stageProps}
          />
          <ImageActionButton
            className="group-hover/lightbox:opacity-100"
            copy={copy}
            onClick={onClick}
            saving={saving}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function LightboxActions({
  onSelect
}: {
  onSelect: (entry: Contribution, action: ImageLightboxActionContribution['onSelect']) => void
}) {
  const contributions = useContributions(IMAGE_LIGHTBOX_ACTIONS_AREA)

  return contributions.map(entry => {
    const { data, id } = entry
    const action = data as ImageLightboxActionContribution | undefined

    if (typeof action?.label !== 'string' || !action.label.trim() || typeof action.onSelect !== 'function') {
      return null
    }

    return (
      <Button
        className="max-w-48 rounded-full"
        key={id}
        onClick={() => onSelect(entry, action.onSelect)}
        size="sm"
        type="button"
        variant="ghost"
      >
        <span className="truncate">{action.label}</span>
      </Button>
    )
  })
}

export function ImageActionButton({
  className,
  copy,
  onClick,
  saving
}: {
  className?: string
  copy: ImageActionCopy
  onClick: () => void
  saving: boolean
}) {
  return (
    <button
      aria-label={saving ? copy.savingImage : copy.downloadImage}
      className={cn(
        'absolute right-2 top-2 grid size-8 place-items-center rounded-full border border-border/70 bg-background/80 text-muted-foreground opacity-0 shadow-sm backdrop-blur transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 disabled:opacity-50',
        className
      )}
      disabled={saving}
      onClick={event => {
        event.stopPropagation()
        void onClick()
      }}
      type="button"
    >
      <Download className={cn('size-4', saving && 'animate-pulse')} />
    </button>
  )
}
