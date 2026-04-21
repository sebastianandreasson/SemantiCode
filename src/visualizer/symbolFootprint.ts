import type { LayoutSpec } from '../schema/layout'
import {
  isFileNode,
  type ProjectNode,
  type ProjectSnapshot,
  type SymbolNode,
} from '../schema/snapshot'

export interface SymbolFootprint {
  width: number
  height: number
  scale: number
  contentScale: number
  compact: boolean
}

export interface SymbolFootprintLookupOptions {
  contained?: boolean
  containedPlacement?: {
    width: number
    height: number
  }
  extraMetaLabels?: string[]
}

export interface SymbolFootprintLookupInput {
  layout: LayoutSpec
  snapshot: ProjectSnapshot
  viewportZoom?: number
  onCompute?: (symbolId: string, cacheKey: string) => void
}

export interface SymbolFootprintLookup {
  get: (
    symbolId: string,
    options?: SymbolFootprintLookupOptions,
  ) => SymbolFootprint | null
  getComputedCount: () => number
}

export const DEFAULT_SYMBOL_FOOTPRINT_WIDTH = 240
export const DEFAULT_SYMBOL_FOOTPRINT_HEIGHT = 108

const COMPACT_SYMBOL_NODE_WIDTH = 164
const COMPACT_SYMBOL_NODE_HEIGHT = 74
const LOC_SCALED_SYMBOL_MIN_WIDTH = 176
const LOC_SCALED_SYMBOL_MAX_WIDTH = 1_620
const LOC_SCALED_SYMBOL_MIN_HEIGHT = 64
const LOC_SCALED_SYMBOL_MAX_HEIGHT = 1_080

export function createSymbolFootprintLookup({
  layout,
  onCompute,
  snapshot,
  viewportZoom = 1,
}: SymbolFootprintLookupInput): SymbolFootprintLookup {
  const cache = new Map<string, SymbolFootprint>()
  let computedCount = 0

  return {
    get(symbolId, options = {}) {
      const node = snapshot.nodes[symbolId]

      if (!node || node.kind !== 'symbol') {
        return null
      }

      const placement = layout.placements[symbolId]
      const cacheKey = getSymbolFootprintCacheKey(
        symbolId,
        placement,
        viewportZoom,
        options,
      )
      const cachedFootprint = cache.get(cacheKey)

      if (cachedFootprint) {
        return cachedFootprint
      }

      const footprint = getSymbolNodeFootprint(
        node,
        placement,
        {
          ...options,
          contained: Boolean(options.contained),
        },
        viewportZoom,
        snapshot,
      )

      cache.set(cacheKey, footprint)
      computedCount += 1
      onCompute?.(symbolId, cacheKey)
      return footprint
    },
    getComputedCount() {
      return computedCount
    },
  }
}

export function getSymbolNodeFootprint(
  symbol: SymbolNode,
  placement: LayoutSpec['placements'][string] | undefined,
  options: SymbolFootprintLookupOptions = {},
  viewportZoom = 1,
  snapshot?: ProjectSnapshot,
): SymbolFootprint {
  if (options.containedPlacement) {
    return {
      width: options.containedPlacement.width,
      height: options.containedPlacement.height,
      scale: 1,
      contentScale: 1,
      compact: options.containedPlacement.width <= COMPACT_SYMBOL_NODE_WIDTH,
    }
  }

  if (symbol.symbolKind === 'constant') {
    const baseWidth = options.contained
      ? COMPACT_SYMBOL_NODE_WIDTH - 12
      : COMPACT_SYMBOL_NODE_WIDTH
    const baseHeight = options.contained
      ? COMPACT_SYMBOL_NODE_HEIGHT - 6
      : COMPACT_SYMBOL_NODE_HEIGHT
    const scaledDimensions = getLocScaledSymbolDimensions(
      symbol,
      baseWidth,
      baseHeight,
      viewportZoom,
      snapshot,
      options,
    )

    return {
      ...scaledDimensions,
      compact: scaledDimensions.scale < 1.12,
    }
  }

  const baseWidth = placement?.width ?? DEFAULT_SYMBOL_FOOTPRINT_WIDTH
  const baseHeight = placement?.height ?? DEFAULT_SYMBOL_FOOTPRINT_HEIGHT

  return {
    ...getLocScaledSymbolDimensions(
      symbol,
      baseWidth,
      baseHeight,
      viewportZoom,
      snapshot,
      options,
    ),
    compact: false,
  }
}

export function getSymbolLoc(symbol: SymbolNode) {
  if (!symbol.range) {
    return null
  }

  return Math.max(1, symbol.range.end.line - symbol.range.start.line + 1)
}

export function getSymbolVisualKindClass(symbol: SymbolNode) {
  if (symbol.facets.includes('api:handler')) {
    return 'endpoint'
  }

  if (symbol.facets.includes('react:hook')) {
    return 'hook'
  }

  if (symbol.facets.includes('react:component')) {
    return 'component'
  }

  switch (symbol.symbolKind) {
    case 'class':
    case 'function':
    case 'constant':
    case 'variable':
    case 'module':
      return symbol.symbolKind
    case 'method':
      return 'function'
    case 'unknown':
    default:
      return 'module'
  }
}

