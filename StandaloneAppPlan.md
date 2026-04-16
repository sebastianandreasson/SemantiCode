# Semanticode Standalone App Plan

## Goal

Turn this repository from a package-first semanticode into a full standalone application:

- a desktop app
- with an integrated code editor
- centered around spatial codebase visualization
- with agent-assisted layout generation as a built-in workflow

The product is no longer "a library you install into a repo".
The product becomes "an app you open and point at a repo".

## Product Definition

The app should feel like:

- part code editor
- part architecture explorer
- part graph debugger
- part agent workspace

The core promise is:

- open a repository
- inspect and edit code normally
- switch into structural, symbolic, and agent-generated spatial views
- move fluidly between source code and architecture-level understanding

The desktop app is the primary product, but the existing `npx` web flow should remain as a secondary host:

- quick demo mode
- lightweight browser runtime
- easy way to preview the app without a full desktop install
- compatibility path while the desktop shell matures

## Primary Product Mode

The new primary mode should be:

1. Desktop application
   The user downloads and launches a native app.

2. Open local folder / workspace
   The app indexes the repo locally.

3. Use built-in editor and visualizer together
   The editor and canvas are two views over the same project state.

Secondary mode should remain:

4. `npx` / browser demo mode
   The user runs `npx semanticode` and gets the same core app in a browser-backed host.

The important product change is not "remove the web mode".
It is "stop designing the whole system around the npm package as the primary identity".

## Recommended Technical Direction

### App Shell

Use a desktop shell, not a browser-only app.

Recommended choice:

- Electron first

Reasoning:

- the current codebase already depends heavily on Node APIs
- the app needs local filesystem access
- the app needs child processes for analyzers like `cargo`, `rust-analyzer`, and future language tools
- native modules like `tree-sitter` are easier to keep working in an Electron/Node environment
- migration from the current CLI/server/runtime is simpler than moving to a browser sandbox or Rust host immediately

Tauri can still be revisited later, but Electron is the pragmatic path for this repo as it exists today.

## Host Strategy

The product should support two hosts over one shared core:

1. Desktop host
   Electron main/preload/renderer.
   This is the primary product.

2. Web demo host
   `npx semanticode` launches the same renderer in a browser with a local workspace backend.
   This is the secondary/demo product.

This means the repo should be organized so that:

- workspace engine is shared
- renderer UI is shared
- only the transport/host layer differs

Recommended abstraction:

- `WorkspaceClient`
  a typed frontend client interface for loading snapshots, layouts, drafts, file contents, and workspace actions

- `HttpWorkspaceClient`
  used by the `npx` web/demo host

- `IpcWorkspaceClient`
  used by the desktop app

## Product Principles

1. Editor and visualizer must share one project model
   The canvas is not a separate toy viewer. It must stay synchronized with open files, symbols, selections, and edits.

2. Local-first by default
   Indexing, parsing, graphing, and layout generation should work without sending source code off-machine.

3. Spatial view is a first-class editor surface
   The graph view should not be a side feature. It should be a normal workspace mode alongside file editing.

4. Agent output must remain structured
   Agents should produce layout plans, analysis summaries, and task suggestions, not arbitrary UI code.

5. Language support is adapter-driven
   The standalone app must treat JS/TS, Rust, Flutter/Dart, and future ecosystems as analyzers plugged into one shared model.

## User Experience

### Core workspace

The app should have four major regions:

1. Workspace / project switcher
   Open folder, recent projects, indexing status, analysis settings.

2. Editor area
   Normal file tabs, code editor, find/search, symbol navigation, diagnostics later.

3. Visual canvas
   React Flow-based spatial view of files, symbols, clusters, call graph neighborhoods, and custom layouts.

4. Agent / layout panel
   Prompt input, saved drafts, accept/reject flow, layout history, rationale, warnings.

### Core flows

1. Open repo
   App indexes repo, detects languages, restores last workspace state.

2. Edit code
   User edits files in the built-in editor.

3. Observe graph updates
   Symbols/imports/layouts update incrementally.

4. Ask for a layout
   User prompts the built-in agent:
   "put frontend on the left and backend on the right"

