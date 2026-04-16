# Semanticode Implementation Plan

## Purpose

This document turns `Plan.md` into an execution sequence.

The goal is to build the product in chunks that are:

- small enough to implement and verify in a few focused sessions
- large enough to produce visible progress
- ordered to reduce rework

## Delivery Strategy

Build the product in this order:

1. Stabilize the package shape and shared data model.
2. Replace the current demo path with a real local app runtime.
3. Build a React Flow-based folder layout viewer.
4. Add structural code intelligence.
5. Add saved deterministic layouts.
6. Add agent-planned layouts on top of a strict schema.

The main rule is:

- do not build prompt-based layouts before the snapshot model, local server, and deterministic layout pipeline are stable

## Chunk 0: Lock The Core Product Decisions

### Scope

Resolve the architecture choices that would otherwise create churn later.

### Tasks

- Confirm the primary product mode is `CLI-first with bundled web UI`.
- Keep the React viewer as an export, but treat embedded-library mode as secondary.
- Decide where project state lives:
  `.semanticode/` inside the target repo is the default.
- Decide whether remote AI is in scope for v1:
  recommended answer is `no`, with a pluggable local/remote provider boundary added later.
- Decide the first supported ecosystems for import analysis:
  TypeScript/JavaScript first.
- Decide the first supported ecosystems for call-graph analysis:
  TypeScript/JavaScript first.
- Confirm React Flow is the chosen graph/canvas runtime for v1.
- Confirm Zustand is the chosen frontend state-management layer for v1.
- Confirm `@persper/js-callgraph` is the first call-graph engine for JS/TS support.

### Deliverables

- Finalized architectural decisions added to `Plan.md` or a short ADR file.
- A short list of v1 non-goals.

### Done Means

- No open product-shape questions remain that affect CLI/server/schema design.

## Chunk 1: Define The Shared Internal Schemas

### Scope

Create the durable data contracts used by scanner, server, UI, layouts, and saved files.

### Tasks

- Replace the current minimal snapshot types with versioned schemas.
- Define:
  `ProjectSnapshot`, `FileNode`, `DirectoryNode`, `SymbolNode`, `Edge`, `Tag`, `LayoutSpec`, `ViewportState`, `SelectionState`.
- Add edge kinds:
  `contains`, `imports`, `calls`, `references`, `generated_from`, `pipeline_step`, `custom`.
- Add optional tags for:
  `entrypoint`, `test`, `config`, `generated`, `asset`, `likely_unused`.
- Define the relationship between:
  file graph, symbol graph, and aggregated layout graph.
- Define a saved layout format that is serializable to JSON.
- Decide which IDs are stable:
  file path should be the primary node identity in v1.

### Recommended Files

- `src/schema/snapshot.ts`
- `src/schema/layout.ts`
- `src/schema/api.ts`
- `src/schema/store.ts`

### Deliverables

- Shared exported types
- A few example JSON fixtures for snapshots and layouts
- Initial store-shape definition for Zustand slices

### Done Means

- Scanner, server, and UI can all compile against the same schema package.

## Chunk 2: Build Real `.gitignore`-Aware Scanning

### Scope

Replace the naive directory walking logic with repo-aware scanning.

### Tasks

- Add `.gitignore` parsing.
- Support nested ignore files.
- Respect common git rules and repo-local ignore behavior.
- Keep file-count and file-size limits.
- Keep symlink safety.
- Track why files were excluded when useful for debugging.
- Add optional include/exclude overrides from CLI/config.

### Recommended Approach

- Use a mature ignore implementation rather than hand-rolling gitignore behavior.
- Separate path filtering from file reading.

### Deliverables

- `readProjectSnapshot()` upgraded to real ignore semantics
- scanner tests covering:
  root ignore, nested ignore, negation, generated folders, large files

### Done Means

- The scanner output matches user expectations for “show me all non-gitignored files.”

## Chunk 3: Add Dependency, Tagging, And Initial Call-Graph Analysis

### Scope

Create the first layer of structural intelligence beyond raw files.

### Tasks

