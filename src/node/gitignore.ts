import { readFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'

import ignore, { type Ignore } from 'ignore'

const ALWAYS_IGNORED_NAMES = new Set(['.git', '.semanticode'])

interface IgnoreContext {
  basePath: string
  matcher: Ignore
}

export interface IgnoreMatcher {
  loadContexts: (
    directoryPath: string,
    parentContexts: IgnoreContext[],
  ) => Promise<IgnoreContext[]>
  isIgnored: (
    relativePath: string,
    isDirectory: boolean,
    contexts: IgnoreContext[],
  ) => boolean
}

export function createIgnoreMatcher(
  rootDir: string,
  ignoredNames: string[] = [],
): IgnoreMatcher {
  return {
    loadContexts: async (directoryPath, parentContexts) => {
      const contexts = [...parentContexts]

      if (directoryPath === rootDir) {
        const rootMatcher = ignore()
        const extraPatterns = ignoredNames.flatMap((name) => [name, `**/${name}`])
        rootMatcher.add(extraPatterns)
        contexts.push({
          basePath: '',
          matcher: rootMatcher,
        })

        const gitInfoExclude = await readIgnoreFile(
          join(rootDir, '.git', 'info', 'exclude'),
        )

        if (gitInfoExclude) {
          const excludeMatcher = ignore()
          excludeMatcher.add(gitInfoExclude)
          contexts.push({
            basePath: '',
            matcher: excludeMatcher,
          })
        }
      }

      const gitignoreContents = await readIgnoreFile(join(directoryPath, '.gitignore'))

      if (!gitignoreContents) {
        return contexts
      }

      const matcher = ignore()
      matcher.add(gitignoreContents)

      contexts.push({
        basePath: normalizePath(relative(rootDir, directoryPath)),
        matcher,
      })

      return contexts
    },
    isIgnored: (relativePath, isDirectory, contexts) => {
      if (ALWAYS_IGNORED_NAMES.has(basename(relativePath))) {
        return true
      }

      let ignored = false

      for (const context of contexts) {
        const localPath = toLocalPath(relativePath, context.basePath)

        if (!localPath) {
          continue
        }

        const matchPath = isDirectory ? ensureTrailingSlash(localPath) : localPath
        const result = context.matcher.test(matchPath)

        if (result.ignored) {
          ignored = true
        }

        if (result.unignored) {
          ignored = false
        }
      }

      return ignored
    },
  }
}

async function readIgnoreFile(path: string) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function toLocalPath(relativePath: string, basePath: string) {
  if (!basePath) {
    return relativePath
  }

  if (relativePath === basePath) {
    return ''
  }

  const prefix = `${basePath}/`

  if (!relativePath.startsWith(prefix)) {
    return null
  }

  return relativePath.slice(prefix.length)
}

function ensureTrailingSlash(pathValue: string) {
  return pathValue.endsWith('/') ? pathValue : `${pathValue}/`
}

function normalizePath(pathValue: string) {
  return pathValue.split('\\').join('/')
}
