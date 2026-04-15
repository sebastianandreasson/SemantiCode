# Codex Auth Rewrite Plan

## Summary

Throw away the current desktop agent auth/runtime direction and rebuild it around the same practical shape Codex uses:

- local ChatGPT/Codex OAuth login
- localhost callback server
- locally stored auth state
- manual redirect paste fallback
- no provider API keys in the normal path

For actual inference, do **not** start by reproducing Codex's direct backend request path inside this app. Start with a safer runtime boundary:

- own auth flow
- own auth storage
- Codex CLI execution for inference

Only after that is stable should this repo consider converging back toward the `pi` SDK runtime with Codex-backed auth.

This plan is intentionally different from the brokered `AppTransport` direction. The current `provider` and `app` transport split should be treated as dead-end experimentation for this feature.

## Important Boundary

The `pi` SDK does **not** appear to own the Codex/ChatGPT OAuth flow.

From the installed packages in this repo:

- `@mariozechner/pi-agent` only provides the `Agent` plus transport abstractions
- the built-in transports are `ProviderTransport` and `AppTransport`
- there is no built-in OpenAI Codex / ChatGPT OAuth implementation in the SDK packages

So the correct long-term architecture for this repo is:

- app-owned Codex auth provider
- app-owned token storage and localhost callback handling
- custom Codex runtime boundary
- optional reintroduction of the `pi` SDK **above** that runtime boundary

That means the likely future convergence is **not**:

- use the `pi` SDK for Codex auth

It is:

- keep app-owned Codex auth
- implement a custom `CodexCliTransport` that satisfies the `pi-agent` transport interface
- let the `pi` `Agent` own message queueing, streaming state, and event emission on top of that transport

In short:

- auth stays outside the SDK
- runtime/state may move back inside the SDK

## Current Recommendation

Do not rush back to the SDK transport layer before the Codex CLI path is stable.

The safest progression is:

1. make the app-owned Codex auth + Codex CLI execution path fully reliable
2. keep parsing the real Codex JSON event shapes until they are well understood
3. then extract that parser into a `CodexCliTransport implements AgentTransport`
4. then reintroduce `new Agent({ transport })` for brokered OAuth sessions

That should let this repo regain the SDK’s useful pieces:

- message queueing
- `waitForIdle()`
- agent state transitions
- standardized event emission

without forcing subscription auth back through unsupported `ProviderTransport` or `AppTransport` assumptions.

## Product Goal

Inside the desktop app, a user should be able to:

- click `Connect ChatGPT`
- sign in through the browser using a localhost callback
- complete auth automatically or by manually pasting the final redirect URL
- have the app persist that auth locally
- use the agent without entering an API key

The first working version should use the local Codex CLI as the execution engine.

The later target is:

- Codex-style auth
- `pi` SDK-based runtime
- still no API key requirement for the primary path

## Guiding Decisions

### 1. Auth and inference are separate problems

Do not keep coupling these:

- auth transport
- `pi` transport
- OpenAI provider auth
- Codex backend assumptions

The rewrite should make auth reusable regardless of whether inference runs through:

- Codex CLI
- `pi` SDK
- a future Codex-specific direct transport

### 2. Use Codex auth, but not Codex backend emulation, in v1

The local tooling strongly suggests Codex itself talks to a Codex-specific backend path on `chatgpt.com`, but reproducing that client path directly is the fragile part.

So the safe progression is:

1. implement local Codex-style auth
2. test with Codex CLI execution
3. only later decide whether to rejoin `pi`

### 3. Keep the UI contract stable

The renderer should not care whether the backend runtime is:

- CLI-backed
- `pi` SDK-backed
- future direct transport-backed

Introduce a stable app-owned backend interface now, and swap runtime implementations behind it.

## What To Replace

The following current direction should be treated as obsolete for this rewrite:

- direct provider auth as the main path
- `ProviderTransport` for ChatGPT/Codex login
- generic `AppTransport` with user-entered app-server URL
- OpenAI OAuth client-id dev flow as the primary path

That code does not need to be deleted in the first patch, but it should no longer drive the design.

## Target Architecture

### Desktop Main Process

Owns:

- auth state
- localhost callback handling
- secure token persistence
- CLI runtime orchestration
- future runtime switching

### Renderer

Owns:

- `Connect ChatGPT` UX
- manual URL paste fallback UI
- agent thread UI
- runtime status display

### New Provider Layer

Add a dedicated desktop provider boundary:

- `src/desktop/providers/openai-codex/`

This provider owns auth only, not general app state.

## Concrete File Layout

Create:

```text
src/desktop/providers/
  openai-codex/
    auth.ts
    storage.ts
    refresh.ts
    callback-server.ts
    provider.ts
```

Reuse existing desktop app boundaries where possible:

