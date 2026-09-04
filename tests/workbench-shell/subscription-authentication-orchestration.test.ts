import assert from "node:assert/strict";
import test from "node:test";

import {
  createSubscriptionAuthenticationService,
  type SubscriptionAuthenticationChild,
  type SubscriptionAuthenticationProvider,
  type SubscriptionAuthenticationScheduler,
} from "../../src/agent-runtime/subscription-authentication.ts";
import type { WorkLedgerAuthGenerationModule } from "../../src/coordinator/work-ledger-auth-generation.ts";
import {
  WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS,
  createWorkLedgerSubscriptionAuthenticationMutationAuthority,
  createWorkbenchSubscriptionAuthenticationCoordinator,
} from "../../src/workbench-shell/subscription-authentication-coordinator.ts";

test("the Workbench composes the shared service so the launch precedes the durable rotation and only fresh post-action inspection establishes state", async () => {
  const scheduler = controlledScheduler();
  const child = controlledChild();
  const postActionInspection = deferred<"sign-in-required">();
  const events: string[] = [];
  let inspections = 0;
  const service = createSubscriptionAuthenticationService({
    providers: [
      Object.freeze({
        endpointId: "codex-desktop" as const,
        async launchLogin() {
          throw new Error("unused-controlled-action");
        },
        async launchLogout() {
          events.push("official-action");
          return child;
        },
        inspectAuthentication() {
          inspections += 1;
          events.push(`inspection:${inspections}`);
          return inspections === 1
            ? Promise.resolve("bound" as const)
            : postActionInspection.promise;
        },
      }),
      inertProvider("claude-code-desktop"),
    ],
    scheduler,
    timeoutMilliseconds: 30_000,
    inspectionTimeoutMilliseconds: 10_000,
  });
  const coordinator = createWorkbenchSubscriptionAuthenticationCoordinator({
    endpoints: endpointDefinitions(),
    authentication: service,
    mutations: {
      prepare() {
        return { kind: "ready", preparationKey: "opaque-orchestration-01" };
      },
      begin() {
        events.push("durable-generation");
        return {
          kind: "begun",
          endpointSelectionKey:
            WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
          action: "logout",
        };
      },
      cancel() {
        return false;
      },
    },
  });

  assert.deepEqual(
    accepted(
      await coordinator.request({
        endpointSelectionKey:
          WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
      }),
    ),
    { kind: "authentication-state", state: "bound" },
  );
  assert.deepEqual(
    accepted(
      await coordinator.request({
        endpointSelectionKey:
          WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
        action: "logout",
      }),
    ),
    { kind: "ready", preparationKey: "opaque-orchestration-01" },
  );
  assert.deepEqual(
    accepted(
      await coordinator.request({
        preparationKey: "opaque-orchestration-01",
      }),
    ),
    { kind: "authentication-action-requested", action: "logout" },
  );
  assert.deepEqual(events, [
    "inspection:1",
    "official-action",
    "durable-generation",
  ]);
  assert.equal(coordinator.renderSettings().cards[0].outcome, "requested");

  let inspectionSettled = false;
  const inspection = coordinator
    .request({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
    })
    .then((result) => {
      inspectionSettled = true;
      return result;
    });
  child.finish();
  await tick();
  assert.equal(inspections, 2);
  assert.equal(inspectionSettled, false);
  assert.equal(
    coordinator.renderSettings().cards[0].authentication,
    "Bound",
  );

  postActionInspection.resolve("sign-in-required");
  assert.deepEqual(accepted(await inspection), {
    kind: "authentication-state",
    state: "sign-in-required",
  });
  assert.equal(
    coordinator.renderSettings().cards[0].authentication,
    "Sign-in required",
  );
  await coordinator.close();
});

