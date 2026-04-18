interface DraftActionStripProps {
  draftLabel: string
  errorMessage?: string | null
  layoutSyncNote?: {
    label: string
    title: string
  } | null
  onAccept?: () => void | Promise<void>
  onReject?: () => void | Promise<void>
  pending?: boolean
}

export function DraftActionStrip({
  draftLabel,
  errorMessage = null,
  layoutSyncNote = null,
  onAccept,
  onReject,
  pending = false,
}: DraftActionStripProps) {
  return (
    <section className="cbv-draft-strip" aria-label="Draft actions">
      <div className="cbv-draft-strip-copy">
        <p className="cbv-eyebrow">Draft</p>
        <strong>{draftLabel}</strong>
        {layoutSyncNote ? (
          <p className="cbv-draft-strip-note" title={layoutSyncNote.title}>
            {layoutSyncNote.label}
          </p>
        ) : null}
        {errorMessage ? <p className="cbv-draft-strip-error">{errorMessage}</p> : null}
      </div>
      <div className="cbv-draft-strip-actions">
        <button
          className="cbv-toolbar-button"
          disabled={pending || !onAccept}
          onClick={() => {
            void onAccept?.()
          }}
          type="button"
        >
          Accept Draft
        </button>
        <button
          className="cbv-toolbar-button is-secondary"
          disabled={pending || !onReject}
          onClick={() => {
            void onReject?.()
          }}
          type="button"
        >
          Reject Draft
        </button>
      </div>
    </section>
  )
}
