import type { ProjectPlugin } from '../../schema/projectPlugin'

import { createReactProjectPlugin } from './react'

const BUILT_IN_PROJECT_PLUGIN_FACTORIES = [createReactProjectPlugin]

export function createBuiltInProjectPlugins(): ProjectPlugin[] {
  return BUILT_IN_PROJECT_PLUGIN_FACTORIES.map((factory) => factory())
}

export function getBuiltInProjectPluginCacheSignatures() {
  return BUILT_IN_PROJECT_PLUGIN_FACTORIES.map((factory) => {
    const plugin = factory()
    return `${plugin.id}@${plugin.version}`
  })
}
