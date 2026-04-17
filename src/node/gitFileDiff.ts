import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import type { GitFileDiff, GitFileDiffLineChange } from '../types'

const execFileAsync = promisify(execFile)

export async function getGitFileDiff(
  rootDir: string,
  targetPath: string,
): Promise<GitFileDiff | null> {
  const workspacePath = normalizeWorkspaceRelativePath(rootDir, targetPath)

  if (!workspacePath) {
    return null
  }

  try {
    const isInsideWorkTree = await execGit(rootDir, ['rev-parse', '--is-inside-work-tree'])

    if (isInsideWorkTree.stdout.trim() !== 'true') {
      return null
    }

    const status = await execGit(rootDir, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--',
      workspacePath,
    ])
    const isUntracked = status.stdout
      .split(/\r?\n/)
      .some((line) => line.startsWith('?? '))

    if (isUntracked) {
      return buildUntrackedFileDiff(rootDir, workspacePath)
    }

    const diff = await execGit(rootDir, [
      'diff',
      '--no-ext-diff',
      '--no-color',
      '--unified=0',
      'HEAD',
      '--',
      workspacePath,
    ])

    return parseGitFileDiff(workspacePath, diff.stdout)
  } catch {
    return null
  }
}

async function execGit(rootDir: string, args: string[]) {
  return execFileAsync('git', args, {
    cwd: rootDir,
    maxBuffer: 10 * 1024 * 1024,
  })
}

async function buildUntrackedFileDiff(rootDir: string, workspacePath: string): Promise<GitFileDiff> {
  const absolutePath = resolve(rootDir, workspacePath)
  const content = await readFile(absolutePath, 'utf8').catch(() => '')
  const lineCount = content.length > 0 ? content.split(/\r?\n/).length : 0
  const changes: GitFileDiffLineChange[] =
    lineCount > 0
      ? [
          {
            endLine: lineCount,
            kind: 'added',
            startLine: 1,
          },
        ]
      : []

  return {
    addedLineCount: lineCount,
    baseline: 'HEAD',
    changes,
    deletedLineCount: 0,
    hasDiff: lineCount > 0,
    isUntracked: true,
    modifiedLineCount: 0,
    path: workspacePath,
  }
}

function parseGitFileDiff(path: string, diffText: string): GitFileDiff {
  const changes: GitFileDiffLineChange[] = []
  let addedLineCount = 0
  let modifiedLineCount = 0
  let deletedLineCount = 0

  for (const line of diffText.split(/\r?\n/)) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)

    if (!match) {
      continue
    }

    const oldCount = Number.parseInt(match[2] ?? '1', 10)
    const newStart = Number.parseInt(match[3] ?? '0', 10)
    const newCount = Number.parseInt(match[4] ?? '1', 10)

    if (oldCount === 0 && newCount > 0) {
      addedLineCount += newCount
      changes.push({
        endLine: newStart + newCount - 1,
        kind: 'added',
        startLine: newStart,
      })
      continue
    }

    if (oldCount > 0 && newCount === 0) {
      deletedLineCount += oldCount
      continue
    }

    if (oldCount > 0 && newCount > 0) {
      modifiedLineCount += newCount
      changes.push({
        endLine: newStart + newCount - 1,
        kind: 'modified',
        startLine: newStart,
      })
    }
  }

  return {
    addedLineCount,
    baseline: 'HEAD',
    changes,
    deletedLineCount,
    hasDiff: addedLineCount > 0 || modifiedLineCount > 0 || deletedLineCount > 0,
    isUntracked: false,
    modifiedLineCount,
    path,
  }
}

function normalizeWorkspaceRelativePath(rootDir: string, targetPath: string) {
  const normalizedRootDir = resolve(rootDir)
  const absoluteTargetPath = resolve(normalizedRootDir, targetPath)

  if (
    absoluteTargetPath !== normalizedRootDir &&
    !absoluteTargetPath.startsWith(`${normalizedRootDir}${sep}`)
  ) {
    return null
  }

  return relative(normalizedRootDir, absoluteTargetPath).replace(/\\/g, '/')
}