test("a bound CLI sign-in is re-inspected after app restart without making logout obligatory", async () => {
  const inspections: string[] = [];
  let actionLaunches = 0;
  const authenticationForAppStart = () => ({
    async inspect(endpointId: "codex-desktop" | "claude-code-desktop") {
      inspections.push(endpointId);
      return Object.freeze({ endpointId, authentication: "bound" as const });
    },
    async startAction() {
      actionLaunches += 1;
      throw new Error("restart inspection must not launch an auth action");
    },
    async close() {},
  });
  const mutations = {
    prepare() {
      throw new Error("restart inspection must not prepare an auth action");
    },
    begin() {
      throw new Error("restart inspection must not rotate auth state");
    },
    cancel() {
      return false;
    },
  };

  for (let appStart = 1; appStart <= 2; appStart += 1) {
    const coordinator = createWorkbenchSubscriptionAuthenticationCoordinator({
      endpoints: endpointDefinitions(),
      authentication: authenticationForAppStart(),
      mutations,
    });
    for (const [selectionKey, cardIndex] of [
      [WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex, 0],
      [WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.claude, 1],
    ] as const) {
      assert.deepEqual(
        accepted(await coordinator.request({ endpointSelectionKey: selectionKey })),
        { kind: "authentication-state", state: "bound" },
      );
      const card = coordinator.renderSettings().cards[cardIndex];
      assert.equal(card.authentication, "Bound");
      assert.deepEqual(card.actions, [{ label: "Log out", disabled: false }]);
    }
    await coordinator.close();
  }

  assert.deepEqual(inspections, [
    "codex-desktop",
    "claude-code-desktop",
    "codex-desktop",
    "claude-code-desktop",
  ]);
  assert.equal(actionLaunches, 0);
});

test("production-service inspection failure and timeout both collapse to exact public unknown", async () => {
  const scheduler = controlledScheduler();
  let timedInspectionSignal: AbortSignal | undefined;
  const service = createSubscriptionAuthenticationService({
    providers: [
      Object.freeze({
        endpointId: "codex-desktop" as const,
        async launchLogin() {
          throw new Error("unused-controlled-action");
        },
        async launchLogout() {
          throw new Error("unused-controlled-action");
        },
        async inspectAuthentication() {
          throw new Error("controlled-inspection-failure");
        },
      }),
      Object.freeze({
        endpointId: "claude-code-desktop" as const,
        async launchLogin() {
          throw new Error("unused-controlled-action");
        },
        async launchLogout() {
          throw new Error("unused-controlled-action");
        },
        inspectAuthentication(signal: AbortSignal) {
          timedInspectionSignal = signal;
          return new Promise<never>(() => undefined);
        },
      }),
    ],
    scheduler,
    timeoutMilliseconds: 30_000,
    inspectionTimeoutMilliseconds: 10_000,
  });
  const coordinator = createWorkbenchSubscriptionAuthenticationCoordinator({
    endpoints: endpointDefinitions(),
    authentication: service,
    mutations: unusedMutations(),
  });

  assert.deepEqual(
    accepted(
      await coordinator.request({
        endpointSelectionKey:
          WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
      }),
    ),
    { kind: "authentication-state", state: "unknown" },
  );
  const timedInspection = coordinator.request({
    endpointSelectionKey:
      WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.claude,
  });
  await tick();
  assert.equal(timedInspectionSignal?.aborted, false);
  scheduler.fire(10_000);
  assert.deepEqual(accepted(await timedInspection), {
    kind: "authentication-state",
    state: "unknown",
  });
  assert.equal(timedInspectionSignal?.aborted, true);
  await coordinator.close();
});