- `src/desktop/main.ts`
- `src/desktop/preload.ts`
- `src/agent/DesktopAgentClient.ts`
- `src/components/AgentPanel.tsx`

Add a runtime layer:

```text
src/desktop/agent-runtime/
  types.ts
  CodexCliRuntime.ts
  AgentRuntimeService.ts
```

The old `PiAgentService` should eventually either:

- be removed, or
- become one runtime implementation behind `AgentRuntimeService`

## Phase Plan

### Phase 0. Freeze the current path

Goal:

- stop extending the current mixed auth/runtime experiment

Changes:

- mark API-key auth as secondary
- mark current `OpenAI OAuth` + `AppTransport` path as experimental
- stop adding more logic to the current `PiAgentService` auth branch

Definition of done:

- a clear rewrite target exists
- no new product logic is added to the old auth stack

### Phase 1. Build the local Codex auth provider

Goal:

- own the Codex-style login lifecycle completely in Electron main

Implement these provider methods:

- `startLogin()`
- `handleCallback(url)`
- `refreshIfNeeded()`
- `logout()`

Deliverables by file:

#### `callback-server.ts`

Responsibilities:

- bind localhost on a random free port
- expose `/auth/callback`
- capture the full final callback URL
- resolve a pending login promise
- time out and clean up safely

Public API:

- `startCallbackServer(): Promise<{ port, waitForCallback, close }>`

#### `auth.ts`

Responsibilities:

- generate PKCE verifier/challenge
- construct the login URL
- open browser via Electron shell
- coordinate callback handling
- exchange auth code for tokens

Public API:

- `buildLoginUrl()`
- `exchangeCode()`
- `parseCallbackUrl()`

#### `storage.ts`

Responsibilities:

- store encrypted token state under `app.getPath('userData')`
- own file schema versioning
- load and save auth state

Stored fields:

- access token
- refresh token
- id token
- account metadata
- expiry timestamps
- last refresh timestamp

#### `refresh.ts`

Responsibilities:

- refresh tokens when near expiry
- centralize refresh policy and error handling

#### `provider.ts`

Responsibilities:

- expose the provider-facing API for the rest of the app

Public API:

- `getAuthState()`
- `startLogin()`
- `handleCallback(url)`
- `completeManualRedirect(url)`
- `refreshIfNeeded()`
- `logout()`

Definition of done:

- user can sign in locally
- callback works automatically when localhost succeeds
- tokens are stored locally
- auth state survives app restart

### Phase 1.5. Manual redirect paste fallback

Goal:

- ensure login still works if localhost callback handling fails

UI flow:

1. user clicks `Connect ChatGPT`
2. backend starts callback server and generates login URL
3. UI shows:
   - `Open browser`
   - the generated login URL
   - a text box labeled `Paste final redirected URL if needed`
4. if localhost callback succeeds, login completes automatically
5. if not, user pastes final URL
6. backend parses the URL and completes token exchange

Definition of done:

- login works both automatically and manually

### Phase 2. Replace runtime with Codex CLI execution

Goal:

- get a working subscription-backed agent without reproducing Codex's backend request path

This phase explicitly avoids the `pi` SDK.

Why:

- much less breakage risk
- easier validation of auth + execution separately
- no need to clone Codex's private request semantics

Add:

```text
src/desktop/agent-runtime/CodexCliRuntime.ts
```

Responsibilities:

- invoke Codex CLI as a subprocess
- pass prompt and workspace context
- capture output
- support cancellation
- normalize results into the app's agent event model

Execution model options:

- simplest: one-shot prompt/response runs
- then: session-backed CLI invocation if Codex exposes it cleanly

Definition of done:

- authenticated user can send prompts from the desktop app
- backend executes via Codex CLI
- responses stream or poll back into the existing agent panel

### Phase 3. Introduce runtime abstraction

Goal:

- make auth independent from runtime implementation

Add:

```text
src/desktop/agent-runtime/types.ts
src/desktop/agent-runtime/AgentRuntimeService.ts
```

Runtime interface:

- `createSession(workspaceRootDir)`
- `sendMessage(sessionId, message)`
- `cancel(sessionId)`
- `getState(sessionId)`
- `disposeSession(sessionId)`

Runtime implementations:

- `CodexCliRuntime`
- later `PiSdkRuntime`

Definition of done:

- renderer talks to one stable runtime contract
- runtime implementation can be swapped without UI rewrite

### Phase 4. Rejoin `pi` SDK carefully

Goal:

- move from CLI-backed execution to `pi` SDK while keeping Codex auth

Important:

- do **not** start here
- only do this after Phase 2 is already working

Approach:

1. keep the Phase 1 auth provider unchanged
2. keep the Phase 3 runtime boundary unchanged
3. replace CLI runtime with a `PiSdkRuntime`
4. feed Codex-backed auth into whatever execution path `pi` actually uses successfully

