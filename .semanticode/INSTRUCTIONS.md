# Semanticode Agent Instructions

This repository is being visualized by Semanticode.
Your job is to turn a natural-language layout request into a saved draft layout for this repository.

## Goal

- Read the repository structure and graph data.
- Create a new layout draft that matches the requested structure.
- Save the draft into this repository so it appears in the visualizer UI.

## Repository Paths

- Repository root: `/Users/sebastianandreasson/Documents/code/personal/codebase-visualizer`
- Draft layouts directory: `.semanticode/layouts/drafts/`
- Accepted layouts directory: `.semanticode/layouts/`
- This instruction file: `.semanticode/INSTRUCTIONS.md`
- Local Semanticode repo: `/Users/sebastianandreasson/Documents/code/personal`

## Preferred Workflow

Use the local Semanticode APIs instead of inventing your own file format.
Do not rely on package-name resolution from the target repository; import from the exact local module paths below.

1. Read a fresh snapshot of the repository.
2. Build a planner context for the requested prompt.
3. Construct a `LayoutPlannerProposalEnvelope`.
4. Validate it.
5. Materialize it into a `LayoutSpec`.
6. Save it as a draft in `.semanticode/layouts/drafts/`.

## Package APIs

```ts
import { readProjectSnapshot } from 'file:///Users/sebastianandreasson/Documents/code/personal/dist/node/index.js'
import {
  buildLayoutPlannerContext,
  validateLayoutPlannerProposal,
  materializeAgentLayout,
  saveLayoutDraft,
  listSavedLayouts,
} from 'file:///Users/sebastianandreasson/Documents/code/personal/dist/planner.js'
```

## Required Draft Shape

A saved draft must follow this shape:

```ts
type LayoutDraft = {
  id: string
  source: 'agent'
  status: 'draft' | 'accepted' | 'rejected'
  prompt: string
  proposalEnvelope: LayoutPlannerProposalEnvelope
  layout: LayoutSpec | null
  validation: ValidationResult
  createdAt: string
  updatedAt: string
}
```

A valid planner proposal envelope must include:

```ts
type LayoutPlannerProposalEnvelope = {
  proposal: {
    title: string
    strategy: 'agent'
    description?: string
    placements: Array<{ nodeId: string; x: number; y: number; width?: number; height?: number; parentId?: string | null; laneId?: string; hidden?: boolean; zIndex?: number }>
    groups: LayoutGroup[]
    lanes: LayoutLane[]
    annotations: LayoutAnnotation[]
    hiddenNodeIds: string[]
  }
  rationale: string
  warnings: string[]
  ambiguities: string[]
  confidence: number | null
}
```

## Validation Rules

- Only place nodes that exist in the current snapshot.
- Do not invent file, directory, or symbol ids.
- A node may only appear once in `placements`.
- `strategy` must be `agent`.
- Coordinates must be finite numbers in absolute canvas space.
- Hidden node ids must exist in the snapshot.
- Group, lane, and annotation ids must be unique within the proposal.

## Choosing `nodeScope`

- Use `filesystem` when placing files and directories.
- Use `symbols` when the layout should contain only symbols such as functions, methods, constants, and variables.
- Use `mixed` only when you intentionally want both kinds together.

## Headings And Labels

Use `annotations` for visual headings such as `Frontend`, `Backend`, `Rendering`, or `Shared`.
Annotations are positioned in absolute canvas space and should not overlap the main node clusters.
Use `groups` for folder-like visual containers around related nodes when the layout should show boxed sections instead of just headings.
Groups are rendered as draggable containers that surround the member nodes listed in `group.nodeIds`.

## Minimal Implementation Sketch

```ts
const rootDir = process.cwd()
const prompt = "Replace with the requested layout structure"
const snapshot = await readProjectSnapshot({
  rootDir,
  analyzeImports: true,
  analyzeSymbols: true,
  analyzeCalls: true,
})

const existingLayouts = await listSavedLayouts(rootDir)
const context = buildLayoutPlannerContext(snapshot, {
  prompt,
  existingLayouts,
  constraints: { nodeScope: 'filesystem' },
})

const proposalEnvelope = {
  proposal: {
    title: 'My custom layout',
    strategy: 'agent',
    placements: [],
    groups: [],
    lanes: [],
    annotations: [],
    hiddenNodeIds: [],
  },
  rationale: 'Explain the layout logic briefly.',
  warnings: [],
  ambiguities: [],
  confidence: 0.8,
}

const validation = validateLayoutPlannerProposal(context, proposalEnvelope)
const timestamp = new Date().toISOString()

await saveLayoutDraft(rootDir, {
  id: `draft-${Date.now()}` ,
  source: 'agent',
  status: validation.valid ? 'draft' : 'rejected',
  prompt,
  proposalEnvelope,
  layout: validation.valid ? materializeAgentLayout(context, proposalEnvelope, { createdAt: timestamp, updatedAt: timestamp }) : null,
  validation,
  createdAt: timestamp,
  updatedAt: timestamp,
})
```

## Output Expectation

When you are done, the repository should contain a new JSON draft file in `.semanticode/layouts/drafts/`.
That draft should appear in the Semanticode layout picker without any manual post-processing.

## Important

- Prefer deterministic layouts over clever but unstable layouts.
- If the user asks for a symbol-only layout, do not place files or directories.
- If the user asks for headings, add them as annotations.
- If the user asks for boxed sections, folders, or visual containers around related nodes, use `groups`.
- If a request is ambiguous, record that ambiguity in `proposalEnvelope.ambiguities` instead of hiding the uncertainty.