test("shared-service action timeout contains a late child and returns an honest not-requested acknowledgement", async () => {
  const scheduler = controlledScheduler();
  const lateLaunch = deferred<SubscriptionAuthenticationChild>();
  const lateChild = controlledChild();
  const events: string[] = [];
  const service = createSubscriptionAuthenticationService({
    providers: [
      Object.freeze({
        endpointId: "codex-desktop" as const,
        launchLogin: () => lateLaunch.promise,
        launchLogout() {
          events.push("official-action");
          return lateLaunch.promise;
        },
        async inspectAuthentication() {
          return "bound" as const;
        },
      }),
      inertProvider("claude-code-desktop"),
    ],
    scheduler,
    timeoutMilliseconds: 30_000,
    inspectionTimeoutMilliseconds: 10_000,
  });
  const coordinator = createWorkbenchSubscriptionAuthenticationCoordinator({
    endpoints: endpointDefinitions(),
    authentication: service,
    mutations: {
      prepare() {
        return { kind: "ready", preparationKey: "opaque-timeout-01" };
      },
      begin() {
        events.push("durable-generation");
        return {
          kind: "begun",
          endpointSelectionKey:
            WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
          action: "logout",
        };
      },
      cancel() {
        return false;
      },
    },
  });

  assert.deepEqual(
    accepted(
      await coordinator.request({
        endpointSelectionKey:
          WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
      }),
    ),
    { kind: "authentication-state", state: "bound" },
  );
  accepted(
    await coordinator.request({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
      action: "logout",
    }),
  );
  const begin = coordinator.request({ preparationKey: "opaque-timeout-01" });
  await tick();
  assert.deepEqual(events, ["official-action"]);
  scheduler.fire(30_000);
  assert.deepEqual(accepted(await begin), {
    kind: "authentication-action-not-requested",
    action: "logout",
  });
  // The launch never completed, so the durable rotation was never reached and
  // the honest "not requested" acknowledgement costs the reader nothing.
  assert.deepEqual(events, ["official-action"]);
  assert.equal(coordinator.renderSettings().cards[0].outcome, "not-requested");
  assert.equal(lateChild.terminateCalls(), 0);

  lateLaunch.resolve(lateChild);
  await tick();
  await tick();
  assert.equal(lateChild.terminateCalls(), 1);
  assert.equal(
    coordinator.renderSettings().cards[0].authentication,
    "Bound",
  );
  await coordinator.close();
});

test("coordinator close cancels a deferred shared-service launch and contains its late exact child", async () => {
  const scheduler = controlledScheduler();
  const lateLaunch = deferred<SubscriptionAuthenticationChild>();
  const lateChild = controlledChild();
  let capturedSignal: AbortSignal | undefined;
  const service = createSubscriptionAuthenticationService({
    providers: [
      Object.freeze({
        endpointId: "codex-desktop" as const,
        launchLogin(signal: AbortSignal) {
          capturedSignal = signal;
          return lateLaunch.promise;
        },
        launchLogout(signal: AbortSignal) {
          capturedSignal = signal;
          return lateLaunch.promise;
        },
        async inspectAuthentication() {
          return "bound" as const;
        },
      }),
      inertProvider("claude-code-desktop"),
    ],
    scheduler,
    timeoutMilliseconds: 30_000,
    inspectionTimeoutMilliseconds: 10_000,
  });
  const coordinator = createWorkbenchSubscriptionAuthenticationCoordinator({
    endpoints: endpointDefinitions(),
    authentication: service,
    mutations: {
      prepare() {
        return { kind: "ready", preparationKey: "opaque-close-01" };
      },
      begin() {
        return {
          kind: "begun",
          endpointSelectionKey:
            WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
          action: "logout",
        };
      },
      cancel() {
        return false;
      },
    },
  });

  accepted(
    await coordinator.request({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
    }),
  );
  accepted(
    await coordinator.request({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
      action: "logout",
    }),
  );
  const begin = coordinator.request({ preparationKey: "opaque-close-01" });
  await tick();
  assert.equal(capturedSignal?.aborted, false);
  await coordinator.close();
  assert.equal(capturedSignal?.aborted, true);
  assert.deepEqual(accepted(await begin), {
    kind: "authentication-action-not-requested",
    action: "logout",
  });

  lateLaunch.resolve(lateChild);
  await tick();
  await tick();
  assert.equal(lateChild.terminateCalls(), 1);
});

