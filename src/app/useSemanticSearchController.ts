import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  fetchGroupPrototypeCache,
  persistGroupPrototypeCache,
  requestSemanticEmbeddings,
} from './apiClient'
import {
  filterSemanticSearchMatches,
  filterSearchableSemanticEmbeddings,
  rankSemanticSearchMatches,
  type SemanticSearchMatch,
  type SemanticSearchResult,
} from '../semantic/semanticSearch'
import {
  buildGroupPrototypeRecords,
  mergeGroupPrototypeRecords,
  rankGroupPrototypeMatches,
  type GroupPrototypeSearchMatch,
} from '../semantic/groups/groupPrototypes'
import { hashSemanticText, type GroupPrototypeCacheSnapshot } from '../types'
import type {
  PreprocessedWorkspaceContext,
  VisualizerViewMode,
} from '../types'
import type { ResolvedCanvasScene } from '../visualizer/canvasScene'
import {
  areGroupPrototypeCachesEquivalent,
  getLayoutGroupNodeId,
} from '../visualizer/flowModel'

export type SemanticSearchMode = 'symbols' | 'groups'

const SEMANTIC_SEARCH_RESULT_LIMIT = 24
const SEMANTIC_SEARCH_MIN_QUERY_LENGTH = 2
const SEMANTIC_SEARCH_MAX_LIMIT = 60
const SEMANTIC_SEARCH_DEFAULT_STRICTNESS = 35

interface UseSemanticSearchControllerOptions {
  preprocessedWorkspaceContext: PreprocessedWorkspaceContext | null
  resolvedScene: ResolvedCanvasScene | null
  rootDir: string | null | undefined
  viewMode: VisualizerViewMode
}