Two possibilities:

#### Option A. `pi` can be driven by imported Codex auth through a supported path

If that works, implement:

- `src/desktop/agent-runtime/PiSdkRuntime.ts`

#### Option B. `pi` cannot safely do this without duplicating Codex-specific request logic

Then keep CLI runtime as the production path for now.

Definition of done:

- `pi` SDK can run with Codex auth and no API key
- or the app deliberately stays on CLI runtime until that is true

### Phase 5. Optional direct Codex request layer

Goal:

- only if absolutely needed, reproduce the direct request side that Codex uses

This is the highest-fragility phase and should be deferred.

Why it is fragile:

- client-specific request expectations
- opaque backend behavior
- risk of breakage from headers, payload shape, or auth assumptions

Only pursue this if:

- CLI runtime is not sufficient
- `pi` SDK cannot be made to work cleanly
- the product needs tighter integration than CLI execution can provide

## Repo-Specific Refactor Steps

### Step 1. Introduce new provider module without deleting old code

Add:

- `src/desktop/providers/openai-codex/*`

Do not immediately delete:

- `src/desktop/agent/OpenAIOAuthClient.ts`
- `src/desktop/agent/PiAgentService.ts`

First, get the new provider compiling and reachable.

### Step 2. Move renderer to a new auth contract

Update:

- `src/schema/agent.ts`
- `src/agent/DesktopAgentClient.ts`
- `src/components/AgentPanel.tsx`
- `src/node/http.ts`
- `src/shared/constants.ts`

Replace the current settings surface with:

- auth status
- `Connect ChatGPT`
- `Open browser`
- manual redirect paste field
- `Sign out`

Remove from normal UX:

- API key-first assumptions
- app server URL field
- direct provider/OpenAI client-id assumptions

### Step 3. Add CLI runtime

Add:

- `src/desktop/agent-runtime/CodexCliRuntime.ts`
- `src/desktop/agent-runtime/AgentRuntimeService.ts`

Then connect Electron main to that runtime instead of directly to `PiAgentService`.

### Step 4. Keep the current agent panel, swap the backend

The current agent panel can survive if it stops assuming:

- `pi` session shape
- provider/app transport settings

Keep:

- message list
- composer
- cancel button
- session state panel

Change:

- auth controls
- runtime backend wiring

## Data Model Changes

### Auth state

Replace the current auth model with a simpler provider-auth state:

- `disconnected`
- `connecting`
- `connected`
- `refreshing`
- `error`

Include:

- `provider: 'openai_codex'`
- `accountEmail?`
- `accountId?`
- `expiresAt?`
- `needsRefresh`

### Runtime state

Separate from auth:

- `idle`
- `running`
- `cancelling`
- `error`

This prevents auth and runtime errors from being conflated.

## Manual Fallback UX

The UI copy should be explicit:

- `Connect ChatGPT`
- `Open browser`
- `If the app does not reconnect automatically, paste the final redirected URL here.`

Actions:

- `Paste Redirect URL`
- `Complete Sign-In`
- `Sign Out`

This flow is ugly, but concrete and testable.

## Testing Plan

### Auth

- starts localhost callback server on random port
- generates valid login URL
- handles callback URL automatically
- handles pasted callback URL manually
- persists tokens locally
- refreshes token near expiry
- logs out cleanly

### Runtime

- CLI runtime launches Codex in workspace context
- prompt succeeds when auth is connected
- cancel stops active run
- runtime survives app restart or cleanly resets

### Integration

- user can sign in from welcome state
- user can sign in after opening workspace
- auth state persists per app install
- send button is enabled only when both auth and runtime are ready

## Risks

### 1. Codex auth token semantics may change

This is why Phase 2 uses CLI execution instead of direct backend emulation.

### 2. CLI interaction may be less structured than `pi`

That is acceptable for the first working version.

### 3. Future `pi` convergence may still fail

That is why the runtime must be abstracted before attempting to rejoin the SDK.

## Recommended Immediate Work Order

1. build `src/desktop/providers/openai-codex/storage.ts`
2. build `src/desktop/providers/openai-codex/callback-server.ts`
3. build `src/desktop/providers/openai-codex/auth.ts`
4. build `src/desktop/providers/openai-codex/provider.ts`
5. wire manual redirect paste fallback into `AgentPanel`
6. add `CodexCliRuntime`
7. route the existing agent UI through the new runtime service

## Decision

The concrete plan for this repo is:

- replace the current OAuth and app-server experiment
- implement local Codex-style auth from scratch
- use manual redirect paste fallback
- use Codex CLI for inference first
- only later attempt to converge back onto `pi` SDK with Codex auth

That is the shortest path to something real that matches how `pi.dev` feels, while avoiding the most fragile part until the rest is working.