test("F115 a failed logout launch leaves the auth generation untouched, keeps the Session resumable, and says nothing happened", async () => {
  const events: string[] = [];
  const world = controlledGenerationWorld(events);
  const coordinator = createWorkbenchSubscriptionAuthenticationCoordinator({
    endpoints: endpointDefinitions(),
    authentication: {
      async inspect(endpointId) {
        return {
          endpointId,
          authentication: endpointId === "codex-desktop" ? "bound" : "unknown",
        };
      },
      async startAction(endpointId, action) {
        events.push(`official-action:${action}`);
        throw new Error("controlled-launch-failure");
      },
      async close() {},
    },
    mutations: world.mutations,
  });

  accepted(
    await coordinator.request({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
    }),
  );
  const prepared = accepted(
    await coordinator.request({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
      action: "logout",
    }),
  ) as { readonly preparationKey: string };
  assert.deepEqual(
    accepted(
      await coordinator.request({ preparationKey: prepared.preparationKey }),
    ),
    { kind: "authentication-action-not-requested", action: "logout" },
  );

  assert.deepEqual(events, [
    "official-action:logout",
    "cancel-preparation",
  ]);
  assert.deepEqual(world.commits, []);
  assert.deepEqual(await coordinator.attemptNativeResume("session-control-01"), {
    nativeResumeRequested: true,
    transcript: ["recorded message", "recorded response"],
  });
  const card = coordinator.renderSettings().cards[0];
  assert.equal(card.outcome, "not-requested");
  assert.equal(
    card.feedback,
    "The Workbench could not ask the provider CLI to log out. Nothing changed, and every Session stays exactly as resumable as it was.",
  );
  await coordinator.close();
});

test("F115 a rotation that fails after the launch reports the partial outcome and names the lost resumability", async () => {
  const events: string[] = [];
  const world = controlledGenerationWorld(events);
  world.failNextCommit();
  const coordinator = createWorkbenchSubscriptionAuthenticationCoordinator({
    endpoints: endpointDefinitions(),
    authentication: {
      async inspect(endpointId) {
        return {
          endpointId,
          authentication: endpointId === "codex-desktop" ? "bound" : "unknown",
        };
      },
      async startAction(endpointId, action) {
        events.push(`official-action:${action}`);
        return {
          endpointId,
          action,
          request: "started" as const,
          completion: Promise.resolve({
            endpointId,
            action,
            effect: "finished" as const,
            request: "started" as const,
            authentication: "unknown" as const,
          }),
        };
      },
      async close() {},
    },
    mutations: world.mutations,
  });

  accepted(
    await coordinator.request({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
    }),
  );
  const prepared = accepted(
    await coordinator.request({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
      action: "logout",
    }),
  ) as { readonly preparationKey: string };
  const begun = accepted(
    await coordinator.request({ preparationKey: prepared.preparationKey }),
  );

  // The provider CLI did act, so the outcome must never be "not requested" —
  // and the rotation did not, so it must not be reported as "requested" either.
  assert.deepEqual(begun, {
    kind: "authentication-action-partially-completed",
    action: "logout",
  });
  assert.deepEqual(events, ["official-action:logout", "commit-attempt"]);
  assert.deepEqual(world.commits, []);
  const card = coordinator.renderSettings().cards[0];
  assert.equal(card.outcome, "partially-completed");
  assert.equal(
    card.feedback,
    "The Workbench asked the provider CLI to log out but could not record the log out. Sessions started before this log out can no longer be resumed, even where the Workbench still offers to resume them.",
  );
  assert.notEqual(
    card.feedback,
    "The Workbench could not ask the provider CLI to log out. Nothing changed, and every Session stays exactly as resumable as it was.",
  );
  assert.notEqual(
    card.feedback,
    "The Workbench asked the provider CLI to log out.",
  );
  assert.match(card.feedback ?? "", /can no longer be resumed/u);
  assert.equal(JSON.stringify(card).includes("success"), false);
  await coordinator.close();
});

