#!/usr/bin/env node

import { runCli } from '../dist/cli/index.js'

void runCli().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Failed to start Semanticode.'}\n`,
  )
  process.exit(1)
})
