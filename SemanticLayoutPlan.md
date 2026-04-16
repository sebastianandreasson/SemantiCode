# Semantic Layout Plan

## Goal

Add an optional experimental layout mode that positions symbols by semantic similarity rather than filesystem or callgraph structure.

The product behavior should be:

- user opens a repository
- the app indexes symbols as it already does
- the user chooses a new `Semantic` layout
- symbols are embedded with a code-aware embedding pipeline
- embeddings are projected to 2D
- the app renders a spatial view where semantically related symbols are near each other

This should be an additional layout strategy, not a replacement for the existing structural or agent-generated layouts.

## Product Positioning

This is for exploration, not precision editing.

Good uses:

- find conceptually related code across folders
- see clusters like auth, routing, persistence, state, rendering
- inspect large repositories through meaning rather than directory structure
- help the agent and the user converge on logical flows

It should be labeled clearly as experimental because:

- semantic neighborhoods can be surprising
- projection can move between runs if not stabilized
- “meaning” is less predictable than “contains/imports/calls”

## Non-Goals

Do not:

- replace the current filesystem or symbol layouts
- run a network-only embedding workflow by default
- make this a blocking requirement for normal repo loading
- use CLIP as the primary model

CLIP is the wrong baseline here. This should use code/text embeddings, not image-text alignment.

## Recommended Technical Direction

### Embedding Unit

Start with symbol-level embeddings only.

Embed:

- functions
- methods
- classes
- constants
- variables

Do not start with:

- directories
- whole files
- mixed node types in the same embedding space

Files and directories can be derived later from symbol clusters.

### Symbol Text Representation

Each symbol should be embedded from a normalized textual representation built from:

- symbol name
- symbol kind
- file path
- signature when available
- surrounding comments or docstrings
- a trimmed code excerpt
- optional short structural hints like imported dependencies or called symbols

The representation should be deterministic and bounded in size.

Example structure:

```text
path: src/auth/session.ts
kind: function
name: refreshSessionToken
signature: refreshSessionToken(userId: string): Promise<Session>
doc: Refreshes a persisted session and rotates the token when close to expiry.
code:
async function refreshSessionToken(...) { ... }
```

### Projection Strategy

Use:

- embeddings -> similarity graph
- projection to 2D via UMAP
- light post-layout refinement

Do not start with t-SNE.

UMAP is the better default because:

- it preserves neighborhoods well enough for this use case
- it is faster
- it can be made more stable with fixed seeds and cached input order

### Post-Projection Refinement

The raw projection should not be used directly.

Add a refinement pass for:

- collision avoidance
- minimum spacing
- optional attraction for known graph relationships
- label legibility
- cluster separation

This should remain light. The embedding geometry should still dominate the overall shape.

## Core Architecture

## 1. New Layout Strategy

Add a new layout strategy kind:

- `semantic`

This should live alongside:

- `structural`
- `rule`
- `agent`

Update:

- `src/schema/layout.ts`
- any layout strategy discriminators
- layout picker UI

## 2. Semantic Index Pipeline

Add a desktop/local indexing pipeline for semantic layout generation.

Recommended new area:

```text
src/semantic/
  symbolText.ts
  embeddings/
    provider.ts
    localEmbeddingProvider.ts
    remoteEmbeddingProvider.ts
  projection/
    umap.ts
    refinement.ts
  semanticLayout.ts
  semanticCache.ts
  types.ts
```

Responsibilities:

- collect embeddable symbols from snapshot
- build deterministic text for each symbol
- generate embeddings
- cache embeddings by symbol content hash
- project to 2D
- convert projected points into `LayoutSpec`

## 3. Cache Layer

Semantic indexing must be cached aggressively.

Recommended storage:

- workspace-local cache under `.semanticode/semantic/`

Suggested cached artifacts:

- `symbol-text-index.json`
- `embeddings.jsonl` or chunked binary blobs
- `projection.json`
- `semantic-layout.json`

Key each symbol embedding by:

- symbol id
- file path
- symbol range
- content hash of the normalized embedding text
- embedding model id

That lets unchanged symbols reuse embeddings even when the rest of the repo changes.

## 4. Embedding Provider Interface

Add an app-owned interface:

```ts
interface SemanticEmbeddingProvider {
  id: string
  embedTexts(input: { id: string; text: string }[]): Promise<Record<string, number[]>>
}
```

Start with two provider modes:

1. local
   Preferred default when available.

2. remote
   Optional fallback or advanced mode.

The app should be designed so the provider can be swapped without changing the layout pipeline.

## Model Strategy

### Default Direction

Prefer a code-aware embedding model.

The important property is not brand alignment. It is that the model captures code semantics and short technical text well.

The plan should support:

- local embedding backends if feasible
- future hosted embedding providers if needed

### First Implementation Constraint

Do not block the whole feature on “perfect” local inference.

Instead:

- define the provider boundary first
- get the layout pipeline working end to end
- allow one initial provider that is practical in this repo

## Layout Generation Algorithm

### Phase A: Candidate Symbols

From the current `CodebaseSnapshot`:

- take visible symbol nodes
- optionally filter tiny/low-information symbols in v1

Potential v1 filters:

- exclude symbols with extremely short bodies
- exclude autogenerated files
- exclude vendor/build output

### Phase B: Embedding Text

Build normalized text for each symbol.

Store:

- raw source references
- normalized text
- text hash

### Phase C: Embeddings

Embed all uncached symbols.

