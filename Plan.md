# Semanticode Plan

## Goal

Build `semanticode` as a tool that can be:

- Installed inside an existing repository and run locally against that repo.
- Installed globally and pointed at any repository on disk.

The default experience should behave like a zoomable canvas:

- Show every non-gitignored file.
- Preserve the folder structure as the default layout.
- Let the user click any file and inspect its contents.
- Support pan, zoom, selection, and search in a way that feels closer to Figma than to a file explorer.
- Use React Flow as the canvas/runtime layer for nodes, edges, viewport control, and graph interaction.
- Use Zustand as the frontend state-management layer for viewport, selection, graph-layer toggles, layout state, and inspector state.

The differentiator is a layout engine that can generate alternate views of the same codebase from natural-language instructions, including agent-generated layouts such as:

- "Put all used code to the left and all unused code to the right."
- "Based on our rendering pipeline, place files in columns from input to final frame."

## Product Shape

The product should have three entry modes:

1. Local package mode
   The user installs the package in a repo and runs a local command such as `npx semanticode`.

2. Global CLI mode
   The user installs it globally and runs something like `semanticode /path/to/repo`.

3. Embedded library mode
   A host app imports the React viewer, snapshot reader, and layout APIs directly.

These modes should all reuse the same core pipeline:

- Scan repo into a normalized snapshot.
- Serve snapshot plus layout state through a local server.
- Render the snapshot in the web UI.
- Optionally run an agent-driven layout planner that outputs a new arrangement.

## Core Principles

1. Separate facts from interpretation
   The file graph, contents, imports, symbols, and gitignore results are facts.
   Layouts, clusters, pipelines, and "used vs unused" are interpretations.

2. Make the default useful without AI
   The base product should already be valuable with:
   file tree layout, search, preview, dependency edges, call-graph edges, and navigation.

3. Treat AI output as layout metadata, not direct code execution
   The agent should produce a constrained layout plan, not arbitrary frontend code.

4. Keep all analysis local by default
   The default path should work without sending source code off-machine.
   Remote agent usage should be optional and explicit.

## System Architecture

### 1. Scanner Layer

Responsible for building a codebase snapshot from a target directory.

Inputs:

- Target root path
- `.gitignore` rules
- Optional include/exclude overrides
- Optional file size / file count caps

Outputs:

- File tree
- File contents
- File metadata
- Import/reference graph
- Optional language-aware symbol index

Required work:

- Replace the current hardcoded ignored list with real `.gitignore` parsing.
- Support nested `.gitignore` files.
- Preserve symlink safety and size caps.
- Add language-aware import extraction for the most common ecosystems first:
  TypeScript/JavaScript, JSON, CSS, shaders, and common config formats.

### 2. Snapshot Model

Define a stable internal model the UI and layout engine both consume.

Suggested entities:

- `FileNode`
- `DirectoryNode`
- `Edge`
- `SymbolNode`
- `Tag`
- `Layout`
- `Viewport`
- `Selection`

Suggested edge kinds:

- `contains`
- `imports`
- `calls`
- `references`
- `generated_from`
- `pipeline_step`
- `custom`

This model needs versioning so saved layouts remain compatible as the product evolves.

### 3. Local Server Layer

Provide a small local backend that the web UI talks to.

Responsibilities:

- Read the target repo
- Recompute snapshots
- Watch for file changes
- Serve the frontend
- Expose layout and analysis endpoints
- Cache derived analysis

Recommended shape:

- `semanticode` CLI starts a local web server
- Browser opens to a local app
- App talks to JSON endpoints or a websocket stream

Why this matters:

- A package installed globally still needs safe local file access.
- A browser-only package cannot read arbitrary local repos by itself.
- File watching and layout recomputation belong on the local backend.

### 4. Frontend Canvas Layer

The UI should not be a nested tree widget. It should be a spatial workspace.

Recommended technology choice:

