import { resolve } from 'node:path'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import { semanticodePlugin } from './src/vite'

export default defineConfig({
  plugins: [
    react(),
    semanticodePlugin({
      analyzeCalls: true,
      analyzeImports: true,
      analyzeSymbols: true,
    }),
  ],
  build: {
    lib: {
      entry: {
        'desktop/main': resolve(__dirname, 'src/desktop/main.ts'),
        'desktop/preload': resolve(__dirname, 'src/desktop/preload.ts'),
        index: resolve(__dirname, 'src/index.ts'),
        'cli/index': resolve(__dirname, 'src/cli/index.ts'),
        'node/index': resolve(__dirname, 'src/node/index.ts'),
        planner: resolve(__dirname, 'src/planner/index.ts'),
        vite: resolve(__dirname, 'src/vite.ts'),
      },
      formats: ['es'],
      fileName: (_, entryName) => `${entryName}.js`,
      cssFileName: 'style',
    },
    rollupOptions: {
      external: [
        '@mariozechner/pi-agent',
        '@mariozechner/pi-ai',
        '@mariozechner/pi-coding-agent',
        '@persper/js-callgraph',
        'ignore',
        'react',
        'react-dom',
        'react/jsx-runtime',
        'electron',
        'tree-sitter',
        'tree-sitter-rust',
        'typescript',
        'vite',
        'node:crypto',
        'node:child_process',
        'node:fs/promises',
        'node:http',
        'node:module',
        'node:os',
        'node:path',
        'node:url',
        'node:util',
      ],
    },
  },
})