- Parse import/export references for TS/JS files.
- Create `imports` edges between files.
- Integrate `@persper/js-callgraph` for the first JS/TS call-graph pass.
- Add initial symbol extraction for TS/JS:
  top-level functions, methods, exported symbols where feasible.
- Extract static call relationships where feasible.
- Create `calls` edges between symbols and aggregate call relationships back to files.
- Add simple file tagging heuristics:
  tests, config files, generated files, assets, entry points.
- Identify candidate entry points:
  `package.json`, common framework entry files, configurable overrides.
- Store derived graph data in the snapshot or in a cached analysis artifact.

### Non-Goals

- No complete cross-language symbol graph yet
- No full semantic analysis yet
- No perfect dead-code detection yet
- No attempt at a complete dynamic/runtime call graph yet
- No assumption that `js-callgraph` is perfectly precise; treat its output as approximate static analysis

### Deliverables

- Graph extraction module
- adapter layer that converts `js-callgraph` output into internal graph entities
- Snapshot now contains edges, tags, and initial symbol metadata
- Fixtures and tests for basic import-graph and call-edge extraction

### Done Means

- The app can draw relationships between files and basic call relationships for supported languages.
- The system can ingest `js-callgraph` results without leaking tool-specific details into the UI layer.

## Chunk 4: Add A Real CLI Entry Point

### Scope

Turn the package into an actual tool the user can run locally or globally.

### Tasks

- Add a `bin` entry in `package.json`.
- Implement a CLI command such as:
  `semanticode [root]`.
- Support flags:
  `--root`, `--port`, `--host`, `--open`, `--no-open`.
- Make the CLI resolve the target repo path safely.
- Print a clear startup summary:
  root path, URL, index status, watch status.

### Recommended Files

- `src/cli/index.ts`
- `src/cli/args.ts`

### Deliverables

- Local package execution works with `npx`
- Global install execution works with a target path

### Done Means

- A user can install and launch the tool without wiring Vite manually.

## Chunk 5: Replace The Demo Route With A Real Local Server

### Scope

Move from a Vite-only development trick to an actual app runtime.

### Tasks

- Introduce a backend server owned by the CLI process.
- Serve snapshot data over JSON endpoints.
- Add file watching to recompute snapshots incrementally or fully.
- Expose endpoints for:
  current snapshot, analysis status, layout list, active layout, graph neighborhood queries.
- Add websocket or SSE updates for live refresh.
- Decide whether frontend assets are served by Vite in dev and static build output in production.

### Minimum API Surface

- `GET /api/snapshot`
- `GET /api/layouts`
- `POST /api/layouts`
- `GET /api/status`
- `GET /api/graph/neighbors`

### Deliverables

- Local app server running independently of the current Vite plugin hack
- Frontend switched to consume the real API

### Done Means

- CLI launch path is the same in development and in packaged usage.

## Chunk 6: Build The React Flow Canvas Runtime

### Scope

Replace the current split-pane demo with a proper spatial canvas based on React Flow.

### Tasks

- Add React Flow and base graph plumbing.
- Add Zustand store setup for:
  snapshot state, layout state, viewport state, selection state, graph-layer toggles, inspector state.
- Define file-node, directory-node, and annotation-node renderers.
- Add pan and zoom through React Flow viewport APIs.
- Add a viewport state model.
- Render directories as frames/groups.
- Render files as nodes/cards.
- Support edges for imports first, then call-graph edges.
- Preserve stable node positioning for the default structural layout.
- Add minimap or overview later only if needed.
- Keep a side or bottom panel for file preview.

### UI Behaviors

- click file to preview
- click folder to focus
- search file and center it
- reset viewport
- hover edges or node metadata
- click a node and inspect connected nodes
- switch between file graph and call graph when available

### Recommended Constraint

- Do not overbuild node visuals early.
- Get spatial navigation correct before styling polish.
- Use React Flow primitives instead of reinventing selection/viewport/connection behavior.

### Deliverables

