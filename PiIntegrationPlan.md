# Pi Integration Plan

## Summary

Integrate the `pi` coding agent into the standalone desktop app using the SDK as an embedded runtime.

The desktop app remains the product surface:

- React/React Flow canvas
- inspector and editor panes
- workspace scanning and language adapters
- layout planning and persistence

`pi` becomes the agent runtime behind an app-owned agent panel and app-owned workspace tools.

This plan explicitly avoids embedding the `pi` TUI or treating `pi` as a separate application shell. The right boundary is:

- `pi` owns model/runtime/session execution
- this app owns UI, workspace state, permissions, and custom tools

## Product Goal

Within the desktop app, a user should be able to:

- ask the agent questions about the opened repository
- request code edits
- request new visual layouts
- ask architecture questions against the current symbol/file graph
- use current app context such as:
  - active workspace
  - selected file
  - selected symbol
  - active layout
  - visible graph mode

The agent should operate on the opened workspace without the user needing to manually restate all of that context.

## Core Architecture

### 1. Runtime location

Run `pi` inside the Electron main process or in a dedicated desktop-side backend module owned by Electron main.

Why:

- direct access to workspace-scoped tools
- easy control over filesystem and process permissions
- clean IPC bridge to the renderer
- easier session persistence and recovery

Do not run the `pi` runtime in the browser renderer.

### 2. App boundary

Introduce a dedicated agent service boundary:

- renderer talks to `DesktopAgentClient`
- `DesktopAgentClient` talks over IPC
- main process owns `PiAgentService`
- `PiAgentService` owns `pi` sessions and tool registration

This keeps the renderer independent of `pi` implementation details.

### 3. Workspace scoping

Every `pi` session must be scoped to the currently opened workspace.

That means:

- filesystem tools are rooted to the active repo
- bash/exec tools run with the workspace as cwd
- app-specific tools read from the same active workspace snapshot/layout state
- switching workspace means:
  - either close the current agent session
  - or maintain one session per workspace and swap active session

For v1, use one session per workspace and recreate it on workspace switch.

## Recommended Integration Strategy

### Use the SDK, not the CLI

Primary choice:

- embed `pi` using the SDK/runtime entrypoints

Reasons:

- best control over session lifecycle
- direct streaming of events into the renderer
- easy custom tool registration
- easy prompt/context injection
- easier future approval workflow for writes/commands

Do not:

- embed the `pi` TUI
- make the desktop app shell around the `pi` CLI
- make the renderer depend directly on `pi` session objects

## Target Subsystems

### A. Desktop backend agent service

Create a new desktop-only backend module, for example:

- `src/desktop/agent/PiAgentService.ts`

Responsibilities:

- initialize and configure the `pi` runtime
- create and manage sessions
- stream session events
- register built-in and app-native tools
- expose a minimal command surface to IPC
- own session persistence paths

Public responsibilities:

- `createWorkspaceSession(workspaceRootDir)`
- `sendUserMessage(sessionId, message, options?)`
- `cancelRun(sessionId)`
- `disposeSession(sessionId)`
- `getSessionState(sessionId)`
- `subscribeToSessionEvents(sessionId, listener)`

### B. Desktop IPC bridge

Add a typed IPC surface between renderer and Electron main.

Suggested channels:

- `semanticode:agent:create-session`
- `semanticode:agent:send-message`
- `semanticode:agent:cancel`
- `semanticode:agent:get-state`
- `semanticode:agent:event`

Preload exposure:

- `window.semanticodeDesktopAgent.createSession()`
- `window.semanticodeDesktopAgent.sendMessage()`
- `window.semanticodeDesktopAgent.cancel()`
- `window.semanticodeDesktopAgent.subscribe()`

Use a typed event payload model so the renderer is not parsing arbitrary `pi` internals.

### C. Renderer agent client

Create a renderer-side client abstraction, for example:

- `src/agent/DesktopAgentClient.ts`

Responsibilities:

- request session creation
- send messages
- subscribe/unsubscribe to event stream
- normalize backend events into UI state

