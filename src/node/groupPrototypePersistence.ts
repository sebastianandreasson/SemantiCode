import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { GroupPrototypeCacheSnapshot } from '../semantic/types'

const PREPROCESSED_DIRECTORY = '.semanticode/preprocessed'
const GROUP_PROTOTYPE_FILE = 'group-prototypes.json'

export async function readPersistedGroupPrototypeCache(rootDir: string) {
  try {
    const raw = await readFile(getGroupPrototypeCachePath(rootDir), 'utf8')
    const parsed = JSON.parse(raw) as GroupPrototypeCacheSnapshot

    if (!parsed || !Array.isArray(parsed.records)) {
      return null
    }

    return {
      records: parsed.records.filter(isValidGroupPrototypeRecord),
      updatedAt:
        typeof parsed.updatedAt === 'string'
          ? parsed.updatedAt
          : new Date(0).toISOString(),
    } satisfies GroupPrototypeCacheSnapshot
  } catch {
    return null
  }
}

export async function writePersistedGroupPrototypeCache(
  rootDir: string,
  snapshot: GroupPrototypeCacheSnapshot,
) {
  const path = getGroupPrototypeCachePath(rootDir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(snapshot, null, 2), 'utf8')
}

function getGroupPrototypeCachePath(rootDir: string) {
  return join(rootDir, PREPROCESSED_DIRECTORY, GROUP_PROTOTYPE_FILE)
}

function isValidGroupPrototypeRecord(record: unknown): record is GroupPrototypeCacheSnapshot['records'][number] {
  if (!record || typeof record !== 'object') {
    return false
  }

  const candidate = record as Record<string, unknown>

  return (
    typeof candidate.layoutId === 'string' &&
    typeof candidate.groupId === 'string' &&
    typeof candidate.groupTitle === 'string' &&
    typeof candidate.inputHash === 'string' &&
    Array.isArray(candidate.memberNodeIds) &&
    Array.isArray(candidate.usableMemberNodeIds) &&
    typeof candidate.usableMemberCount === 'number' &&
    typeof candidate.modelId === 'string' &&
    typeof candidate.dimensions === 'number' &&
    Array.isArray(candidate.values) &&
    typeof candidate.generatedAt === 'string'
  )
}