export function useSemanticSearchController({
  preprocessedWorkspaceContext,
  resolvedScene,
  rootDir,
  viewMode,
}: UseSemanticSearchControllerOptions) {
  const [semanticSearchQuery, setSemanticSearchQuery] = useState('')
  const [semanticSearchMode, setSemanticSearchMode] = useState<SemanticSearchMode>('symbols')
  const [semanticSearchPending, setSemanticSearchPending] = useState(false)
  const [semanticSearchError, setSemanticSearchError] = useState<string | null>(null)
  const [semanticSearchRankedMatches, setSemanticSearchRankedMatches] = useState<SemanticSearchResult[]>(
    [],
  )
  const [groupPrototypeCache, setGroupPrototypeCache] = useState<GroupPrototypeCacheSnapshot | null>(
    null,
  )
  const [groupPrototypeCacheLoaded, setGroupPrototypeCacheLoaded] = useState(false)
  const [semanticSearchMatchLimit, setSemanticSearchMatchLimit] = useState(
    SEMANTIC_SEARCH_RESULT_LIMIT,
  )
  const [semanticSearchStrictness, setSemanticSearchStrictness] = useState(
    SEMANTIC_SEARCH_DEFAULT_STRICTNESS,
  )
  const semanticSearchCacheRef = useRef(new Map<string, SemanticSearchResult[]>())

  useEffect(() => {
    let cancelled = false

    setGroupPrototypeCacheLoaded(false)

    if (!rootDir) {
      setGroupPrototypeCache(null)
      setGroupPrototypeCacheLoaded(true)
      return
    }

    void fetchGroupPrototypeCache()
      .then((cache) => {
        if (!cancelled) {
          setGroupPrototypeCache(cache)
          setGroupPrototypeCacheLoaded(true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGroupPrototypeCache(null)
          setGroupPrototypeCacheLoaded(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [rootDir])

  const semanticSearchEmbeddings = useMemo(() => {
    const visibleSymbolIds = new Set(
      Object.keys(resolvedScene?.layoutSpec.placements ?? {}).filter((nodeId) => {
        return !resolvedScene?.layoutSpec.hiddenNodeIds.includes(nodeId)
      }),
    )

    return filterSearchableSemanticEmbeddings(
      preprocessedWorkspaceContext?.semanticEmbeddings ?? [],
      visibleSymbolIds,
    )
  }, [preprocessedWorkspaceContext?.semanticEmbeddings, resolvedScene])
  const semanticSearchAvailable =
    viewMode === 'symbols' && semanticSearchEmbeddings.length > 0
  const semanticSearchModelId = semanticSearchEmbeddings[0]?.modelId ?? null
  const semanticSearchGroupSourceLayout = useMemo(() => {
    const layoutSpec = resolvedScene?.layoutSpec ?? null

    if (!layoutSpec || layoutSpec.strategy !== 'agent' || layoutSpec.groups.length === 0) {
      return null
    }

    return layoutSpec
  }, [resolvedScene])
  const semanticSearchCachedGroupPrototypes = useMemo(() => {
    if (!semanticSearchGroupSourceLayout || !groupPrototypeCache?.records.length) {
      return []
    }

    return groupPrototypeCache.records.filter(
      (record) => record.layoutId === semanticSearchGroupSourceLayout.id,
    )
  }, [groupPrototypeCache, semanticSearchGroupSourceLayout])
  const semanticSearchGroupPrototypes = useMemo(
    () =>
      buildGroupPrototypeRecords(
        semanticSearchGroupSourceLayout,
        semanticSearchEmbeddings,
        semanticSearchCachedGroupPrototypes,
      ),
    [
      semanticSearchCachedGroupPrototypes,
      semanticSearchEmbeddings,
      semanticSearchGroupSourceLayout,
    ],
  )
  const semanticGroupSearchAvailable =
    semanticSearchAvailable && semanticSearchGroupPrototypes.length > 0
  const semanticSearchMatches = useMemo(
    () =>
      filterSemanticSearchMatches(semanticSearchRankedMatches, {
        limit: semanticSearchMatchLimit,
        strictness: semanticSearchStrictness,
      }),
    [semanticSearchMatchLimit, semanticSearchRankedMatches, semanticSearchStrictness],
  )
  const semanticSearchMatchNodeIds = useMemo(
    () => {
      const nodeIds = new Set<string>()

      for (const match of semanticSearchMatches) {
        if (semanticSearchMode === 'groups') {
          const groupMatch = match as Partial<GroupPrototypeSearchMatch>

          if (!groupMatch.groupId || !Array.isArray(groupMatch.memberNodeIds)) {
            continue
          }

          nodeIds.add(getLayoutGroupNodeId(groupMatch.groupId))
          for (const nodeId of groupMatch.memberNodeIds) {
            nodeIds.add(nodeId)
          }
          continue
        }

        nodeIds.add((match as SemanticSearchMatch).symbolId)
      }

      return nodeIds
    },
    [semanticSearchMatches, semanticSearchMode],
  )
  const handleSemanticSearchModeChange = useCallback((mode: SemanticSearchMode) => {
    setSemanticSearchMode(mode)
    setSemanticSearchRankedMatches([])
    setSemanticSearchError(null)
    setSemanticSearchPending(false)
  }, [])
  const clearSemanticSearch = useCallback(() => {
    setSemanticSearchQuery('')
    setSemanticSearchRankedMatches([])
    setSemanticSearchError(null)
    setSemanticSearchPending(false)
  }, [])
  const semanticSearchHighlightActive =
    semanticSearchAvailable &&
    semanticSearchQuery.trim().length >= SEMANTIC_SEARCH_MIN_QUERY_LENGTH &&
    semanticSearchMatchNodeIds.size > 0

  useEffect(() => {
    semanticSearchCacheRef.current.clear()
  }, [
    rootDir,
    semanticSearchEmbeddings.length,
    semanticSearchGroupPrototypes.length,
    semanticSearchModelId,
  ])

  useEffect(() => {
    if (!semanticSearchGroupSourceLayout || !groupPrototypeCacheLoaded) {
      return
    }

    const nextCache: GroupPrototypeCacheSnapshot = {
      records: mergeGroupPrototypeRecords(
        groupPrototypeCache?.records ?? [],
        semanticSearchGroupPrototypes,
        semanticSearchGroupSourceLayout.id,
      ),
      updatedAt: new Date().toISOString(),
    }

    if (areGroupPrototypeCachesEquivalent(groupPrototypeCache, nextCache)) {
      return
    }

    setGroupPrototypeCache(nextCache)
    void persistGroupPrototypeCache(nextCache).catch(() => {
      // Ignore persistence failures; in-memory cache still works for this session.
    })
  }, [
    groupPrototypeCache,
    groupPrototypeCacheLoaded,
    semanticSearchGroupPrototypes,
    semanticSearchGroupSourceLayout,
  ])

  useEffect(() => {
    if (semanticSearchMode === 'groups' && !semanticGroupSearchAvailable) {
      setSemanticSearchMode('symbols')
    }
  }, [semanticGroupSearchAvailable, semanticSearchMode])

  useEffect(() => {
    if (!semanticSearchAvailable) {
      setSemanticSearchPending((pending) => (pending ? false : pending))
      setSemanticSearchError((error) => (error !== null ? null : error))
      setSemanticSearchRankedMatches((matches) =>
        matches.length > 0 ? [] : matches,
      )
      return
    }

    const trimmedQuery = semanticSearchQuery.trim()

    if (trimmedQuery.length < SEMANTIC_SEARCH_MIN_QUERY_LENGTH) {
      setSemanticSearchPending((pending) => (pending ? false : pending))
      setSemanticSearchError((error) => (error !== null ? null : error))
      setSemanticSearchRankedMatches((matches) =>
        matches.length > 0 ? [] : matches,
      )
      return
    }

    const cacheKey = `${semanticSearchMode}::${semanticSearchGroupSourceLayout?.id ?? 'none'}::${trimmedQuery.toLocaleLowerCase()}::${semanticSearchModelId ?? 'unknown'}`
    const cachedMatches = semanticSearchCacheRef.current.get(cacheKey)

    if (cachedMatches) {
      setSemanticSearchPending(false)
      setSemanticSearchError(null)
      setSemanticSearchRankedMatches(cachedMatches)
      return
    }

    let cancelled = false
    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          setSemanticSearchPending(true)
          setSemanticSearchError(null)
          const [queryEmbedding] = await requestSemanticEmbeddings([
            {
              id: '__semantic_search_query__',
              text: trimmedQuery,
              textHash: hashSemanticText(trimmedQuery),
            },
          ])

          if (cancelled) {
            return
          }

          const nextMatches =
            semanticSearchMode === 'groups'
              ? rankGroupPrototypeMatches({
                  prototypes: semanticSearchGroupPrototypes,
                  queryValues: queryEmbedding?.values ?? [],
                  limit: Math.max(
                    SEMANTIC_SEARCH_MAX_LIMIT,
                    SEMANTIC_SEARCH_RESULT_LIMIT,
                  ),
                })
              : rankSemanticSearchMatches({
                  embeddings: semanticSearchEmbeddings,
                  queryValues: queryEmbedding?.values ?? [],
                  limit: Math.max(
                    SEMANTIC_SEARCH_MAX_LIMIT,
                    SEMANTIC_SEARCH_RESULT_LIMIT,
                  ),
                })

          semanticSearchCacheRef.current.set(cacheKey, nextMatches)
          setSemanticSearchRankedMatches(nextMatches)
        } catch (error) {
          if (cancelled) {
            return
          }

          setSemanticSearchRankedMatches((matches) =>
            matches.length > 0 ? [] : matches,
          )
          setSemanticSearchError(
            error instanceof Error ? error.message : 'Semantic search failed.',
          )
        } finally {
          if (!cancelled) {
            setSemanticSearchPending(false)
          }
        }
      })()
    }, 260)

    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
  }, [
    semanticSearchAvailable,
    semanticSearchEmbeddings,
    semanticSearchGroupPrototypes,
    semanticSearchGroupSourceLayout?.id,
    semanticSearchModelId,
    semanticSearchMode,
    semanticSearchQuery,
  ])

  const semanticSearchStatus = useMemo(() => {
    if (!semanticSearchAvailable) {
      return {
        helper: 'Build embeddings to search the semantic projection.',
        resultCount: 0,
      }
    }

    if (semanticSearchMode === 'groups' && !semanticGroupSearchAvailable) {
      return {
        helper: 'This layout does not expose enough grouped symbols for group search yet.',
        resultCount: 0,
      }
    }

    if (semanticSearchError) {
      return {
        helper: semanticSearchError,
        resultCount: 0,
      }
    }

    if (semanticSearchPending) {
      return {
        helper:
          semanticSearchMode === 'groups'
            ? 'Searching semantic folder matches...'
            : 'Searching semantic matches...',
        resultCount: semanticSearchMatches.length,
      }
    }

    if (semanticSearchQuery.trim().length >= SEMANTIC_SEARCH_MIN_QUERY_LENGTH) {
      return {
        helper:
          semanticSearchMatches.length > 0
            ? semanticSearchMode === 'groups'
              ? `${semanticSearchMatches.length} semantic folder matches highlighted`
              : `${semanticSearchMatches.length} semantic matches highlighted`
            : semanticSearchMode === 'groups'
              ? 'No semantic folder matches found.'
              : 'No semantic matches found.',
        resultCount: semanticSearchMatches.length,
      }
    }

    return {
      helper:
        semanticSearchMode === 'groups'
          ? 'Search by feature intent against grouped symbols.'
          : 'Search by concept, behavior, or feature intent.',
      resultCount: 0,
    }
  }, [
    semanticGroupSearchAvailable,
    semanticSearchAvailable,
    semanticSearchError,
    semanticSearchMatches.length,
    semanticSearchMode,
    semanticSearchPending,
    semanticSearchQuery,
  ])

  return {
    clearSemanticSearch,
    handleSemanticSearchModeChange,
    semanticGroupSearchAvailable,
    semanticSearchAvailable,
    semanticSearchEmbeddings,
    semanticSearchGroupPrototypes,
    semanticSearchHighlightActive,
    semanticSearchMatchLimit,
    semanticSearchMatches,
    semanticSearchMatchNodeIds,
    semanticSearchMode,
    semanticSearchPending,
    semanticSearchQuery,
    semanticSearchStatus,
    semanticSearchStrictness,
    setSemanticSearchMatchLimit,
    setSemanticSearchQuery,
    setSemanticSearchStrictness,
  }
}
