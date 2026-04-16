# semanticode

Scaffold for a publishable npm package that exposes:

- A React component for rendering a codebase tree and file preview.
- A Node API for reading the project folder the package is running in.
- A Vite plugin that exposes the current workspace as JSON to a frontend.
- A standalone CLI you can run with `npx`.

## Run It Directly

```bash
npx semanticode .
```

Optional flags:

```bash
npx semanticode . --port 3210 --host 127.0.0.1
```

This starts a local web app and visualizes the target repository directory.
It also writes `.semanticode/INSTRUCTIONS.md` into the target repo and prints a ready-to-paste prompt you can hand to a coding agent for custom layouts.

## Experimental Desktop Host

```bash
npm install
npm run desktop -- /path/to/repo
```

This launches the same renderer in an Electron window and points it at the selected repository.
If you omit the path, the desktop host now opens to a welcome screen where you can choose a folder yourself.

Current language support:

- TypeScript / JavaScript: files, symbols, imports, and call graph overlays.
- Rust: Cargo workspace and target discovery, Rust symbol extraction, containment edges, first-pass `use` / `mod` dependency edges, and optional call edges via `rust-analyzer` when it is installed.

## Package surface

```ts
import { Semanticode } from 'semanticode'
import { readProjectSnapshot } from 'semanticode/node'
import { semanticodePlugin } from 'semanticode/vite'
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