- React Flow renderer
- Zustand store with clear slices/selectors
- Viewport state persistence
- Folder-based layout shown spatially, not as a nested tree
- Connected-node focus interactions wired through React Flow graph state

### Done Means

- The default experience already feels like a navigable code map.

## Chunk 7: Implement The Default Structural Layout Engine

### Scope

Create a deterministic layout generator for the folder-based view.

### Tasks

- Define the `LayoutSpec` generator interface.
- Build a layout function that transforms the file tree into positioned nodes.
- Render directories as grouped regions containing child nodes.
- Make sibling ordering deterministic by path/type.
- Ensure layout output is stable between runs when the repo is unchanged.
- Ensure layout output maps cleanly to React Flow nodes and edges.

### Deliverables

- `generateStructuralLayout(snapshot): LayoutSpec`
- tests asserting layout stability for fixture repos

### Done Means

- Folder view is deterministic, readable, and saved/restored cleanly.

## Chunk 8: Add File Preview, Search, And Focus Tools

### Scope

Make the viewer useful for day-to-day navigation before smarter layouts exist.

### Tasks

- Improve file preview rendering.
- Add syntax highlighting only if it does not complicate performance too early.
- Add full-text or filename search.
- Add quick-jump to file.
- Add “focus selection” behavior.
- Add incoming/outgoing dependency inspection for selected files.
- Add connected-node highlighting using React Flow graph utilities and local graph state.
- Add neighborhood exploration for call-graph-connected nodes.
- Keep graph interaction state in Zustand selectors/actions rather than local component state.

### Deliverables

- Search bar
- Preview panel
- Selection state reflected in URL or local app state
- Connected-node inspector for imports/calls

### Done Means

- A user can use the tool productively without any custom layouts.

## Chunk 9: Add Saved Layouts And Project Config

### Scope

Persist view state and project-specific analysis hints.

### Tasks

- Add `.semanticode/layouts/`
- Add `.semanticode/cache/`
- Add `semanticode.config.json`
- Support saving named layouts.
- Support loading and deleting saved layouts.
- Support project hints:
  entry points, ignored generated paths, subsystem labels, pipeline stages, important call-graph roots.

### Deliverables

- layout persistence
- project config loader
- schema validation for saved files

### Done Means

- Layouts and analysis hints survive restarts and can be committed if desired.

## Chunk 10: Build The First Smart Deterministic Layout

### Scope

Prove the layout engine can do more than mirror folders.

### First Layout

`reachable vs likely unreachable`

### Tasks

- Pick entry points from config or heuristics.
- Traverse the import graph.
- Mark reachable files.
- Mark unvisited files as `likely_unused`.
- Generate a two-lane layout:
  reachable on the left, likely unreachable on the right.
- Make uncertainty visible in the UI.

### Important Constraint

- Present the result as heuristic, never as truth.

### Deliverables

- first rule-based layout generator
- UI to switch between `folder view` and `used vs unused`

### Done Means

- The product has one genuinely useful alternate view before any AI layer exists.

## Chunk 11: Add Call-Graph Views And More Rule-Based Layout Strategies

### Scope

Expand deterministic layout value before introducing prompts.

### Candidate Layouts

- test files near implementation
- entry points to leaves
- config/build/runtime split
- backend/frontend split
- caller/callee neighborhood around selected symbol
- file-level call clusters aggregated from symbol edges
- pipeline lanes driven by project config

### Tasks

- Generalize the layout strategy interface.
- Add strategy selection in the UI.
- Add per-strategy settings where necessary.
- Add toggleable graph layers:
  filesystem structure, import graph, call graph.

### Deliverables

- at least 2 to 3 additional rule-based layout generators
- one call-graph-focused layout or exploration mode

### Done Means

- Users can switch among multiple meaningful structural views without AI.

## Chunk 12: Define The Agent Layout Contract

### Scope

Freeze the boundary between repo analysis and prompt-based layout planning.

### Tasks

- Define a strict JSON schema for agent layout output.
- Define the summary payload schema sent to the planner.
- Add validation and error reporting for malformed planner output.
- Decide what the planner is allowed to control:
  groups, lanes, labels, annotations, ordering, hidden nodes.