test("F115 begin-time blocker drift refuses before the launch, so nothing external and nothing durable happens", async () => {
  const events: string[] = [];
  const world = controlledGenerationWorld(events);
  const coordinator = createWorkbenchSubscriptionAuthenticationCoordinator({
    endpoints: endpointDefinitions(),
    authentication: {
      async inspect(endpointId) {
        return {
          endpointId,
          authentication: endpointId === "codex-desktop" ? "bound" : "unknown",
        };
      },
      async startAction(endpointId, action) {
        events.push(`official-action:${action}`);
        throw new Error("controlled-launch-must-not-be-reached");
      },
      async close() {},
    },
    mutations: world.mutations,
  });

  accepted(
    await coordinator.request({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
    }),
  );
  const prepared = accepted(
    await coordinator.request({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
      action: "logout",
    }),
  ) as { readonly preparationKey: string };
  world.blockNextAuthorization();
  assert.deepEqual(
    accepted(
      await coordinator.request({ preparationKey: prepared.preparationKey }),
    ),
    {
      kind: "blocked",
      blockers: {
        accepted: 0,
        starting: 0,
        inFlight: 1,
        recoveryRequired: 0,
        unknown: 0,
      },
    },
  );
  assert.deepEqual(events, ["cancel-preparation"]);
  assert.deepEqual(world.commits, []);
  assert.deepEqual(await coordinator.attemptNativeResume("session-control-01"), {
    nativeResumeRequested: true,
    transcript: ["recorded message", "recorded response"],
  });
  await coordinator.close();
});

test("F116 every fresh inspection and every completed action reaches the account-observation feed", async () => {
  const observations: string[] = [];
  const completion = deferred<{
    readonly endpointId: "codex-desktop";
    readonly action: "logout";
    readonly effect: "finished";
    readonly request: "started";
    readonly authentication: "sign-in-required";
  }>();
  const observingMutations = {
    ...observationFeedMutations(),
    observe(request: {
      readonly endpointSelectionKey: string;
      readonly state: "bound" | "sign-in-required" | "unknown";
    }) {
      observations.push(`${request.endpointSelectionKey}:${request.state}`);
    },
  };
  const coordinator = createWorkbenchSubscriptionAuthenticationCoordinator({
    endpoints: endpointDefinitions(),
    authentication: observationFeedAuthentication(completion.promise),
    mutations: observingMutations,
  });

  // An inspection is the first place a fresh observed state exists.
  assert.deepEqual(
    accepted(
      await coordinator.request({
        endpointSelectionKey:
          WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
      }),
    ),
    { kind: "authentication-state", state: "bound" },
  );
  assert.deepEqual(observations, [
    `${WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex}:bound`,
  ]);

  // A failed status read still resolves an inspection, and `unknown` must reach
  // the module rather than be filtered out here: inertness is the module's rule.
  assert.deepEqual(
    accepted(
      await coordinator.request({
        endpointSelectionKey:
          WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.claude,
      }),
    ),
    { kind: "authentication-state", state: "unknown" },
  );
  assert.equal(
    observations[1],
    `${WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.claude}:unknown`,
  );

  const prepared = accepted(
    await coordinator.request({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
      action: "logout",
    }),
  ) as { readonly preparationKey: string };
  assert.deepEqual(
    accepted(
      await coordinator.request({ preparationKey: prepared.preparationKey }),
    ),
    { kind: "authentication-action-requested", action: "logout" },
  );
  // The launch alone teaches nothing: the sign-in run ends only once the
  // completed logout reports the state it left behind.
  assert.equal(observations.length, 2);

  completion.resolve({
    endpointId: "codex-desktop",
    action: "logout",
    effect: "finished",
    request: "started",
    authentication: "sign-in-required",
  });
  await tick();
  assert.deepEqual(observations, [
    `${WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex}:bound`,
    `${WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.claude}:unknown`,
    `${WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex}:sign-in-required`,
  ]);
  await coordinator.close();
});

