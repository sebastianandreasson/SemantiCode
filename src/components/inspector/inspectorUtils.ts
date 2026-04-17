import type { LayoutGroup } from '../../types'
import { type CodebaseFile, type ProjectNode, type SymbolNode } from '../../types'

export function getInspectorHeaderSummary(input: {
  selectedLayoutGroup?: LayoutGroup | null
  selectedFile: CodebaseFile | null
  selectedFiles: CodebaseFile[]
  selectedNode: ProjectNode | null
  selectedSymbols: SymbolNode[]
}) {
  if (input.selectedSymbols.length > 1) {
    return {
      eyebrow: 'Symbol selection',
      title: `${input.selectedSymbols.length} symbols selected`,
    }
  }

  if (input.selectedFiles.length > 1) {
    return {
      eyebrow: 'File selection',
      title: `${input.selectedFiles.length} files selected`,
    }
  }

  if (input.selectedLayoutGroup) {
    return {
      eyebrow: 'Custom folder',
      title: input.selectedLayoutGroup.title,
    }
  }

  if (input.selectedNode) {
    return {
      eyebrow: input.selectedNode.path,
      title: input.selectedNode.name,
    }
  }

  if (input.selectedFile) {
    return {
      eyebrow: input.selectedFile.path,
      title: input.selectedFile.name,
    }
  }

  return {
    eyebrow: 'Inspector',
    title: 'Nothing selected',
  }
}
