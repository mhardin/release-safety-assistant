# ADR 0003: Run actions as a Workflow with per-gate approval events

- Status: Accepted
- Date: 2026-10-21

## Context

After triage the developer can execute the recommended action: retry the
job, roll back, or run a staged rollout (canary 5% → 25% → 100%). A staged
rollout pauses for a human between traffic increases, so a single execution
can last minutes to hours, and it must survive restarts of the code running
it without applying a step twice.

Options considered:

1. **Durable Object alarms in ReleaseAgent.** Store a cursor ("at step 3")
   and schedule an alarm for the next step. Workable, but we'd be writing our
   own state machine: idempotency on retry, timeouts, waiting for input.
2. **Cloudflare Workflows.** Durable execution built in: each `step.do`
   result is persisted and not re-run on resume, `step.sleep` lets a canary
   bake without using compute, and `step.waitForEvent` pauses for an
   external event with a timeout.

## Decision

Use a Workflow (`RolloutWorkflow`, an `AgentWorkflow` from the Agents SDK)
started by `ReleaseAgent.startAction`. The plan for each action is a pure
function (`buildPlan`) shared by the Workflow, the Agent, and the UI.

- **Progress:** the Workflow calls `reportProgress`, and the Agent's
  `onWorkflowProgress` updates `state.rollout`, which syncs to every open tab.
  `step.reportComplete` triggers `onWorkflowComplete`, which writes the
  outcome to the incident's history row.
- **Gates:** `step.waitForEvent` directly, with **a distinct event type per
  gate** (`gate-promote-25`, `gate-promote-100`). The SDK's
  `waitForApproval` / `approveWorkflow` use a single `"approval"` type, and
  Workflows buffer events that arrive before anyone waits for them, so an
  extra click could approve the *next* gate before its health check ran. The
  Agent also accepts a decision only for the gate currently waiting, and
  clears it before sending, so a double-click is refused.
- **Safety defaults:** a failed health check rolls back immediately without
  asking; a rejected gate rolls back; a gate with no answer for an hour rolls
  back rather than leaving traffic split indefinitely.
- **One rollout per service at a time**, enforced by the Agent.
- **Fix forward is not executed.** A change-caused failure in pre-merge CI
  has nothing deployed to roll back; the right action is a new commit with
  the merge kept blocked, so the UI shows guidance instead of a button.

## Consequences

- Restart-safety comes from the platform and the Workflow code reads as
  straight-line steps.
- Code outside `step.*` re-runs when a Workflow resumes, so progress reports
  can repeat; the UI can briefly show an older status before catching up.
  Progress is best-effort: a failed report is logged, not allowed to fail the
  rollout midway and skip its automatic rollback.
- Callbacks to the agent can be lost. Before refusing a new rollout because
  one looks active, the agent asks the platform for the instance's real
  status and records it if the Workflow has already ended. If delivering a
  gate decision fails, the gate is reopened so it can be retried.
- Deploys and metrics are simulated (`apply:*` and `simulateMetrics`). The
  `failAt` option lets demos and tests force a health failure at a chosen
  step. Real integration would replace those two functions with calls to a
  deploy API and a metrics query.
- The Workflow is tested end to end in workerd with
  `@cloudflare/vitest-plugin`'s `introspectWorkflow` (sleeps disabled, gate
  timeouts forced).