test("F116 a coordinator built without the observation feed behaves exactly as before", async () => {
  const completion = deferred<{
    readonly endpointId: "codex-desktop";
    readonly action: "logout";
    readonly effect: "finished";
    readonly request: "started";
    readonly authentication: "sign-in-required";
  }>();
  const coordinator = createWorkbenchSubscriptionAuthenticationCoordinator({
    endpoints: endpointDefinitions(),
    authentication: observationFeedAuthentication(completion.promise),
    // No `observe` member at all: the shape every authority had before F116.
    mutations: observationFeedMutations(),
  });

  assert.deepEqual(
    accepted(
      await coordinator.request({
        endpointSelectionKey:
          WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
      }),
    ),
    { kind: "authentication-state", state: "bound" },
  );
  const prepared = accepted(
    await coordinator.request({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
      action: "logout",
    }),
  ) as { readonly preparationKey: string };
  assert.deepEqual(
    accepted(
      await coordinator.request({ preparationKey: prepared.preparationKey }),
    ),
    { kind: "authentication-action-requested", action: "logout" },
  );
  completion.resolve({
    endpointId: "codex-desktop",
    action: "logout",
    effect: "finished",
    request: "started",
    authentication: "sign-in-required",
  });
  await tick();
  assert.equal(coordinator.renderSettings().cards[0].outcome, "requested");
  await coordinator.close();
});

test("F116 an observation feed that throws or rejects never disturbs the action it observed", async () => {
  const completion = deferred<{
    readonly endpointId: "codex-desktop";
    readonly action: "logout";
    readonly effect: "finished";
    readonly request: "started";
    readonly authentication: "sign-in-required";
  }>();
  const coordinator = createWorkbenchSubscriptionAuthenticationCoordinator({
    endpoints: endpointDefinitions(),
    authentication: observationFeedAuthentication(completion.promise),
    mutations: {
      ...observationFeedMutations(),
      observe(request: { readonly state: string }) {
        if (request.state === "bound") {
          throw new Error("controlled-observation-failure");
        }
        return Promise.reject(new Error("controlled-observation-rejection"));
      },
    },
  });

  assert.deepEqual(
    accepted(
      await coordinator.request({
        endpointSelectionKey:
          WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
      }),
    ),
    { kind: "authentication-state", state: "bound" },
  );
  const prepared = accepted(
    await coordinator.request({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
      action: "logout",
    }),
  ) as { readonly preparationKey: string };
  assert.deepEqual(
    accepted(
      await coordinator.request({ preparationKey: prepared.preparationKey }),
    ),
    { kind: "authentication-action-requested", action: "logout" },
  );
  completion.resolve({
    endpointId: "codex-desktop",
    action: "logout",
    effect: "finished",
    request: "started",
    authentication: "sign-in-required",
  });
  await tick();
  assert.equal(coordinator.renderSettings().cards[0].outcome, "requested");
  await coordinator.close();
});