This should be the only renderer module that knows IPC details.

### D. Agent UI panel

Create a first-class agent panel in the desktop app, likely as a right-side or bottom dockable panel.

Suggested files:

- `src/components/AgentPanel.tsx`
- `src/components/AgentMessageList.tsx`
- `src/components/AgentComposer.tsx`
- `src/components/AgentToolTimeline.tsx`

V1 features:

- message history
- streaming assistant output
- tool call timeline
- cancel button
- session status
- clear error state

V2 features:

- approve/reject write actions
- apply layout draft buttons
- open file from agent results
- compare and apply code edits

## Tool Strategy

The most important integration choice is tool design.

The agent should have two categories of tools:

### 1. Workspace coding tools

These are the usual coding-agent tools, but scoped to the active workspace:

- read file
- write file
- edit/apply patch
- search files
- run commands

These should be workspace-rooted and subject to app policy.

### 2. App-native semantic tools

These are the tools that make the agent feel integrated into this product instead of just acting like a shell bot.

Initial app-native tools:

- `get_workspace_snapshot`
  Returns current snapshot metadata and node/edge summaries.

- `get_active_layout`
  Returns the currently selected layout or draft.

- `list_layouts`
  Returns saved layouts and drafts.

- `save_layout_draft`
  Saves a planner proposal or normalized layout as a draft.

- `get_selected_node_context`
  Returns the current file/symbol/annotation selection plus related metadata.

- `open_file_in_ui`
  Requests the app open a file and focus an optional range.

- `focus_node_in_canvas`
  Requests the app focus/select a node.

- `set_active_layout`
  Switches the current layout in the UI.

- `get_view_mode`
  Returns `filesystem` or `symbols`.

- `set_view_mode`
  Switches the visible mode.

Later app-native tools:

- `get_expanded_symbol_cluster`
- `create_layout_from_prompt`
- `compare_layouts`
- `annotate_layout`
- `summarize_selected_subgraph`

## Session Context Strategy

The agent needs stable context injection.

For every new run, inject a compact workspace context block including:

- workspace root
- current view mode
- active layout title/id
- selected file/symbol/node if any
- high-level snapshot counts
- whether draft layouts exist

Do not inject the entire snapshot by default on every turn.

Instead:

- inject a compact summary into prompt/context
- let the agent call tools for deeper detail

This keeps token use under control and aligns with large repo handling.

## Permissions and Safety

By default, this desktop app should own approval policy.

That means:

- reads/searches: allowed
- layout draft writes: allowed
- file edits: require approval in v1 or behind a setting
- shell commands: require approval in v1
- destructive commands: always gated

Recommended model:

- `read`: auto
- `layout`: auto
- `write`: confirm
- `exec`: confirm
- `dangerous exec`: block or explicit confirm

The approval surface should be app-native, not whatever `pi` would do in another host.

## Persistence Model

### Session persistence

Store agent session data under app-controlled storage, not mixed into repo state.

Suggested:

- app config dir for session transcripts and session metadata
- one active session record per workspace

### Repo persistence

Keep repo-specific outputs in the repo:

- `.semanticode/layouts/`
- `.semanticode/layouts/drafts/`
- `.semanticode/INSTRUCTIONS.md`

That separation matters:

- chat/session memory belongs to the app
- layouts and repo-facing artifacts belong to the workspace

## Proposed Module Layout

Suggested new modules:

- `src/desktop/agent/PiAgentService.ts`
- `src/desktop/agent/piTools.ts`
- `src/desktop/agent/piContext.ts`
- `src/desktop/agent/piEvents.ts`
- `src/desktop/agent/piSessions.ts`
- `src/desktop/ipc/agent.ts`
- `src/agent/DesktopAgentClient.ts`
- `src/schema/agent.ts`
- `src/store/agentStore.ts`
- `src/components/AgentPanel.tsx`
- `src/components/AgentComposer.tsx`
- `src/components/AgentMessageList.tsx`
- `src/components/AgentToolTimeline.tsx`

## Data Model

