# Brokered OAuth Plan

## Summary

Move the desktop agent from direct provider authentication toward a brokered account-login model where the app signs the user in through a backend service and then runs the agent through an app-scoped transport instead of requiring a local provider API key.

This plan assumes:

- desktop app is the primary host
- brokered OAuth is the preferred end-user path
- direct API keys remain as a fallback only
- the backend broker is a required part of the product, not an optional convenience

## Product Goal

A user should be able to:

- click `Sign in with OpenAI`
- complete login in the browser
- return to the desktop app with an authenticated app session
- use the embedded agent without entering an API key
- sign out and switch accounts cleanly

The desktop app should not need direct access to the user's OpenAI credentials.

## Constraints

### 1. Transport architecture

The current desktop integration uses direct provider mode:

- `ProviderTransport`
- local model selection
- local API key lookup

That is the wrong transport for brokered account auth.

Brokered OAuth requires:

- app-owned backend session
- app token in the desktop app
- backend-mediated agent execution
- `AppTransport` or an equivalent backend proxy transport

### 2. Backend dependency

This feature is not implementable as desktop-only UI work.

You need a backend that can:

- start login
- receive auth callback
- store provider-linked identity or session material
- issue app auth/session tokens
- proxy model and agent requests
- expose an authenticated agent runtime endpoint to the desktop app

### 3. Policy dependency

Before rollout, confirm the exact allowed path for “use my subscription” against the chosen provider program and account type. Engineering should not assume that any consumer subscription can be reused arbitrarily by a third-party desktop client.

## Target Architecture

### Desktop App

- owns UI and local workspace state
- opens browser for sign-in
- receives callback/deep-link
- stores only app session tokens locally
- talks to backend agent APIs
- uses `AppTransport`

### Broker Backend

- owns OAuth or account-link flow
- stores provider-linked credentials or session references server-side
- issues app auth tokens
- validates desktop session
- executes agent/model requests on behalf of authenticated users

### Provider Layer

- OpenAI account linkage
- provider policy enforcement
- account/session refresh

## Delivery Phases

### Phase 0. Refactor local auth model

Goal:

- make current desktop agent/auth model explicitly support more than API keys

Deliverables:

- `authMode: 'api_key' | 'brokered_oauth'`
- `transportMode: 'provider' | 'app'`
- session summaries carry auth and transport metadata
- settings model includes OAuth readiness fields
- UI can render API-key mode and OAuth mode distinctly

Definition of done:

- current API-key flow still works
- code no longer assumes direct provider auth everywhere

### Phase 1. Backend-facing contracts

Goal:

- define the desktop/backend protocol before backend implementation

Deliverables:

- shared backend auth/session types
- broker settings in desktop config
- placeholder endpoints/contracts for:
  - `GET /agent/auth/session`
  - `POST /agent/auth/login/start`
  - `POST /agent/auth/logout`
  - `GET /agent/auth/callback-state`

Desktop contract:

- `beginBrokeredLogin(provider)`
- `completeBrokeredLogin(params)`
- `getBrokeredAuthSession()`
- `logoutBrokeredAuthSession()`

Definition of done:

- desktop app can represent “not signed in”, “sign-in in progress”, and “signed in” states without yet performing real login

### Phase 2. Broker backend service

Goal:

- build the server-side auth broker

Responsibilities:

- start OpenAI login/account-link flow
- validate callback
- persist provider linkage
- mint app session token
- expose authenticated agent runtime endpoint

Deliverables:

- auth broker service
- secure token/session storage
- desktop callback or device-code completion flow
- local/dev and production environment config

Definition of done:

- backend can issue a valid desktop app session after successful login

### Phase 3. Electron login flow

Goal:

- connect desktop app to the broker

Recommended flow:

1. desktop requests login start from backend
2. backend returns auth URL and correlation state
3. app opens system browser
4. callback returns to:
   - custom protocol handler, or
   - localhost callback receiver
5. app exchanges callback data for app session token
6. app stores app session locally

Deliverables:

- desktop login button
- pending login state
- callback handling
- logout flow

Definition of done:

- a user can sign in from the desktop app without manually copying API keys

### Phase 4. Switch agent runtime to app transport

Goal:

- stop routing authenticated OAuth users through `ProviderTransport`

Deliverables:

- `PiAgentService` chooses transport by auth mode
- `brokered_oauth` uses `AppTransport` or equivalent backend transport
- backend executes prompts using authenticated app session
- agent events stream back to desktop app

Definition of done:

- a signed-in OAuth user can create a session and prompt the agent with no local provider key

### Phase 5. Account/session UX

Goal:

- make brokered auth feel like a product feature, not a prototype

Deliverables:

- account badge in agent settings
- signed-in provider/user summary
- token expiry handling
- reconnect/re-auth flow
- logout and account switching

Definition of done:

- user can understand whether they are signed in and recover from expired sessions

### Phase 6. Hardened rollout

Goal:

- make the system operationally safe

Deliverables:

- backend auth telemetry
- rate limits
- session revocation
- secure desktop token storage
- environment-specific broker URL config
- developer documentation

Definition of done:

- system is usable by more than one developer without fragile local setup

## Recommended Immediate Coding Order

1. Phase 0 schema and service refactor
2. Add desktop settings UI for `authMode`
3. Add placeholder broker session types/state
4. Add backend URL configuration plumbing
5. Add desktop login/logout UI shells
6. Then implement the actual broker service

## Backend Requirements Checklist

- authenticated login start endpoint
- callback verification
- app session issuance
- refresh/revocation support
- authenticated agent runtime endpoint
- session introspection endpoint
- logout endpoint

## Desktop Requirements Checklist

- auth mode selection
- sign-in button
- sign-out button
- pending login state
- signed-in account summary
- broker URL configuration
- fallback to API key mode for advanced users

## Risks

### 1. Provider/program mismatch

The business or policy path for “use my subscription” may differ from engineering assumptions. Confirm this before committing the full backend build.

### 2. Transport mismatch

Trying to keep brokered OAuth on top of `ProviderTransport` will create a dead end. The brokered path should move to app/backend transport explicitly.

### 3. Session complexity

Desktop auth, app tokens, backend sessions, and provider refresh all introduce more lifecycle complexity than API keys. Model these explicitly from the start.

## Definition of Success

Brokered OAuth is successful when:

- a new user signs in via browser
- the desktop app returns authenticated
- the agent becomes `ready`
- prompting works without any local provider API key
- logout cleanly disables the session