test("F116 the shipped work-ledger authority carries each observation to the durable module", async () => {
  const observed: string[] = [];
  const completion = deferred<{
    readonly endpointId: "codex-desktop";
    readonly action: "logout";
    readonly effect: "finished";
    readonly request: "started";
    readonly authentication: "sign-in-required";
  }>();
  const authGeneration = {
    captureRuntimeEndpointAuthGenerationSnapshot: () => undefined,
    captureForAcceptedCommand: () => undefined,
    isNativeResumeEligible: () => false,
    isSessionNativeResumable: () => false,
    prepareAuthenticationMutation: () =>
      Object.freeze({
        kind: "ready" as const,
        preparationKey: "auth-preparation-v1-controlled",
      }),
    beginAuthenticationMutation: () =>
      Object.freeze({
        kind: "begun" as const,
        endpointId: "codex-desktop" as const,
        action: "logout" as const,
      }),
    cancelAuthenticationMutation: () => true,
    observeEndpointAuthentication(request: {
      readonly endpointId: "codex-desktop" | "claude-code-desktop";
      readonly state: "bound" | "sign-in-required" | "unknown";
    }) {
      observed.push(`${request.endpointId}:${request.state}`);
      return true;
    },
    captureAccountObservation: () => undefined,
    classifySessionAccountObservation: () => "not-comparable" as const,
  } satisfies WorkLedgerAuthGenerationModule;
  const coordinator = createWorkbenchSubscriptionAuthenticationCoordinator({
    endpoints: endpointDefinitions(),
    authentication: observationFeedAuthentication(completion.promise),
    // The exact authority the packaged Workbench composes in electron/main.
    mutations: createWorkLedgerSubscriptionAuthenticationMutationAuthority({
      authGeneration,
      endpointSelections: new Map([
        [
          WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
          "codex-desktop" as const,
        ],
        [
          WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.claude,
          "claude-code-desktop" as const,
        ],
      ]),
    }),
  });

  accepted(
    await coordinator.request({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
    }),
  );
  const prepared = accepted(
    await coordinator.request({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
      action: "logout",
    }),
  ) as { readonly preparationKey: string };
  accepted(
    await coordinator.request({ preparationKey: prepared.preparationKey }),
  );
  completion.resolve({
    endpointId: "codex-desktop",
    action: "logout",
    effect: "finished",
    request: "started",
    authentication: "sign-in-required",
  });
  await tick();

  // Durable endpoint ids, never selection keys, reach the ledger module.
  assert.deepEqual(observed, [
    "codex-desktop:bound",
    "codex-desktop:sign-in-required",
  ]);
  await coordinator.close();
});

/** The smallest authentication service that can drive one full logout cycle. */
function observationFeedAuthentication(
  completion: Promise<{
    readonly endpointId: "codex-desktop";
    readonly action: "logout";
    readonly effect: "finished";
    readonly request: "started";
    readonly authentication: "sign-in-required";
  }>,
) {
  return {
    async inspect(endpointId: "codex-desktop" | "claude-code-desktop") {
      return {
        endpointId,
        authentication:
          endpointId === "codex-desktop"
            ? ("bound" as const)
            : ("unknown" as const),
      };
    },
    async startAction(
      endpointId: "codex-desktop" | "claude-code-desktop",
      action: "login" | "logout",
    ) {
      assert.equal(endpointId, "codex-desktop");
      assert.equal(action, "logout");
      return {
        endpointId,
        action,
        request: "started" as const,
        completion,
      };
    },
    async close() {},
  };
}

/** A mutation authority that commits, so only the observation feed varies. */
function observationFeedMutations() {
  return {
    prepare() {
      return { kind: "ready" as const, preparationKey: "opaque-f116-01" };
    },
    begin() {
      return {
        kind: "begun" as const,
        endpointSelectionKey:
          WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
        action: "logout" as const,
      };
    },
    cancel() {
      return true;
    },
  };
}

/**
 * A controlled stand-in for the work-ledger auth generation: it records every
 * commit attempt, so a test can prove the durable rotation was never reached,
 * and it keeps one resumable Session whose resumability is gated on the
 * generation exactly as the durable module gates it.
 */