Add a dedicated agent schema:

- `AgentSessionSummary`
- `AgentMessage`
- `AgentMessageBlock`
- `AgentToolInvocation`
- `AgentToolResult`
- `AgentRunState`
- `AgentEvent`
- `AgentPermissionRequest`

This schema should be app-owned and stable even if the underlying `pi` event format changes.

## Rollout Plan

### Phase 1. Backend runtime spike

Goal:

- prove `pi` SDK can run in Electron main against the active workspace

Tasks:

- install and configure `pi` SDK/runtime dependency
- create `PiAgentService`
- create one workspace session
- stream events to console/log only
- validate session disposal on workspace switch

Done means:

- desktop app can start a `pi` session for the opened workspace
- a test prompt can be sent
- streamed tokens/events are visible in logs

### Phase 2. Minimal renderer bridge

Goal:

- wire the runtime to a basic UI surface

Tasks:

- add IPC channels
- add preload exposure
- create `DesktopAgentClient`
- create a minimal side panel with:
  - prompt box
  - assistant streaming text
  - cancel button

Done means:

- user can talk to the agent from the desktop app
- responses stream live
- workspace switch resets or recreates the session cleanly

### Phase 3. Workspace-scoped built-in tools

Goal:

- make the agent useful as a coding agent inside the opened repo

Tasks:

- bind built-in coding tools to current workspace root
- enforce file/exec policy
- expose read/search/edit capabilities
- test with real repo tasks

Done means:

- the agent can inspect and modify files in the active workspace under app control

### Phase 4. App-native tools

Goal:

- make the agent feel integrated with the visualization/editor product

Tasks:

- add snapshot/layout/selection tools
- add `save_layout_draft`
- add UI actions from tool results
- add `open_file_in_ui` and `focus_node_in_canvas`

Done means:

- the agent can reason directly about the current graph/layout state
- layout tasks no longer require indirect filesystem hacks

### Phase 5. Approval UX

Goal:

- safely enable editing and command execution

Tasks:

- add permission request schema/events
- add renderer approval cards/modals
- suspend/resume tool runs on approval
- define settings for trusted workspaces

Done means:

- write/exec actions are clearly mediated by the app

### Phase 6. Session quality

Goal:

- make long-running use practical

Tasks:

- session persistence
- resume previous workspace session
- compaction/summarization strategy
- user/system prompt tuning
- failure recovery

Done means:

- conversations survive app restart and remain useful in larger repos

## UI Placement Recommendation

For v1:

- add the agent as a docked panel in the inspector side of the app
- keep canvas + inspector intact
- let the agent panel share vertical space with file/graph inspector tabs

Why:

- smallest UI disruption
- agent can immediately leverage existing selection state
- later it can become its own dockable pane

## Risks

### 1. Tool overexposure

If the agent gets raw unrestricted execution too early, it becomes risky and difficult to trust.

Mitigation:

- start read-only plus layout tools
- add write/exec approvals later

### 2. Session/event mismatch

If the renderer couples to raw `pi` event shapes, future upgrades become painful.

Mitigation:

- normalize all events through an app-owned schema

### 3. Workspace switching complexity

If the desktop app allows switching workspaces while a session is mid-run, state can become inconsistent.

Mitigation:

- cancel/dispose current run on workspace switch in v1

### 4. Too much context in prompt

Dumping snapshot/layout state into every turn will scale badly.

Mitigation:

- compact injected context
- deeper data only through tools

## Definition of Success

This integration is successful when:

- the desktop app can host a live `pi` session for the current workspace
- the user can ask repo questions and receive streamed answers
- the agent can inspect the current graph/layout through app-native tools
- the agent can create layout drafts directly inside the app
- file edits and shell commands are mediated by app-owned approval policy

## Recommended Immediate Next Step

Start with Phase 1 only:

- install the `pi` SDK/runtime
- create a minimal `PiAgentService`
- boot one workspace session in Electron main
- send a hardcoded test prompt
- log streamed events

That will validate the hardest architectural assumption before UI work begins.
