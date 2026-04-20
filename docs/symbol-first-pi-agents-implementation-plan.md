# Symbol-first PI agents implementation plan

This plan turns `report.html` into incremental repo work. The design goal is
symbol-first, not symbol-only: agents should query symbols and read symbol
slices before falling back to bounded file windows.

## Phase 0: Symbol attribution on existing runs

- [x] Add optional symbol reference fields to agent tool, timeline, and operation
  schemas.
- [x] Extract symbol node IDs from tool arguments and tool results.
- [x] Normalize Semanticode symbol paths such as
  `src/file.ts#symbol@10:0` back to file paths for existing follow behavior.
- [x] Teach follow-agent to prefer explicit symbol IDs over best-symbol
  fallback when resolving symbol-layout targets.
- [ ] Add symbol attribution to request telemetry spans.
- [ ] Add UI affordances for showing exact symbol attribution in the agent
  feed/timeline.

## Phase 1: Read-only symbol tools

- [x] Create a reusable symbol query session modeled after
  `src/planner/layoutQuery.ts`.
- [x] Add PI SDK tools:
  - [x] `getSymbolWorkspaceSummary`
  - [x] `findSymbols`
  - [x] `getSymbolNeighborhood`
  - [x] `readSymbolSlice`
  - [x] `readFileWindow`
- [x] Add output budget and truncation behavior matching layout query tools.
- [x] Add tests for symbol query selectors, neighborhoods, and slices.
- [x] Update Semanticode context injection to tell agents to use symbol tools
  before file tools.

## Phase 2: Symbol-first tool profile

- [x] Add a workspace/agent setting for `standard` versus `symbol-first`.
- [x] Build the PI SDK session with symbol tools active in symbol-first mode.
- [x] Keep broad file tools disabled by default in symbol-first mode.
- [x] Keep `readFileWindow` as the explicit fallback with a required reason.
- [x] Track fallback frequency in telemetry.

## Phase 3: Symbol editing

- [x] Add range-hash validation for symbol slices.
- [x] Add `applySymbolPatch` or `replaceSymbolRange`.
- [x] Refresh the snapshot after successful symbol edits.
- [x] Detect when edits affect imports, module headers, or multiple symbols and
  route those changes through a bounded file patch fallback.
- [x] Add tests for range drift and snapshot refresh behavior.

## Phase 4: Layout and follow parity

- [x] Emit symbol IDs from all symbol tools and symbol edits.
- [x] Extend follow debug state to distinguish exact symbol hits from file
  fallbacks.
- [x] Highlight exact symbol nodes in semantic/custom layouts.
- [x] If a touched symbol is hidden, offer reveal-neighborhood behavior instead
  of switching layouts.
- [x] Add visual/e2e coverage for follow-agent in symbol layouts.

## First success metrics

- Percent of exploratory tool calls resolved without broad file reads.
- Percent of follow-agent activity targets resolved to exact symbols.
- File fallback count by reason.
- Median source characters returned per exploratory tool call.