function controlledGenerationWorld(events: string[]) {
  const commits: string[] = [];
  let generation: string | null = null;
  let failCommit = false;
  let blockAuthorization = false;
  let issued = 0;
  return {
    commits,
    failNextCommit() {
      failCommit = true;
    },
    blockNextAuthorization() {
      blockAuthorization = true;
    },
    mutations: {
      prepare() {
        issued += 1;
        return {
          kind: "ready" as const,
          preparationKey: `opaque-f115-${issued}`,
        };
      },
      authorize() {
        if (blockAuthorization) {
          return {
            kind: "blocked" as const,
            blockers: Object.freeze({
              accepted: 0,
              starting: 0,
              inFlight: 1,
              recoveryRequired: 0,
              unknown: 0,
            }),
          };
        }
        return { kind: "authorized" as const };
      },
      begin() {
        events.push("commit-attempt");
        if (failCommit) return { kind: "persistence-failed" as const };
        generation = `auth-generation-${commits.length + 1}`;
        commits.push(generation);
        return {
          kind: "begun" as const,
          endpointSelectionKey:
            WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
          action: "logout" as const,
        };
      },
      cancel() {
        events.push("cancel-preparation");
        return true;
      },
      attemptNativeResume() {
        // The Session was recorded before any rotation, so it stays resumable
        // for exactly as long as the endpoint has not been rotated.
        return {
          nativeResumeRequested: generation === null,
          transcript: Object.freeze(["recorded message", "recorded response"]),
        };
      },
    },
  };
}

function endpointDefinitions() {
  return Object.freeze([
    Object.freeze({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
      endpointId: "codex-desktop" as const,
      label: "Codex" as const,
    }),
    Object.freeze({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.claude,
      endpointId: "claude-code-desktop" as const,
      label: "Claude" as const,
    }),
  ] as const);
}

function inertProvider(
  endpointId: "codex-desktop" | "claude-code-desktop",
): SubscriptionAuthenticationProvider {
  return Object.freeze({
    endpointId,
    async launchLogin() {
      throw new Error("unused-controlled-action");
    },
    async launchLogout() {
      throw new Error("unused-controlled-action");
    },
    async inspectAuthentication() {
      return "unknown" as const;
    },
  });
}

function unusedMutations() {
  return Object.freeze({
    prepare() {
      return {
        kind: "blocked" as const,
        blockers: Object.freeze({
          accepted: 0,
          starting: 0,
          inFlight: 0,
          recoveryRequired: 0,
          unknown: 1,
        }),
      };
    },
    begin() {
      return { kind: "rejected" as const };
    },
    cancel() {
      return false;
    },
  });
}

function accepted<Value>(result: {
  readonly accepted: boolean;
  readonly value?: Value;
}): Value {
  assert.equal(result.accepted, true);
  if (!result.accepted || result.value === undefined) {
    throw new Error("controlled-boundary-rejected");
  }
  return result.value;
}

function controlledChild() {
  const finished = deferred<void>();
  let terminationCount = 0;
  return Object.freeze({
    finished: finished.promise,
    finish: () => finished.resolve(undefined),
    terminateCalls: () => terminationCount,
    async terminate() {
      terminationCount += 1;
      finished.resolve(undefined);
    },
  });
}

function controlledScheduler(): SubscriptionAuthenticationScheduler & {
  fire(milliseconds: number): void;
} {
  let nextHandle = 0;
  const callbacks = new Map<
    number,
    Readonly<{ callback: () => void; milliseconds: number }>
  >();
  return Object.freeze({
    setTimeout(callback: () => void, milliseconds: number) {
      nextHandle += 1;
      callbacks.set(nextHandle, Object.freeze({ callback, milliseconds }));
      return nextHandle;
    },
    clearTimeout(handle: unknown) {
      if (typeof handle === "number") callbacks.delete(handle);
    },
    fire(milliseconds: number) {
      const entry = [...callbacks].find(
        ([, timeout]) => timeout.milliseconds === milliseconds,
      );
      assert.notEqual(entry, undefined, `controlled-timeout-${milliseconds}-missing`);
      if (entry === undefined) return;
      callbacks.delete(entry[0]);
      entry[1].callback();
    },
  });
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => {
    resolve = accept;
  });
  return Object.freeze({ promise, resolve });
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