export function getNodeBadgeLabels(
  node: ProjectNode,
  snapshot: ProjectSnapshot,
) {
  const tagLabelById = new Map(snapshot.tags.map((tag) => [tag.id, tag.label]))
  const facetLabelById = new Map(
    snapshot.facetDefinitions.map((facetDefinition) => [
      facetDefinition.id,
      facetDefinition.label,
    ]),
  )
  const facetLabels = node.facets.map(
    (facetId) => facetLabelById.get(facetId) ?? formatFacetLabel(facetId),
  )
  const tagLabels = node.tags.map((tagId) => tagLabelById.get(tagId) ?? tagId)

  return [...facetLabels, ...tagLabels].slice(0, 3)
}

export function formatFacetLabel(facetId: string) {
  const [, rawLabel = facetId] = facetId.split(':')

  return rawLabel
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function getSymbolSubtitle(
  symbol: SymbolNode,
  snapshot: ProjectSnapshot,
) {
  const fileNode = snapshot.nodes[symbol.fileId]
  const filePath =
    fileNode && isFileNode(fileNode) ? fileNode.path : symbol.fileId
  const lineLabel = symbol.range ? `:${symbol.range.start.line}` : ''

  return `${filePath}${lineLabel}`
}

function getSymbolFootprintCacheKey(
  symbolId: string,
  placement: LayoutSpec['placements'][string] | undefined,
  viewportZoom: number,
  options: SymbolFootprintLookupOptions,
) {
  const containedPlacement = options.containedPlacement
  const extraMetaLabels = options.extraMetaLabels?.join('\u001f') ?? ''

  return [
    symbolId,
    placement?.width ?? '',
    placement?.height ?? '',
    options.contained ? 1 : 0,
    containedPlacement?.width ?? '',
    containedPlacement?.height ?? '',
    viewportZoom,
    extraMetaLabels,
  ].join('|')
}

function getLocScaledSymbolDimensions(
  symbol: SymbolNode,
  baseWidth: number,
  baseHeight: number,
  viewportZoom: number,
  snapshot: ProjectSnapshot | undefined,
  options: SymbolFootprintLookupOptions,
) {
  const loc = getSymbolLoc(symbol)

  if (!loc) {
    return {
      width: baseWidth,
      height: baseHeight,
      scale: 1,
      contentScale: 1,
    }
  }

  const logLoc = Math.log10(loc + 1)
  const highLocWeight = clamp((logLoc - 2.1) / 0.9, 0, 1)
  const baseScale = clamp(
    0.72 +
      Math.pow(logLoc, 1.65) * 0.38 +
      Math.pow(highLocWeight, 1.4) * 0.95,
    0.72,
    4.1,
  )
  const scale = getViewportAdjustedSymbolScale(baseScale, viewportZoom)
  const contentScale = getSymbolContentScale(scale, viewportZoom, loc)
  const scaledWidth = baseWidth * scale
  const contentTextWidth = getSymbolContentTextWidth(
    symbol,
    snapshot,
    contentScale,
    options,
  )
  const width = Math.round(
    clamp(
      Math.max(scaledWidth, contentTextWidth),
      LOC_SCALED_SYMBOL_MIN_WIDTH,
      LOC_SCALED_SYMBOL_MAX_WIDTH,
    ),
  )
  const heightScale = Math.max(scale, contentScale * 0.9)
  const contentHeight = getSymbolContentHeight(
    symbol,
    snapshot,
    contentScale,
    width,
    options,
  )
  const importantHeightFloor = getImportantSymbolHeightFloor(width, logLoc)

  return {
    width,
    height: Math.round(
      clamp(
        Math.max(baseHeight * heightScale, contentHeight, importantHeightFloor),
        LOC_SCALED_SYMBOL_MIN_HEIGHT,
        LOC_SCALED_SYMBOL_MAX_HEIGHT,
      ),
    ),
    scale,
    contentScale,
  }
}

function getViewportAdjustedSymbolScale(baseScale: number, viewportZoom: number) {
  const zoom = Number.isFinite(viewportZoom) ? clamp(viewportZoom, 0.1, 4) : 1

  if (zoom < 1) {
    const zoomOutFactor = clamp((1 - zoom) / 0.9, 0, 1)
    return clamp(1 + (baseScale - 1) * (1 + zoomOutFactor * 2.15), 0.56, 7.2)
  }

  const zoomInFactor = clamp(Math.log2(zoom) / 2, 0, 1)

  return clamp(1 + (baseScale - 1) * (1 - zoomInFactor * 0.76), 0.82, 3.2)
}

function getSymbolContentScale(
  nodeScale: number,
  viewportZoom: number,
  loc: number,
) {
  const zoom = Number.isFinite(viewportZoom) ? clamp(viewportZoom, 0.1, 4) : 1

  if (zoom < 1) {
    const readableAtViewportScale = 1 / zoom
    const locWeight = clamp((Math.log10(loc + 1) - 1) / 1.2, 0, 1)
    const locWeightedReadableScale =
      1 + (readableAtViewportScale * 1.08 - 1) * locWeight

    return clamp(
      Math.max(nodeScale * 0.92, locWeightedReadableScale),
      0.72,
      6.2,
    )
  }

  if (nodeScale <= 1) {
    return clamp(nodeScale, 0.78, 1)
  }

  return clamp(1 + (nodeScale - 1) * 0.62, 1, 3.4)
}

function getImportantSymbolHeightFloor(width: number, logLoc: number) {
  const importantLocWeight = clamp((logLoc - 1.45) / 0.85, 0, 1)

  if (importantLocWeight <= 0) {
    return 0
  }

  return width * (0.28 + importantLocWeight * 0.16)
}

function getSymbolContentTextWidth(
  symbol: SymbolNode,
  snapshot: ProjectSnapshot | undefined,
  contentScale: number,
  options: SymbolFootprintLookupOptions,
) {
  const subtitle = snapshot ? getSymbolSubtitle(symbol, snapshot) : symbol.path
  const metaLabels = getSymbolDimensionMetaLabels(symbol, snapshot, options)

  return Math.max(
    getScaledTextWidth(symbol.name, contentScale, 7.8),
    getScaledTextWidth(subtitle, contentScale, 6.25),
    getScaledMetaRowWidth(metaLabels, contentScale),
  )
}

function getScaledTextWidth(
  text: string,
  contentScale: number,
  characterWidth: number,
) {
  const horizontalChrome = 62 * contentScale

  return Math.ceil(text.length * characterWidth * contentScale + horizontalChrome)
}

function getSymbolContentHeight(
  symbol: SymbolNode,
  snapshot: ProjectSnapshot | undefined,
  contentScale: number,
  width: number,
  options: SymbolFootprintLookupOptions,
) {
  const metaLabels = getSymbolDimensionMetaLabels(symbol, snapshot, options)
  const horizontalPadding = 22 * contentScale
  const availableWidth = Math.max(64, width - horizontalPadding)
  const metaRows = getWrappedMetaRowCount(metaLabels, availableWidth, contentScale)
  const metaHeight =
    metaRows > 0
      ? metaRows * 16 * contentScale + (metaRows - 1) * 4 * contentScale
      : 0
  const metaMargin = metaRows > 0 ? 5 * contentScale : 0
  const titleHeight = 11.5 * contentScale * 1.3
  const subtitleHeight = 10 * contentScale * 1.35
  const subtitleMargin = 2 * contentScale
  const verticalPadding = 14 * contentScale
  const safetyPadding = 8 * contentScale
  const runtimeBadgeReserve =
    (options.extraMetaLabels?.length ?? 0) > 0 ? 18 * contentScale : 0

  return Math.ceil(
    verticalPadding +
      metaHeight +
      metaMargin +
      titleHeight +
      subtitleMargin +
      subtitleHeight +
      runtimeBadgeReserve +
      safetyPadding,
  )
}

function getSymbolDimensionMetaLabels(
  symbol: SymbolNode,
  snapshot: ProjectSnapshot | undefined,
  options: SymbolFootprintLookupOptions,
) {
  const tagLabels = snapshot ? getNodeBadgeLabels(symbol, snapshot) : []

  return [
    getSymbolVisualKindClass(symbol),
    ...tagLabels,
    symbol.range ? `${getSymbolLoc(symbol) ?? 0} loc` : null,
    ...(options.extraMetaLabels ?? []),
  ].filter((label): label is string => Boolean(label))
}

function getScaledMetaRowWidth(labels: string[], contentScale: number) {
  if (labels.length === 0) {
    return 0
  }

  const gap = 4 * contentScale
  const horizontalChrome = 28 * contentScale
  const labelsWidth = labels.reduce(
    (width, label) => width + label.length * 6.1 * contentScale + 12 * contentScale,
    0,
  )

  return Math.ceil(labelsWidth + gap * Math.max(0, labels.length - 1) + horizontalChrome)
}

function getWrappedMetaRowCount(
  labels: string[],
  availableWidth: number,
  contentScale: number,
) {
  if (labels.length === 0) {
    return 0
  }

  let rows = 1
  let rowWidth = 0
  const gap = 4 * contentScale

  for (const label of labels) {
    const chipWidth = label.length * 6.1 * contentScale + 12 * contentScale
    const nextWidth = rowWidth === 0 ? chipWidth : rowWidth + gap + chipWidth

    if (rowWidth > 0 && nextWidth > availableWidth) {
      rows += 1
      rowWidth = chipWidth
      continue
    }

    rowWidth = nextWidth
  }

  return rows
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