Persist results.

### Phase D: Projection

Project all symbol vectors into 2D.

Requirements:

- fixed random seed
- deterministic symbol ordering
- versioned projection parameters

### Phase E: Refinement

Turn projected points into view-ready placements:

- scale to viewport-friendly coordinates
- spread overlapping nodes
- maintain readable density
- optionally bias same-file symbols slightly closer together
- optionally bias `calls` edges slightly tighter

### Phase F: LayoutSpec Output

Produce a valid `LayoutSpec` with:

- semantic title
- node scope `symbols`
- placements for projected symbol nodes
- optional annotations for discovered clusters later

## UI Plan

## 1. Layout Picker

Add:

- `Semantic`

to the symbol-layout workflow.

Suggested labels:

- `Semantic (Experimental)`
- `Refresh Semantic Layout`

## 2. Indexing Status

The user needs visible state for:

- semantic index not built
- building embeddings
- projecting layout
- semantic layout ready
- semantic layout stale

This should not feel like the entire app is loading.

Use a layout-specific status surface instead of blocking the whole workspace.

## 3. Regeneration Controls

Add explicit controls:

- build semantic layout
- rebuild semantic layout
- maybe “reuse cached embeddings” vs “full rebuild” later

Do not rebuild automatically on every tiny edit in v1.

Instead:

- mark semantic layout as stale when relevant symbols changed
- let the user refresh intentionally

## 4. Inspector / Agent Interaction

This feature fits directly with the current workflow:

- agent creates or helps refine a logical layout
- user visually selects a cluster of semantically related symbols/files
- inspector agent works on those selected targets

No special agent integration is required for v1 beyond exposing the layout itself.

Later:

- the agent could request semantic neighborhoods for a selected symbol
- the agent could create hybrid semantic + task-specific layouts

## Stability Rules

This feature will feel bad if layouts jump too much.

Stability requirements:

- deterministic symbol ordering before projection
- deterministic seed
- cache and reuse prior coordinates when possible
- avoid rebuilding unless the semantic index is stale

Future enhancement:

- anchored projection using previous coordinates
- preserve local neighborhoods across refreshes

## Performance Strategy

### V1 Constraints

Do not embed the whole repo synchronously on initial open.

Instead:

- load repo normally
- offer semantic indexing as a background task
- cache results incrementally

### Incremental Rebuild Policy

Re-embed only symbols whose normalized text hash changed.

Re-project:

- all symbols in v1, if simpler
- incrementally later if needed

### Repo Size Guardrails

For very large repos:

- limit semantic layout to a symbol subset in v1
- or show a warning and require explicit build

Possible v1 cap:

- first 2k to 5k meaningful symbols

That is a product choice, but some cap is likely necessary.

## Suggested File Changes

### New Files

```text
SemanticLayoutPlan.md
src/semantic/types.ts
src/semantic/symbolText.ts
src/semantic/semanticCache.ts
src/semantic/semanticLayout.ts
src/semantic/embeddings/provider.ts
src/semantic/embeddings/localEmbeddingProvider.ts
src/semantic/projection/umap.ts
src/semantic/projection/refinement.ts
```

### Existing Files Likely To Change

```text
src/schema/layout.ts
src/schema/store.ts
src/store/visualizerStore.ts
src/components/Semanticode.tsx
src/types.ts
src/node/http.ts
src/hosts/standaloneServer.ts
src/App.tsx
```

If the desktop app is the first host to support this, some parts may also live under:

```text
src/desktop/
```

depending on where the embedding provider runs.

## Rollout Plan

### Phase 1. Pipeline Skeleton

Goal:

- define semantic types
- define embedding provider interface
- build symbol text normalization
- build cache format

Definition of done:

- a symbol can produce stable semantic text
- cache keys are deterministic

### Phase 2. First Embedding Provider

Goal:

- integrate one practical embedding backend

Definition of done:

- symbol texts can be embedded and cached

### Phase 3. Projection + LayoutSpec

Goal:

- project embeddings to 2D
- generate a valid semantic `LayoutSpec`

Definition of done:

- a semantic layout can render in the existing symbol canvas

### Phase 4. UI Integration

Goal:

- expose semantic layout controls in the app
- show build/stale/ready states

Definition of done:

- user can build and switch to semantic layout from the UI

### Phase 5. Refinement + Stability

Goal:

- improve spacing
- improve repeatability
- reduce visual churn between rebuilds

Definition of done:

- layout feels stable enough to be useful across repeated use

### Phase 6. Hybrid Features

Possible later work:

- semantic cluster annotations
- combine semantic similarity with callgraph attraction
- file-level semantic groups derived from symbol clusters
- semantic neighborhood actions in the inspector
- agent-generated prompts like “show semantic neighborhood of this symbol”

## Recommended First Milestone

The first milestone should be:

- symbol text normalization
- cached embeddings
- UMAP projection
- semantic `LayoutSpec`
- desktop-only “Build Semantic Layout” button

That is enough to answer the product question:

- does this produce useful code views in practice?

without prematurely building every advanced control around it.

## Success Criteria

This feature is successful if:

- users can see meaningful conceptual clusters that are not obvious from folders alone
- the layout is stable enough to revisit
- it helps users choose relevant files/symbols for focused editing
- it integrates cleanly with the existing agent-assisted workflow

This feature is not successful if:

- it feels random between runs
- it blocks normal repo loading
- it is too slow to rebuild
- it becomes the only way to understand the canvas