- Decide what the planner is not allowed to control:
  arbitrary code execution, arbitrary HTML, arbitrary CSS, arbitrary TS.

### Deliverables

- `LayoutPlanRequest` schema
- `LayoutPlanResponse` schema
- validation logic
- test fixtures with valid and invalid planner responses

### Done Means

- The prompt pipeline has a safe, stable contract.

## Chunk 13: Build The Prompt-To-Layout Flow

### Scope

Add the first agent-assisted workflow on top of the strict contract.

### Tasks

- Add prompt input in the UI.
- Build a repo summarizer that sends compressed structure, import graph, and call-graph summaries, not raw full source by default.
- Support a local planner implementation stub first.
- Add accept/reject flow for generated layouts.
- Show planner rationale and unresolved ambiguities.
- Save accepted layouts as normal layout files.

### Recommended Rollout

- Step 1:
  local mock planner with hardcoded outputs for known prompts
- Step 2:
  local rules-plus-template planner
- Step 3:
  pluggable external model provider if still desired

### Deliverables

- prompt box
- planner request pipeline
- generated layout review flow

### Done Means

- The user can type a prompt and get a structured, inspectable layout proposal.

## Chunk 14: Add Pipeline-Aware Layouts

### Scope

Support the more ambitious “arrange files by architecture flow” use case.

### Tasks

- Extend config to define named stages or domains.
- Allow files to be tagged to one or more stages.
- Let deterministic and agent planners both target stage lanes.
- Add annotations between stage columns.
- Allow layouts to incorporate import/call connectivity when placing files inside stages.

### Example Outcome

- input
- simulation
- world state
- render setup
- draw
- post-process

### Deliverables

- config-driven lane layout
- pipeline-focused example project fixture

### Done Means

- The product can represent architecture flow, not just filesystem structure.

## Chunk 15: Hardening, Performance, And Packaging

### Scope

Prepare the tool for broader usage.

### Tasks

- Test on small, medium, and large repos.
- Add lazy loading for file contents if needed.
- Avoid rendering every node at once when the repo is large.
- Improve scan caching.
- Improve call-graph extraction cost and caching.
- Isolate `js-callgraph` execution behind a backend adapter so it can be replaced later if needed.
- Reduce visual overload for dense graphs with filtering, clustering, and graph-layer toggles.
- Add packaging checks:
  `npm pack`, bin verification, asset serving verification.
- Add documentation for:
  install, CLI usage, project config, saved layouts, graph modes, limitations.

### Deliverables

- performance budget
- packaging verification checklist
- user docs

### Done Means

- The package is reliable enough for external use and iteration.

## Suggested Build Order By Week Or Sprint

### Sprint 1

- Chunk 0
- Chunk 1
- Chunk 2

### Sprint 2

- Chunk 3
- Chunk 4
- Chunk 5

### Sprint 3

- Chunk 6
- Chunk 7
- Chunk 8

### Sprint 4

- Chunk 9
- Chunk 10
- Chunk 11

### Sprint 5

- Chunk 12
- Chunk 13

### Sprint 6

- Chunk 14
- Chunk 15

## Recommended MVP Cut

If you want the smallest useful version, stop after Chunk 10.

That gives you:

- installable CLI tool
- local repo scanning
- React Flow-based canvas UI
- folder-based default layout
- file preview
- search
- one meaningful alternate layout:
  `reachable vs likely unreachable`
- basic import graph and connected-node exploration

This is the right cutoff before adding prompt-based layouts.

## Immediate Execution Order

If implementation starts now, the next concrete coding sequence should be:

1. Define the shared schemas.
2. Add real `.gitignore` support.
3. Add import and initial call-graph extraction for TS/JS.
4. Add a CLI entry point.
5. Add a local server.
6. Replace the current demo with API-backed frontend data loading.
7. Build the React Flow viewport and structural layout generator.
8. Add search, preview, and connected-node exploration.
9. Add saved layouts.
10. Add the first deterministic smart layout.
11. Only then start the planner contract.
