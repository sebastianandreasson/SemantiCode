import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { GitWorkspaceStatus } from '../preprocessing/types'

const execFileAsync = promisify(execFile)

export async function getGitWorkspaceStatus(
  rootDir: string,
): Promise<GitWorkspaceStatus> {
  try {
    const [{ stdout: isInsideWorkTree }, { stdout: head }, { stdout: branch }, { stdout: status }] =
      await Promise.all([
        execGit(rootDir, ['rev-parse', '--is-inside-work-tree']),
        execGit(rootDir, ['rev-parse', 'HEAD']),
        execGit(rootDir, ['branch', '--show-current']),
        execGit(rootDir, ['status', '--porcelain=v1', '--untracked-files=all']),
      ])

    if (isInsideWorkTree.trim() !== 'true') {
      return createEmptyGitWorkspaceStatus()
    }

    const parsedStatus = parseGitStatus(status)

    return {
      isGitRepo: true,
      branch: branch.trim() || null,
      head: head.trim() || null,
      changedFiles: [...parsedStatus.changedFiles].sort(),
      stagedFiles: [...parsedStatus.stagedFiles].sort(),
      unstagedFiles: [...parsedStatus.unstagedFiles].sort(),
      untrackedFiles: [...parsedStatus.untrackedFiles].sort(),
    }
  } catch {
    return createEmptyGitWorkspaceStatus()
  }
}

async function execGit(rootDir: string, args: string[]) {
  return execFileAsync('git', args, {
    cwd: rootDir,
    maxBuffer: 10 * 1024 * 1024,
  })
}

function parseGitStatus(stdout: string) {
  const changedFiles = new Set<string>()
  const stagedFiles = new Set<string>()
  const unstagedFiles = new Set<string>()
  const untrackedFiles = new Set<string>()

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd()

    if (!line) {
      continue
    }

    const x = line[0] ?? ' '
    const y = line[1] ?? ' '
    const pathPart = line.slice(3)
    const paths = parseStatusPaths(pathPart)

    for (const path of paths) {
      changedFiles.add(path)

      if (x === '?' && y === '?') {
        untrackedFiles.add(path)
        continue
      }

      if (x !== ' ') {
        stagedFiles.add(path)
      }

      if (y !== ' ') {
        unstagedFiles.add(path)
      }
    }
  }

  return {
    changedFiles,
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
  }
}

function parseStatusPaths(pathPart: string) {
  if (!pathPart.includes(' -> ')) {
    return [normalizePath(pathPart)]
  }

  const [fromPath, toPath] = pathPart.split(' -> ')
  return [normalizePath(fromPath), normalizePath(toPath)]
}

function normalizePath(path: string) {
  return path.replace(/\\/g, '/')
}

function createEmptyGitWorkspaceStatus(): GitWorkspaceStatus {
  return {
    isGitRepo: false,
    branch: null,
    head: null,
    changedFiles: [],
    stagedFiles: [],
    unstagedFiles: [],
    untrackedFiles: [],
  }
}