- Use [React Flow](https://reactflow.dev/) as the primary canvas and graph-rendering layer.
- Use [Zustand](https://zustand.docs.pmnd.rs/learn/index) for app state instead of ad hoc React state or prop-drilling.
- Build custom file and folder nodes on top of React Flow rather than building pan/zoom/selection from scratch.
- Use React Flow utilities and connected-node APIs for focus, neighborhood traversal, dependency highlighting, and call-graph inspection.

Default behaviors:

- Pan and zoom canvas
- Render folders as grouped containers
- Render files as cards/nodes
- Click to preview file contents
- Search and focus any file
- Toggle edge overlays
- Show labels and annotations directly on the canvas
- Save and restore viewport
- Optionally switch between file-level and call-graph views

Initial default layout:

- Start with the folder tree
- Directories become frames/groups
- Files become nodes inside their parent frame
- Sort siblings by path and type for stable layout

## Layout Engine

This is the core differentiator.

The layout engine should consume:

- The snapshot
- Derived graph data
- A layout strategy

And produce:

- Node positions
- Groups / lanes / columns
- Labels
- Optional annotations
- Optional hidden/collapsed regions
- Optional file-level and symbol/call-level graph overlays

### Layout Strategy Types

1. Default structural layout
   Pure folder structure, no interpretation.

2. Rule-based layouts
   Deterministic layouts based on code facts.

Examples:

- Used vs unused
- Entry points to leaves
- Call graph neighborhood around a selected symbol or file
- Backend to frontend
- Rendering pipeline
- Test files near implementation
- Build-time vs runtime code

3. Agent-authored layouts
   A prompt is converted into a structured layout plan within a constrained schema.

## Agent-Driven Layouts

This should be designed as a planner, not a code generator.

### Input to the agent

The agent should receive a compressed, structured summary of the repo:

- Directory map
- File list
- Import graph
- Entry points
- File tags
- Optional symbol summaries
- User prompt

It should not need raw full-file contents unless absolutely necessary.

### Output from the agent

The agent should return a strict JSON layout spec, for example:

- layout title
- rationale
- grouping strategy
- lanes / columns / zones
- file-to-zone assignments
- sort order inside each zone
- optional annotations
- optional confidence / unresolved ambiguities

The frontend then renders that spec.

This avoids:

- arbitrary code execution
- frontend instability
- non-reproducible layouts

### Example layout schema

```json
{
  "title": "Rendering Pipeline",
  "strategy": "lane_layout",
  "lanes": [
    { "id": "input", "title": "Input" },
    { "id": "simulation", "title": "Simulation" },
    { "id": "render", "title": "Render" },
    { "id": "postprocess", "title": "Post-process" }
  ],
  "placements": [
    { "path": "src/input/controls.ts", "lane": "input", "order": 10 },
    { "path": "src/render/renderer.ts", "lane": "render", "order": 20 }
  ],
  "notes": [
    "Placed shader setup with render because it feeds frame generation."
  ]
}
```

## Analysis Features Needed For Useful Layouts

The prompt examples imply we need more than raw files.

### Call graph support

Needs:

- Language-aware symbol extraction
- Function or method declarations
- Call-site extraction
- File-to-symbol mapping
- Symbol-to-symbol edges
- Aggregation from symbol graph to file graph when full symbol detail is too dense

Recommended first implementation:

- Use [`@persper/js-callgraph`](https://github.com/Persper/js-callgraph) as the initial static call-graph engine for JavaScript/TypeScript codebases.
- Normalize its output into the internal `SymbolNode` and `calls` edge schema rather than coupling the app directly to its raw JSON format.

Important limitation:

A true call graph is language- and framework-sensitive.
The first implementation should target TypeScript/JavaScript and clearly distinguish between:

- confirmed static calls
- inferred calls
- unresolved dynamic calls

Important implementation note:

`js-callgraph` produces approximate static call graphs, so the UI and planner should treat it as high-value but imperfect structural evidence.

### Used vs unused

Needs:

- Reachability from declared entry points
- Import graph traversal
- Optional dead-file heuristics
- Optional runtime configuration hints

Important limitation:

Unused detection will always be heuristic in dynamic codebases.
The UI should present this as "likely unused" rather than as a fact.

### Pipeline / flow layouts

Needs:

- Import graph
- Tags or summaries for subsystems
- Manual hints from the user
- Optional architecture metadata file

Recommended addition:

Support a repo-local config file such as `semanticode.config.json` where users can define:

- entry points
- important directories
- ignored generated code
- subsystem labels
- pipeline stages

This config will make the agent much more reliable.

Recommended addition:

Support config to declare call-graph roots or important symbols, for example:

- main game loop
- render entry
- server bootstrap
- RPC handlers

## CLI Plan

Add a first-class CLI package surface.

Suggested commands:

- `semanticode`
- `semanticode --root .`
- `semanticode --port 4321`
- `semanticode layout "put tests below implementation"`

Phase 1 CLI responsibilities:

- choose target root
- start local server
- open browser optionally
- print local URL

Phase 2 CLI responsibilities:

- export snapshots
- save named layouts
- import/export layout JSON
- run prompt-to-layout generation
- open call-graph-focused views around a file or symbol

## Storage Model

Need a distinction between source repo state and visualizer state.

Suggested storage:

- ephemeral snapshot cache in `.semanticode/cache`
- saved layouts in `.semanticode/layouts`
- optional project config in `semanticode.config.json`

Saved layouts should be portable and diffable, so use JSON or TOML.

## Security and Privacy

This needs explicit design because the tool reads source code.

Requirements:

- Local-only by default
- No remote uploads without explicit opt-in
- Clear disclosure when an agent prompt would send code summaries externally
- Redaction option for secrets and large generated files
- Respect `.gitignore` and additional ignore rules
- Be explicit when symbol summaries or call-graph summaries are included in planner payloads

If remote AI is supported, include a strict policy for:

- what data is sent
- when it is sent
- how much content is sent
- how the user can inspect the payload

## Follow Agent Rework TODOs

Goal:

- Make follow-agent trustworthy by showing what the agent is reading, writing,
  deleting, renaming, or changing while it works.
- Split the feature into three explicit layers:
  telemetry/file-operation parsing, live event emission, and UI reaction/state.
- Keep request telemetry and git dirty-state checks as fallback signals, not as
  the primary source of truth for live follow behavior.

### 1. Normalize Agent File Operations

- [x] Define a shared `AgentFileOperation` schema with operation kind, paths,
  source, confidence, status, timestamp, session id, tool call id, and tool name.
- [x] Add a pure parser that converts raw tool invocations into normalized file
  operations.
- [x] Classify direct tools such as read, grep, ls, find, edit, write, patch,
  apply, replace, delete, and rename without needing git diff fallback.
- [x] Add conservative shell-command inference for common read/write commands.
- [x] Preserve uncertainty with confidence levels instead of pretending shell
  inference is exact.
- [x] Unit test operation parsing separately from timeline rendering and UI
  follow behavior.

### 2. Emit Live Operation Events

- [x] Emit `file_operation` events from the desktop agent runtime whenever a
  tool starts, updates, or completes.
- [x] Emit operations for both Codex CLI transport events and PI SDK session
  events.
- [x] Keep timeline events for human-readable history, but stop making follow
  behavior depend on timeline rows or request telemetry polling.
- [x] Include operation status so the UI can distinguish in-progress work from
  completed or failed work.
- [x] Keep request telemetry writes as durable history and heatmap input.
- [x] Add tests that assert live agent sessions emit file-operation events next
  to existing tool and timeline events.

### 3. Feed UI Follow From Operations

- [x] Add a UI hook that subscribes to desktop agent events and keeps a bounded
  live buffer of file operations.
- [x] Feed operation-derived read/write events into the follow reducer before
  telemetry and dirty-file fallbacks.
- [x] Make reads drive activity follow and writes/deletes/renames drive edit
  follow.
- [x] Keep dirty-file signals as a reconciliation layer for tools or shell
  commands that cannot be parsed confidently.
- [ ] Surface operation confidence in debug state so suspicious gaps are visible
  during development.
- [ ] Ensure follow remains stable when a file is read, edited, edited again,
  then another file is edited before the first dirty queue entry clears.

### 4. Handle Hard Cases

- [ ] Track new files before the next snapshot refresh and request a refresh
  when the target file is not yet represented in the canvas.
- [ ] Represent delete and rename operations explicitly instead of collapsing
  them into generic edits.
- [ ] Normalize absolute, relative, and workspace-rooted paths to the snapshot
  path format.
- [ ] Capture operation events from multi-path tools and shell commands that
  touch several files.
- [ ] Add a compact operation timeline/debug panel for validating what follow
  thinks happened.
- [ ] Add end-to-end coverage for read-only tool calls, exact edits, shell
  writes, multi-file operations, failed tools, and delayed snapshot refreshes.

## Milestones

### Milestone 1: Solid local foundation

- Proper `.gitignore` support
- Repo scanner with contents and metadata
- Local server
- Canvas UI with folder-based layout
- File preview panel
- Search and selection

Success criteria:

- User can point the tool at a repo and browse every non-ignored file spatially.

### Milestone 2: Structural graph views

- Import graph extraction
- Initial call-graph extraction for TS/JS
- Edge overlays
- Focus mode for incoming/outgoing references
- Focus mode for connected call-graph nodes
- Stable auto-layout improvements

Success criteria:

- User can understand relationships between files and, where available, between calling/called code paths.

### Milestone 3: Saved layouts and rules

- Save named layouts
- Load named layouts
- Deterministic rule-based layouts
- Project config file

Success criteria:

- User can switch between "folder view", "used vs unused", and other repeatable layouts.

### Milestone 4: Agent planner

- Prompt input in UI
- Repo summary builder
- Strict layout schema
- Agent integration
- Layout review / accept flow

Success criteria:

- User can prompt for a custom arrangement and receive a structured, inspectable layout.

### Milestone 5: Advanced code intelligence

- Symbol-level relationships
- Better dead-code inference
- Higher-fidelity call graph
- Architecture summaries
- Domain-specific layout templates

Success criteria:

- Layouts become meaningfully architecture-aware rather than mostly path-aware.

## Immediate Next Steps

1. Turn the current package scaffold into a real CLI-backed local app.
2. Replace naive ignore handling with true `.gitignore` support.
3. Add a watcher-backed local server instead of only the Vite demo route.
4. Refactor the frontend around React Flow with custom file and folder nodes.
5. Introduce a Zustand store architecture before the canvas grows complex.
6. Define the internal snapshot, graph, and layout schemas before building prompt-based layouts.
7. Implement import-graph and call-graph extraction incrementally, starting with TS/JS and `js-callgraph`.
8. Implement one deterministic smart layout first:
   "reachable from entry points" vs "unreachable".
9. Add connected-node graph exploration and call-graph-focused views.
10. Only after that, add the agent planner that maps prompt -> layout JSON.

## Open Questions

These should be resolved early because they change the architecture:

- Is the main product a CLI tool with a bundled web UI, or a library first?
- Should saved layout state live inside the target repo or in a global app directory?
- Do we want remote AI support at all, or only local/model-pluggable support?
- Which ecosystems do we support first for dependency extraction?
- Which ecosystems do we support first for call-graph extraction?
- Do we keep `js-callgraph` as the default TS/JS backend long-term, or only as the first implementation layer?
- How opinionated should the layout schema be about lanes, groups, and annotations?

## Recommended Direction

Treat the product as:

- CLI-first for actual usage
- library-capable for embedding
- local-first for trust
- schema-driven for AI layouts

That path gives the shortest route to a useful product while keeping the "prompt an agent to rearrange the codebase" idea technically controlled and extensible.