5. Review draft
   Draft layout appears in the app with rationale, warnings, and accept/reject controls.

6. Move between graph and code
   Clicking a symbol opens the corresponding file and range in the editor.

## App Architecture

## 1. Desktop Host Layer

Responsibilities:

- native windowing
- app menus
- recent workspaces
- filesystem dialogs
- app updates later
- process lifecycle

Suggested structure:

- Electron main process
- preload bridge
- React renderer process

## 2. Workspace Backend Layer

This should absorb what is currently split across:

- CLI
- local HTTP server
- snapshot reader
- planner persistence
- analyzer execution

Responsibilities:

- open workspace
- scan files
- watch file changes
- run language adapters
- run external analyzers
- persist app state under `.semanticode/`
- expose a typed internal API to the renderer

This should become a reusable workspace service with multiple transports.

Recommended shift:

- extract the current backend into a workspace service layer
- keep current API shapes where useful
- expose that service over IPC in the desktop host
- expose that service over HTTP in the `npx` demo host

## 3. Shared Project Model

Keep the current snapshot/layout model as the center of the system.

It should evolve into:

- project snapshot
- language analysis artifacts
- saved layouts
- draft layouts
- editor state
- diagnostics
- search index
- workspace preferences

New shared concepts needed for editor mode:

- open editors
- active file
- active symbol
- cursor position
- selection ranges
- unsaved changes
- dirty file state

## 4. Editor Layer

Add a real code editor surface.

Recommended first choice:

- Monaco Editor

Reasoning:

- mature
- good TypeScript support out of the box
- fits Electron well
- makes it easier to behave like an actual code editor quickly

Responsibilities:

- open file tabs
- syntax highlighting
- go to definition later
- range highlighting from graph selection
- split views later
- search in file
- unsaved edits

The editor does not need to compete with full IDEs in v1.
It needs to be good enough that the app can be used as a serious exploration and light-editing environment.

## 5. Visualization Layer

Keep React Flow for the graph/canvas surface.

Responsibilities:

- filesystem view
- symbol-only view
- call graph overlays
- grouped private helper clusters
- custom saved layouts
- agent-generated layouts
- synchronized selection with the editor

New requirements as part of a full app:

- graph selection opens file/range in editor
- editor cursor can reveal corresponding graph node
- unsaved file changes can trigger soft graph invalidation/rebuild

## 6. Agent Layer

The agent becomes a built-in app subsystem, not a helper prompt the CLI prints.

Responsibilities:

- accept natural-language layout instructions
- consume planner context
- return draft layouts
- explain rationale
- surface ambiguities
- optionally propose analysis tasks later

The current planner contract remains valid and should be preserved.

The main change is UX:

- prompt input lives inside the app
- draft handling is fully built in
- no copy/paste to external coding agents required for the common case

## 7. Persistence Layer

Workspace-local state should still live in:

- `.semanticode/`

This should store:

- saved layouts
- draft layouts
- analysis cache
- graph cache
- workspace settings
- recent prompt history for that repo

App-global state should live separately:

- recent workspaces
- window state
- theme
- global preferences

## Feature Scope For The Standalone App

### V1 Must Have

- open local repo
- file tree
- integrated code editor
- filesystem and symbol views
- JS/TS analysis
- Rust structural analysis
- saved layouts
- agent-generated draft layouts
- accept/reject workflow
- live graph/editor synchronization

### V1 Nice To Have

- tabbed editor
- project-wide search
- incremental reindexing
- rust-analyzer-powered Rust call edges when available
- lightweight diagnostics panel

### V1 Not Required

- git UI
- debugger
- terminal emulator
- plugin marketplace
- collaborative editing
- cloud sync
- full LSP parity with VS Code

## Migration Strategy

Do not rewrite the repo from scratch.
Refactor it into app-centric layers.

### Keep

- snapshot schemas
- layout schemas
- planner schemas
- language adapter system
- JS/TS analysis
- Rust structural analysis
- React Flow canvas
- Zustand store concepts
- layout persistence model

### Downgrade From Primary To Secondary

- npm package export surface
- Vite plugin mode
- CLI-first architecture
- HTTP-first local API for core app runtime
- browser-hosted runtime as the primary identity

