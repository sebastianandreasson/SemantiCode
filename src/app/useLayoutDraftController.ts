import { useState } from 'react'

import {
  mutateDraft,
  postLayoutSuggestion,
} from './apiClient'
import type { LayoutDraft, LayoutSpec } from '../types'

interface UseLayoutDraftControllerInput {
  activeDraftId: string | null
  draftLayouts: LayoutDraft[]
  rootDir: string | null
  onAcceptApplied: (layoutId: string | null) => void
  onRejectApplied: (draftId: string) => void
  onSuggestionApplied: (draftId: string) => void
  onError: (message: string | null) => void
  refreshLayoutState: () => Promise<{
    layouts: LayoutSpec[]
    draftLayouts: LayoutDraft[]
    activeLayoutId: string | null
    activeDraftId: string | null
  }>
}

export function useLayoutDraftController(
  input: UseLayoutDraftControllerInput,
) {
  const [layoutActionPending, setLayoutActionPending] = useState(false)
  const [layoutSuggestionPending, setLayoutSuggestionPending] = useState(false)
  const [layoutSuggestionError, setLayoutSuggestionError] = useState<string | null>(null)

  async function handleSuggestLayout(layoutBrief: string) {
    if (!input.rootDir) {
      setLayoutSuggestionError('The repository snapshot is not available yet.')
      return
    }

    const trimmedBrief = layoutBrief.trim()

    if (!trimmedBrief) {
      setLayoutSuggestionError('Enter a layout brief first.')
      return
    }

    setLayoutSuggestionPending(true)
    setLayoutSuggestionError(null)

    try {
      const result = await postLayoutSuggestion({
        prompt: trimmedBrief,
      })
      const nextDraft = result.draft

      await input.refreshLayoutState()
      input.onSuggestionApplied(nextDraft.id)
      input.onError(null)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to generate a layout draft.'
      setLayoutSuggestionError(message)
    } finally {
      setLayoutSuggestionPending(false)
    }
  }

  async function handleAcceptDraft(draftId: string) {
    setLayoutActionPending(true)

    try {
      const result = await mutateDraft(draftId, 'accept')

      await input.refreshLayoutState()
      input.onAcceptApplied(result.layout?.id ?? null)
      input.onError(null)
    } catch (error) {
      input.onError(
        error instanceof Error ? error.message : 'Failed to accept layout draft.',
      )
    } finally {
      setLayoutActionPending(false)
    }
  }

  async function handleRejectDraft(draftId: string) {
    setLayoutActionPending(true)

    try {
      await mutateDraft(draftId, 'reject')

      await input.refreshLayoutState()

      if (input.activeDraftId === draftId) {
        input.onRejectApplied(draftId)
      }

      input.onError(null)
    } catch (error) {
      input.onError(
        error instanceof Error ? error.message : 'Failed to reject layout draft.',
      )
    } finally {
      setLayoutActionPending(false)
    }
  }

  return {
    layoutActionPending,
    layoutSuggestionPending,
    layoutSuggestionError,
    handleAcceptDraft,
    handleRejectDraft,
    handleSuggestLayout,
  }
}
