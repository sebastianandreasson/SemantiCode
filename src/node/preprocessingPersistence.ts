import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { PreprocessedWorkspaceContext } from '../preprocessing/types'
import type { SemanticPurposeSummaryRecord } from '../semantic/types'

const PREPROCESSED_DIRECTORY = '.semanticode/preprocessed'
const PREPROCESSED_CONTEXT_FILE = 'workspace-context.json'

export async function readPersistedPreprocessedWorkspaceContext(rootDir: string) {
  try {
    const raw = await readFile(getPreprocessedContextPath(rootDir), 'utf8')
    const parsed = JSON.parse(raw) as PreprocessedWorkspaceContext

    if (
      !parsed ||
      typeof parsed.snapshotId !== 'string' ||
      !parsed.workspaceProfile ||
      !Array.isArray(parsed.purposeSummaries)
    ) {
      return null
    }

    return {
      ...parsed,
      isComplete: parsed.isComplete !== false,
      semanticEmbeddingModelId:
        typeof parsed.semanticEmbeddingModelId === 'string'
          ? parsed.semanticEmbeddingModelId
          : null,
      semanticEmbeddings: Array.isArray(parsed.semanticEmbeddings)
        ? parsed.semanticEmbeddings
        : [],
      purposeSummaries: parsed.purposeSummaries.map(normalizePurposeSummaryRecord),
    }
  } catch {
    return null
  }
}

export async function writePersistedPreprocessedWorkspaceContext(
  rootDir: string,
  context: PreprocessedWorkspaceContext,
) {
  const path = getPreprocessedContextPath(rootDir)

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(context, null, 2), 'utf8')
}

function getPreprocessedContextPath(rootDir: string) {
  return join(rootDir, PREPROCESSED_DIRECTORY, PREPROCESSED_CONTEXT_FILE)
}

function normalizePurposeSummaryRecord(
  summary: SemanticPurposeSummaryRecord,
): SemanticPurposeSummaryRecord {
  return {
    ...summary,
    generator: summary.generator === 'llm' ? 'llm' : 'heuristic',
  }
}
