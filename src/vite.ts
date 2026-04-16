import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Plugin } from 'vite'

import type { ReadProjectSnapshotOptions } from './types'
import { handleSemanticodeRequest } from './node/http'
import { SEMANTICODE_ROUTE } from './shared/constants'

export interface SemanticodeViteOptions
  extends ReadProjectSnapshotOptions {
  route?: string
}

export function semanticodePlugin(
  options: SemanticodeViteOptions = {},
): Plugin {
  const route = options.route ?? SEMANTICODE_ROUTE

  return {
    name: 'semanticode',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void handleSemanticodeMiddleware(
          request,
          response,
          next,
          options.rootDir ?? server.config.root,
          route,
          options,
        )
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        void handleSemanticodeMiddleware(
          request,
          response,
          next,
          options.rootDir ?? server.config.root,
          route,
          options,
        )
      })
    },
  }
}

async function handleSemanticodeMiddleware(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  next: () => void,
  rootDir: string,
  route: string,
  options: SemanticodeViteOptions,
) {
  const handled = await handleSemanticodeRequest(request, response, {
    ...options,
    rootDir,
    route,
  })

  if (!handled) {
    next()
  }
}
