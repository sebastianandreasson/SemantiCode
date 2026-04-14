import { resolve } from 'node:path'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import { codebaseVisualizerPlugin } from './src/vite'

export default defineConfig({
  plugins: [
    react(),
    codebaseVisualizerPlugin({
      analyzeCalls: true,
      analyzeImports: true,
      analyzeSymbols: true,
    }),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'node/index': resolve(__dirname, 'src/node/index.ts'),
        vite: resolve(__dirname, 'src/vite.ts'),
      },
      formats: ['es'],
      fileName: (_, entryName) => `${entryName}.js`,
      cssFileName: 'style',
    },
    rollupOptions: {
      external: [
        '@persper/js-callgraph',
        'ignore',
        'react',
        'react-dom',
        'react/jsx-runtime',
        'typescript',
        'vite',
        'node:fs/promises',
        'node:http',
        'node:module',
        'node:os',
        'node:path',
      ],
    },
  },
})
