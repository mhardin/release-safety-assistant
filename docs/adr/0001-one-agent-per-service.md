# ADR 0001: One Agent (Durable Object) per service

- Status: Accepted
- Date: 2026-10-21

## Context

The assistant needs chat input, live updates to the browser, and memory of past
failures so later triage can recognize repeat patterns (a flaky dependency,
a recurring registry outage). Failure history is most useful scoped to a
service: "checkout-api has timed out against the npm registry 3 times this
week" means something; a global log of every service's failures is noise.

Options considered:

1. **Stateless Worker + D1 (SQL database) or KV.** Simple, but there's no live
   push to the browser without adding WebSockets separately, and every request
   races every other request on shared rows.
2. **A single global Durable Object.** Easy, but it serializes all services
   through one instance and mixes their history.
3. **One `Agent` (Durable Object) per service name.** The Agents SDK's
   `Agent` class is a Durable Object with built-in state sync over WebSocket,
   an embedded SQLite database (`this.sql`), RPC (`@callable`), and Workflow
   integration.

## Decision

Use option 3. The browser connects to `/agents/release-agent/<service>`;
`routeAgentRequest` maps that to the Durable Object named `<service>`.

- **Short-lived UI state** (chat transcript, busy flag) lives in
  `this.state` and is broadcast to all connected tabs on `setState`.
- **Long-lived history** (incidents with cause, confidence, action, failure
  signature, outcome) lives in the agent's SQLite table `incidents`.

## Consequences

- Per-service isolation and history fall out of the addressing scheme; there
  is no tenant column to forget in a query.
- A Durable Object serializes storage operations, but not waiting on outgoing
  calls: while one triage awaits Workers AI, another request for the same
  service can run. The agent therefore allows one triage at a time (the
  persisted `busy` flag) and one rollout at a time.
- Cross-service questions ("which services hit registry timeouts today?") need
  fan-out across agents or a shared store such as D1 or Analytics Engine. Not
  needed for the MVP.
- Anyone who knows a service name can open its agent. A real deployment would
  put Cloudflare Access (or `onBeforeConnect` auth checks) in front of it.
