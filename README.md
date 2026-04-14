# codebase-visualizer

Scaffold for a publishable npm package that exposes:

- A React component for rendering a codebase tree and file preview.
- A Node API for reading the project folder the package is running in.
- A Vite plugin that exposes the current workspace as JSON to a frontend.
- A standalone CLI you can run with `npx`.

## Run It Directly

```bash
npx codebase-visualizer .
```

Optional flags:

```bash
npx codebase-visualizer . --port 3210 --host 127.0.0.1
```

This starts a local web app and visualizes the target repository directory.
It also writes `.codebase-visualizer/INSTRUCTIONS.md` into the target repo and prints a ready-to-paste prompt you can hand to a coding agent for custom layouts.

Current language support:

- TypeScript / JavaScript: files, symbols, imports, and call graph overlays.
- Rust: Cargo workspace and target discovery, Rust symbol extraction, containment edges, first-pass `use` / `mod` dependency edges, and optional call edges via `rust-analyzer` when it is installed.

## Package surface

```ts
import { CodebaseVisualizer } from 'codebase-visualizer'
import { readProjectSnapshot } from 'codebase-visualizer/node'
import { codebaseVisualizerPlugin } from 'codebase-visualizer/vite'
```

## Local development

```bash
npm install
npm run dev
```

The demo app uses the Vite plugin endpoint to read this repository and render it in the browser.

## Build

```bash
npm run build
```

This emits the library bundles, standalone app assets, and type declarations into `dist/`.
