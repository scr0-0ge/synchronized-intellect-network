import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type {
  ResumableAgentRuntimeAdapter,
  RuntimeCatalog,
  RuntimeResume,
  RuntimeStart,
} from "../../src/agent-runtime/index.ts";
import {
  createWorkbenchCoordinator,
  type AutoIterationProjectAuthority,
  type ProjectChannel,
} from "../../src/coordinator/index.ts";
import type {
  HostBoundToolActor,
  QuotaObservation,
  SubmitWorkOrderRequest,
} from "../../src/coordinator/auto-iteration/contract.ts";

/**
 * w338, issue #8 Lane C consumers: the coordinator's quota observation
 * intake is the production sink for the Codex `account/rateLimits/read`
 * seam, and it drives the #8 §3 quota projection — a read that positively
 * establishes exhaustion parks executing Work Orders at
 * `waiting-for-quota` (the `quotaBlocked` projection input), a read that
 * establishes availability releases them, and an unknown read establishes
 * neither.
 */

const supervisor = {
  kind: "supervisor",
  sessionId: "supervisor-session-1",
  tenure: { roleSlotId: "project-supervisor", generation: 1 },
} as const satisfies HostBoundToolActor;

class NeverCalledAdapter implements ResumableAgentRuntimeAdapter {
  async inspect(): Promise<RuntimeCatalog> {
    throw new Error("inspect must not be called in this test");
  }
  async start(_request: RuntimeStart): Promise<never> {
    throw new Error("start must not be called in this test");
  }
  async resume(_request: RuntimeResume): Promise<never> {
    throw new Error("resume must not be called in this test");
  }
}

async function createFixture(t: TestContext): Promise<{
  readonly authority: AutoIterationProjectAuthority;
  readonly databasePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "uaw-w338-observations-"));
  const projectDirectory = join(root, "project");
  const databasePath = join(root, "project.sqlite");
  await mkdir(projectDirectory);
  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter: new NeverCalledAdapter(),
  }).openProject(projectDirectory);
  assert.ok(channel.autoIteration);
  const authority = channel.autoIteration;
  await authority.bindInitialSupervisor({
    roleSlotId: supervisor.tenure.roleSlotId,
    sessionId: supervisor.sessionId,
    generation: supervisor.tenure.generation,
  });
  t.after(async () => {
    await channel.close();
    await rm(root, { recursive: true, force: true });
  });
  return { authority, databasePath };
}

function quotaObservation(overrides: {
  readonly usedFraction: number | null;
  readonly status?: "observed" | "unknown";
}): QuotaObservation {
  return Object.freeze({
    quotaPoolId: "codex-account:codex",
    source: "codex-account:account/rateLimits/read",
    observedAt: 1_700_000_000_000,
    status: overrides.status ?? "observed",
    windows: Object.freeze([
      Object.freeze({
        name: "primary",
        usedFraction: overrides.usedFraction,
        resetsAt: 1_700_003_600_000,
        windowDurationMinutes: 10_080,
      }),
      Object.freeze({
        name: "secondary",
        usedFraction: null,
        resetsAt: null,
        windowDurationMinutes: null,
      }),
    ]),
  });
}

async function submitExecutingOrder(
  authority: AutoIterationProjectAuthority,
  requestIdempotencyKey: string,
): Promise<string> {
  const request: SubmitWorkOrderRequest = {
    kind: "submit-work-order",
    requestIdempotencyKey,
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    workOrder: {
      objective: "w338 quota observation fixture",
      acceptanceCriteria: ["the fixture passes"],
      baselineCommitSha: "0123456789abcdef0123456789abcdef01234567",
      territory: { writePaths: ["src/"], readOnlyPaths: [] },
      responsibleRoleSlotId: supervisor.tenure.roleSlotId,
      completionCondition: { gitIntegration: "not-required" },
      workerSession: {
        endpointId: "codex-desktop",
        profile: {
          model: "gpt-5.6-sol",
          effortLevel: "high",
          executionMode: "single-agent",
          accessMode: "full-access",
        },
      },
    },
  };
  const response = await authority.request(supervisor, request);
  assert.equal(response.kind, "work-order-submitted");
  if (response.kind !== "work-order-submitted") throw new Error("unreachable");
  return response.workOrder.workOrderId;
}

test("a read establishing exhaustion parks executing work orders at waiting-for-quota", async (t) => {
  const { authority } = await createFixture(t);
  const workOrderId = await submitExecutingOrder(authority, "w338-exhaust-submit");
  await authority.observeQuota(quotaObservation({ usedFraction: 1 }));

  const overview = authority.readAutoIterationOverview();
  assert.equal(overview.quotaWaiting, true, "the quotaBlocked projection input goes true");
  const order = overview.workOrders.find((entry) => entry.workOrderId === workOrderId);
  assert.equal(order?.status, "waiting-for-quota");
});

test("an unknown read never establishes exhaustion or availability", async (t) => {
  const { authority } = await createFixture(t);
  const workOrderId = await submitExecutingOrder(authority, "w338-unknown-submit");
  await authority.observeQuota(quotaObservation({ usedFraction: null, status: "unknown" }));
  assert.equal(authority.readAutoIterationOverview().quotaWaiting, false);
  const order = authority
    .readAutoIterationOverview()
    .workOrders.find((entry) => entry.workOrderId === workOrderId);
  assert.equal(order?.status, "executing");

  // And an unknown read cannot release an already-blocked order either.
  await authority.observeQuota(quotaObservation({ usedFraction: 1 }));
  assert.equal(authority.readAutoIterationOverview().quotaWaiting, true);
  await authority.observeQuota(quotaObservation({ usedFraction: null, status: "unknown" }));
  const blocked = authority
    .readAutoIterationOverview()
    .workOrders.find((entry) => entry.workOrderId === workOrderId);
  assert.equal(blocked?.status, "waiting-for-quota");
});

test("a fresh read establishing availability releases waiting-for-quota work orders", async (t) => {
  const { authority } = await createFixture(t);
  const workOrderId = await submitExecutingOrder(authority, "w338-release-submit");
  await authority.observeQuota(quotaObservation({ usedFraction: 1 }));
  assert.equal(authority.readAutoIterationOverview().quotaWaiting, true);
  await authority.observeQuota(quotaObservation({ usedFraction: 0.4 }));

  const overview = authority.readAutoIterationOverview();
  assert.equal(overview.quotaWaiting, false);
  const order = overview.workOrders.find((entry) => entry.workOrderId === workOrderId);
  assert.equal(order?.status, "executing");
});

test("context observations are recorded and surface in the overview", async (t) => {
  const { authority } = await createFixture(t);
  await authority.observeContextUsage({
    source: "claude-control:get_context_usage",
    observedAt: 1_700_000_000_000,
    sessionId: supervisor.sessionId,
    model: "claude-sonnet-5",
    quality: "authoritative",
    totalTokens: 800_000,
    maxTokens: 1_000_000,
    fraction: 0.8,
  });
  const overview = authority.readAutoIterationOverview();
  assert.equal(overview.lastObservedAt, 1_700_000_000_000);
});