### Add

- Electron host
- IPC bridge
- workspace service layer
- Monaco editor integration
- workspace/session persistence
- integrated agent panel

### Keep Explicitly Alive

- `npx semanticode` as a secondary demo/runtime host
- shared web renderer that can run in both browser and desktop contexts
- HTTP workspace transport for the demo host

## Proposed Repository Shape

One reasonable target structure:

```text
src/
  app/
    renderer/
      components/
      screens/
      editor/
      canvas/
      agent/
      store/
    main/
      electron/
      windows/
      menus/
    preload/
      bridge.ts
  workspace/
    snapshot/
    analysis/
    adapters/
    planner/
    persistence/
    watcher/
  shared/
    schema/
    types/
```

The important point is:

- app shell code
- workspace backend code
- shared schemas

should be clearly separated.

## Implementation Phases

## Phase 1: Reframe The Repo Around A Desktop App

Tasks:

- choose Electron as the host
- add Electron main/preload/renderer scaffolding
- keep current React app as the renderer seed
- launch the existing UI inside Electron
- introduce a shared renderer entry that can run in both Electron and browser hosts
- open a workspace path from the app instead of relying only on the CLI

Done means:

- app launches as a desktop window
- user can open a repo folder
- current visualizer works in the app
- `npx` mode still works against the same renderer

## Phase 2: Move From HTTP Runtime To Workspace Service

Tasks:

- extract current server logic into a workspace service module
- expose typed IPC methods for the desktop host
- keep an HTTP transport for the `npx` demo host
- make the renderer depend on a `WorkspaceClient` abstraction instead of directly on fetch

Done means:

- renderer can run unchanged against either IPC or HTTP
- desktop mode no longer depends on HTTP routes internally
- `npx` mode still works through the HTTP transport

## Phase 3: Add The Built-In Editor

Tasks:

- integrate Monaco
- add file tabs and open-file state
- load file contents from the workspace service
- support graph-to-editor navigation
- support editor-to-graph reveal

Done means:

- app is usable as a lightweight code editor plus visualizer

## Phase 4: Add Live Workspace Synchronization

Tasks:

- file watching
- incremental snapshot invalidation
- debounce rebuilds
- preserve viewport and layout while analysis refreshes
- track dirty files and reconcile saved vs unsaved editor state

Done means:

- edits propagate into the graph without destabilizing the workspace

## Phase 5: Bring Agent Workflows In-App

Tasks:

- add prompt UI
- run planner through the built-in planner contract
- show drafts in-app
- accept/reject in-app
- keep structured rationale and warnings visible

Done means:

- no external prompt-copy flow is required for normal use

## Phase 6: Deepen Editor-Like Capabilities

Tasks:

- project search
- symbol search
- diagnostics
- basic go-to-definition where supported
- better call graph expansion

Done means:

- app becomes credible as a daily architecture/debugging companion

## Key Risks

1. Trying to compete with full IDEs too early
   The app should focus on architecture + visualization + light editing first.

2. Mixing app shell and analysis code too tightly
   Keep the workspace backend reusable and testable.

3. Overfitting the UI to JS/TS assumptions
   Preserve the adapter model from the start.

4. Rebuilding graphs too aggressively on every edit
   Incremental invalidation matters once this becomes a real editor.

5. Letting agent workflows bypass structured validation
   Keep the planner contract strict.

## Recommended Immediate Next Steps

1. Write an `AppImplementationPlan.md` that breaks this into concrete chunks.
2. Add Electron scaffolding without deleting the current standalone web path yet.
3. Extract the current HTTP request handlers into a workspace service interface.
4. Make the renderer consume a typed workspace client abstraction so it can run over IPC now and HTTP only as fallback.

## Bottom Line

The right reframing is:

- this repo should become a desktop application with an internal workspace engine
- while keeping the `npx` browser flow as a secondary demo/runtime host

The current code is already a strong foundation for that shift because:

- the schema layer exists
- the visualizer exists
- the planner exists
- the language adapter direction exists

What is missing is the host product shape:

- app shell
- editor
- in-app agent workflow
- IPC-backed workspace runtime
- a clean shared host boundary so browser and desktop runtimes can coexist
