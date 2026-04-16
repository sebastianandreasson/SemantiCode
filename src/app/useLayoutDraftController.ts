import { useState } from 'react'

import {
  fetchAgentState,
  fetchLayoutState,
  mutateDraft,
  postAgentMessage,
} from './apiClient'
import type { LayoutDraft, LayoutSpec } from '../types'

interface UseLayoutDraftControllerInput {
  activeDraftId: string | null
  draftLayouts: LayoutDraft[]
  rootDir: string | null
  onLayoutStateLoaded: (state: {
    layouts: LayoutSpec[]
    draftLayouts: LayoutDraft[]
  }) => void
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

    const existingDraftIds = new Set(input.draftLayouts.map((draft) => draft.id))

    try {
      await postAgentMessage(
        buildLayoutSuggestionPrompt(input.rootDir, trimmedBrief),
      )

      const nextDraft = await waitForSuggestedLayoutDraft({
        existingDraftIds,
        onLayoutStateLoaded: input.onLayoutStateLoaded,
      })

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

async function waitForSuggestedLayoutDraft(input: {
  existingDraftIds: Set<string>
  onLayoutStateLoaded: (state: {
    layouts: LayoutSpec[]
    draftLayouts: LayoutDraft[]
  }) => void
}) {
  const timeoutAt = Date.now() + 180_000

  while (Date.now() < timeoutAt) {
    const [layoutState, agentState] = await Promise.all([
      fetchLayoutState(),
      fetchAgentState(),
    ])

    input.onLayoutStateLoaded({
      layouts: layoutState.layouts,
      draftLayouts: layoutState.draftLayouts,
    })

    const nextDraft = layoutState.draftLayouts.find(
      (draft) =>
        draft.status === 'draft' &&
        Boolean(draft.layout) &&
        !input.existingDraftIds.has(draft.id),
    )

    if (nextDraft) {
      return nextDraft
    }

    if (agentState.session?.runState === 'error') {
      throw new Error(
        agentState.session.lastError ?? 'The agent failed before saving a layout draft.',
      )
    }

    await delay(1500)
  }

  throw new Error('Timed out waiting for a new layout draft.')
}

function buildLayoutSuggestionPrompt(rootDir: string, layoutBrief: string) {
  const instructionsPath = `${rootDir}/.semanticode/INSTRUCTIONS.md`

  return [
    `Look up "${instructionsPath}" and follow it to construct a new Semanticode layout draft for this repository.`,
    'Use the following layout brief:',
    layoutBrief,
    'Save the result as a draft layout so it appears in Semanticode.',
    'Do not answer with prose in chat. Do the work and stop after the draft has been saved.',
  ].join('\n\n')
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds)
  })
}
