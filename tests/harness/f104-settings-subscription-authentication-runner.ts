import assert from "node:assert/strict";

import {
  ControlledEventLog,
  ControlledGenerationStore,
  ControlledNativeProviderTransport,
  ControlledOpaqueKeySource,
  ControlledProjectRegistry,
  ControlledScheduler,
  ControlledTranscriptStore,
  F104_BLOCKER_LABELS,
  F104_COPY,
  F104_FORBIDDEN_PUBLIC_FIELDS,
  F104_PROVIDER_CASES,
  F104_SETTINGS_SELECTORS,
  type F104AcceptanceFactory,
  type F104AcceptanceSubject,
  type F104AuthenticationAction,
  type F104AuthenticationState,
  type F104BlockerCounts,
  type F104BoundaryResult,
  type F104CatalogLabel,
  type F104EndpointGenerationRecord,
  type F104Provider,
  type F104ProviderAdapter,
  type F104PublicResponse,
  type F104RegisteredProject,
  type F104RenderedSettings,
  type F104SessionGeneration,
} from "./f104-settings-subscription-authentication-acceptance.ts";

export type F104AcceptanceObservation = Readonly<{
  id: string;
  status: "passed" | "failed";
  category: "assertion-failed" | null;
}>;

export type F104AcceptanceReport = Readonly<{
  schema: "f104-settings-subscription-authentication-acceptance-v1";
  providers: readonly ["Codex", "Claude"];
  observations: readonly F104AcceptanceObservation[];
  providerSpend: Readonly<{ codex: 0; claude: 0 }>;
  liveProviderActions: 0;
  browserActions: 0;
}>;

type Scenario = Readonly<{
  events: ControlledEventLog;
  transports: ReadonlyMap<F104Provider, ControlledNativeProviderTransport>;
  schedulers: ReadonlyMap<F104Provider, ControlledScheduler>;
  adapters: ReadonlyMap<string, F104ProviderAdapter>;
  registry: ControlledProjectRegistry;
  generations: ControlledGenerationStore;
  transcripts: ControlledTranscriptStore;
  opaqueKeys: ControlledOpaqueKeySource;
  subject: F104AcceptanceSubject;
}>;

type CycleResult = Readonly<{
  initial: F104PublicResponse;
  initialRender: F104RenderedSettings;
  logoutPreparation: F104PublicResponse;
  logoutBegin: F104PublicResponse;
  midLogoutRender: F104RenderedSettings;
  replayRejected: boolean;
  duplicatePreparationRejected: boolean;
  preInspectionRender: F104RenderedSettings;
  signedOut: F104PublicResponse;
  signedOutRender: F104RenderedSettings;
  loginPreparation: F104PublicResponse;
  loginBegin: F104PublicResponse;
  finalState: F104PublicResponse;
  finalRender: F104RenderedSettings;
  events: readonly string[];
  generations: readonly string[];
  officialActions: readonly F104AuthenticationAction[];
}>;

class ObservationRecorder {
  readonly observations: F104AcceptanceObservation[] = [];

  async observe(id: string, assertion: () => void | Promise<void>): Promise<void> {
    try {
      await assertion();
      this.observations.push(
        Object.freeze({ id, status: "passed", category: null }),
      );
    } catch {
      this.observations.push(
        Object.freeze({
          id,
          status: "failed",
          category: "assertion-failed",
        }),
      );
    }
  }
}

export async function runF104SettingsSubscriptionAuthenticationAcceptance(
  factory: F104AcceptanceFactory,
): Promise<F104AcceptanceReport> {
  const recorder = new ObservationRecorder();
  await runProviderAdapterMatrix(factory, recorder);
  await runProviderCycles(factory, recorder);
  await runCrossProjectGuardMatrix(factory, recorder);
  await runGenerationAndResumeMatrix(factory, recorder);
  await runSupersessionMatrix(factory, recorder);
  await runPublicBoundaryMatrix(factory, recorder);
  await runRenderedSettingsMatrix(factory, recorder);
  return Object.freeze({
    schema: "f104-settings-subscription-authentication-acceptance-v1",
    providers: Object.freeze(["Codex", "Claude"] as const),
    observations: Object.freeze([...recorder.observations]),
    providerSpend: Object.freeze({ codex: 0, claude: 0 }),
    liveProviderActions: 0,
    browserActions: 0,
  });
}

export function assertF104AcceptanceReport(
  report: F104AcceptanceReport,
): void {
  assert.equal(
    report.schema,
    "f104-settings-subscription-authentication-acceptance-v1",
  );
  assert.deepEqual(report.providers, ["Codex", "Claude"]);
  assert.ok(report.observations.length >= 180);
  assert.equal(
    new Set(report.observations.map((observation) => observation.id)).size,
    report.observations.length,
  );
  assert.deepEqual(
    report.observations.filter((observation) => observation.status === "failed"),
    [],
  );
  assert.deepEqual(report.providerSpend, { codex: 0, claude: 0 });
  assert.equal(report.liveProviderActions, 0);
  assert.equal(report.browserActions, 0);
}

async function runProviderAdapterMatrix(
  factory: F104AcceptanceFactory,
  recorder: ObservationRecorder,
): Promise<void> {
  for (const providerCase of F104_PROVIDER_CASES) {
    const fixture = factory.providerFixture(providerCase.provider);
    await recorder.observe(
      `${providerCase.provider}.adapter.invalid-consumed-categories-complete`,
      () => {
        assert.deepEqual(
          fixture.invalidConsumed.map((entry) => entry.category).sort(),
          ["contradictory", "missing", "unknown-literal", "wrong-type"],
        );
      },
    );

    for (const [name, nativeValue, expected] of [
      ["recognized-bound", fixture.recognizedBound, "bound"],
      [
        "recognized-sign-in-required",
        fixture.recognizedSignInRequired,
        "sign-in-required",
      ],
    ] as const) {
      await recorder.observe(
        `${providerCase.provider}.adapter.${name}`,
        async () => {
          const probe = providerProbe(factory, providerCase.provider);
          probe.transport.queueStatus(nativeValue);
          assert.equal(await probe.adapter.inspectAuthentication(), expected);
        },
      );
      await recorder.observe(
        `${providerCase.provider}.adapter.${name}.unrelated-native-extras-discarded`,
        async () => {
          const probe = providerProbe(factory, providerCase.provider);
          probe.transport.queueStatus(
            withUnrelatedNativeExtras(nativeValue),
          );
          assert.equal(await probe.adapter.inspectAuthentication(), expected);
        },
      );
    }

    for (const invalid of fixture.invalidConsumed) {
      await recorder.observe(
        `${providerCase.provider}.adapter.consumed-${invalid.category}-is-unknown`,
        async () => {
          const probe = providerProbe(factory, providerCase.provider);
          probe.transport.queueStatus(invalid.value);
          assert.equal(await probe.adapter.inspectAuthentication(), "unknown");
        },
      );
    }

    for (const [name, value] of [
      ["null-top-level", null],
      ["array-top-level", []],
      ["non-json-prose", "controlled non-json status"],
    ] as const) {
      await recorder.observe(
        `${providerCase.provider}.adapter.${name}-is-unknown`,
        async () => {
          const probe = providerProbe(factory, providerCase.provider);
          probe.transport.queueStatus(value);
          assert.equal(await probe.adapter.inspectAuthentication(), "unknown");
        },
      );
    }

    await recorder.observe(
      `${providerCase.provider}.adapter.status-failure-is-unknown`,
      async () => {
        const probe = providerProbe(factory, providerCase.provider);
        probe.transport.queueStatusFailure();
        assert.equal(await probe.adapter.inspectAuthentication(), "unknown");
      },
    );
    await recorder.observe(
      `${providerCase.provider}.adapter.status-timeout-is-unknown`,
      async () => {
        const probe = providerProbe(factory, providerCase.provider);
        probe.transport.queuePendingStatus();
        const inspection = probe.adapter.inspectAuthentication();
        await tick();
        probe.scheduler.fireNext();
        assert.equal(await inspection, "unknown");
      },
    );

    for (const action of ["logout", "login"] as const) {
      await recorder.observe(
        `${providerCase.provider}.adapter.official-${action}-requested-only`,
        async () => {
          const probe = providerProbe(factory, providerCase.provider);
          const child = await probe.adapter.launchOfficialAction(action);
          assert.deepEqual(probe.transport.officialActionRequests, [action]);
          assert.equal(probe.transport.children[0], child);
          child.exit(0);
        },
      );
    }
  }
}

async function runProviderCycles(
  factory: F104AcceptanceFactory,
  recorder: ObservationRecorder,
): Promise<void> {
  const checks: readonly Readonly<{
    id: string;
    assertCycle: (cycle: CycleResult, provider: F104Provider) => void;
  }>[] = [
    {
      id: "initial-bound",
      assertCycle(cycle) {
        assert.deepEqual(cycle.initial, {
          kind: "authentication-state",
          state: "bound",
        });
      },
    },
    {
      id: "bound-card-log-out",
      assertCycle(cycle, provider) {
        assert.deepEqual(cardFor(cycle.initialRender, provider).actions, [
          { label: F104_COPY.boundAction, disabled: false },
        ]);
      },
    },
    {
      id: "logout-preparation-ready",
      assertCycle(cycle) {
        assert.equal(cycle.logoutPreparation.kind, "ready");
      },
    },
    {
      id: "official-logout-before-generation",
      assertCycle(cycle, provider) {
        // F115: the irreversible generation rotation is committed only after
        // the fallible provider launch has succeeded, so a launch that never
        // happens can never leave a rotated generation behind.
        const endpoint = providerCaseFor(provider).endpointSelectionKey;
        assert.ok(
          cycle.events.indexOf(`generation-commit:${endpoint}`) >= 0,
        );
        assert.ok(
          cycle.events.indexOf(`official-action:${provider}:logout`) <
            cycle.events.indexOf(`generation-commit:${endpoint}`),
        );
      },
    },
    {
      id: "official-logout-requested",
      assertCycle(cycle) {
        assert.deepEqual(cycle.logoutBegin, {
          kind: "authentication-action-requested",
          action: "logout",
        });
        assert.equal(cycle.officialActions[0], "logout");
      },
    },
    {
      id: "honest-mid-logout-state",
      assertCycle(cycle, provider) {
        const card = cardFor(cycle.midLogoutRender, provider);
        assert.deepEqual(card.actions, [
          { label: F104_COPY.boundAction, disabled: true },
        ]);
        assert.equal(card.feedback, F104_COPY.logoutRequested);
        assert.equal(JSON.stringify(card).includes("success"), false);
      },
    },
    {
      id: "duplicate-action-contained",
      assertCycle(cycle) {
        assert.equal(cycle.replayRejected, true);
        assert.equal(cycle.duplicatePreparationRejected, true);
        assert.deepEqual(cycle.officialActions, ["logout", "login"]);
        assert.equal(cycle.generations.length, 2);
      },
    },
    {
      id: "native-exit-zero-not-logout-success",
      assertCycle(cycle, provider) {
        const card = cardFor(cycle.preInspectionRender, provider);
        assert.equal(card.authentication, "Bound");
        assert.equal(JSON.stringify(card).includes("success"), false);
      },
    },
    {
      id: "fresh-sign-in-required",
      assertCycle(cycle) {
        assert.deepEqual(cycle.signedOut, {
          kind: "authentication-state",
          state: "sign-in-required",
        });
      },
    },
    {
      id: "signed-out-card-login",
      assertCycle(cycle, provider) {
        assert.deepEqual(cardFor(cycle.signedOutRender, provider).actions, [
          { label: F104_COPY.signedOutAction, disabled: false },
        ]);
      },
    },
    {
      id: "login-preparation-ready",
      assertCycle(cycle) {
        assert.equal(cycle.loginPreparation.kind, "ready");
      },
    },
    {
      id: "official-login-requested",
      assertCycle(cycle) {
        assert.deepEqual(cycle.loginBegin, {
          kind: "authentication-action-requested",
          action: "login",
        });
        assert.equal(cycle.officialActions[1], "login");
      },
    },
    {
      id: "primary-fresh-post-login-bound",
      assertCycle(cycle, provider) {
        assert.deepEqual(cycle.finalState, {
          kind: "authentication-state",
          state: "bound",
        });
        assert.equal(cardFor(cycle.finalRender, provider).authentication, "Bound");
      },
    },
  ];

  for (const providerCase of F104_PROVIDER_CASES) {
    for (const check of checks) {
      await recorder.observe(
        `${providerCase.provider}.cycle.${check.id}`,
        async () => {
          const cycle = await runCompleteCycle(
            factory,
            providerCase.provider,
            "bound",
          );
          check.assertCycle(cycle, providerCase.provider);
        },
      );
    }

    for (const finalState of [
      "bound",
      "sign-in-required",
      "unknown",
    ] as const) {
      await recorder.observe(
        `${providerCase.provider}.cycle.fresh-post-login-${finalState}`,
        async () => {
          const cycle = await runCompleteCycle(
            factory,
            providerCase.provider,
            finalState,
          );
          assert.deepEqual(cycle.finalState, {
            kind: "authentication-state",
            state: finalState,
          });
          assert.equal(
            cardFor(cycle.finalRender, providerCase.provider).authentication,
            authLabel(finalState),
          );
        },
      );
    }

    await recorder.observe(
      `${providerCase.provider}.cycle.nonzero-logout-child-fresh-sign-in-required`,
      async () => {
        const cycle = await runCompleteCycle(
          factory,
          providerCase.provider,
          "bound",
          7,
        );
        assert.deepEqual(cycle.signedOut, {
          kind: "authentication-state",
          state: "sign-in-required",
        });
        assert.equal(
          JSON.stringify(cycle.signedOutRender).includes("success"),
          false,
        );
      },
    );

    await recorder.observe(
      `${providerCase.provider}.cycle.zero-logout-child-fresh-bound-remains-bound`,
      async () => {
        const scenario = await createScenario(factory);
        try {
          await establishAuthentication(
            factory,
            scenario,
            providerCase.provider,
            "bound",
          );
          const preparation = await prepare(
            scenario,
            providerCase.provider,
            "logout",
          );
          const key = preparationKey(preparation);
          await begin(scenario, key);
          transportFor(scenario, providerCase.provider).children[0]?.exit(0);
          await tick();
          const fresh = await establishAuthentication(
            factory,
            scenario,
            providerCase.provider,
            "bound",
          );
          assert.deepEqual(fresh, {
            kind: "authentication-state",
            state: "bound",
          });
          assert.equal(
            JSON.stringify(await scenario.subject.renderSettings()).includes(
              "success",
            ),
            false,
          );
        } finally {
          await scenario.subject.close();
        }
      },
    );

    await recorder.observe(
      `${providerCase.provider}.cycle.zero-login-child-fresh-unknown`,
      async () => {
        const cycle = await runCompleteCycle(
          factory,
          providerCase.provider,
          "unknown",
          0,
          0,
        );
        assert.deepEqual(cycle.finalState, {
          kind: "authentication-state",
          state: "unknown",
        });
        assert.equal(
          JSON.stringify(cycle.finalRender).includes("Login successful"),
          false,
        );
      },
    );
  }
}

async function runCrossProjectGuardMatrix(
  factory: F104AcceptanceFactory,
  recorder: ObservationRecorder,
): Promise<void> {
  const blockerRows: readonly Readonly<{
    activity: "accepted" | "starting" | "in-flight" | "recovery-required";
    publicKey: keyof F104BlockerCounts;
  }>[] = [
    { activity: "accepted", publicKey: "accepted" },
    { activity: "starting", publicKey: "starting" },
    { activity: "in-flight", publicKey: "inFlight" },
    { activity: "recovery-required", publicKey: "recoveryRequired" },
  ];
  for (const blocker of blockerRows) {
    await recorder.observe(`guard.blocker.${blocker.activity}`, async () => {
      const scenario = await createScenario(factory);
      try {
        const endpoint = F104_PROVIDER_CASES[0].endpointSelectionKey;
        scenario.registry.replace([
          project("project-01", true, [
            guardSession("session-01", endpoint, blocker.activity, false),
          ]),
        ]);
        await establishAuthentication(factory, scenario, "codex", "bound");
        const result = await prepare(scenario, "codex", "logout");
        assert.deepEqual(result, {
          kind: "blocked",
          blockers: {
            accepted: blocker.publicKey === "accepted" ? 1 : 0,
            starting: blocker.publicKey === "starting" ? 1 : 0,
            inFlight: blocker.publicKey === "inFlight" ? 1 : 0,
            recoveryRequired:
              blocker.publicKey === "recoveryRequired" ? 1 : 0,
            unknown: 0,
          },
        });
        assert.equal(
          transportFor(scenario, "codex").officialActionRequests.length,
          0,
        );
      } finally {
        await scenario.subject.close();
      }
    });
  }

  await recorder.observe("guard.blocker.unknown-activity", async () => {
    const scenario = await createScenario(factory);
    try {
      const endpoint = F104_PROVIDER_CASES[0].endpointSelectionKey;
      scenario.registry.replace([
        project("project-01", true, [
          guardSession("session-01", endpoint, "unknown", false),
        ]),
      ]);
      await establishAuthentication(factory, scenario, "codex", "bound");
      const result = await prepare(scenario, "codex", "logout");
      assert.equal(result.kind, "blocked");
      assert.equal(result.kind === "blocked" && result.blockers.unknown, 1);
    } finally {
      await scenario.subject.close();
    }
  });

  await recorder.observe("guard.blocker.unknown-membership", async () => {
    const scenario = await createScenario(factory);
    try {
      scenario.registry.replace([
        project("project-01", true, [
          guardSession("session-01", "unknown", "terminal", true),
        ]),
      ]);
      await establishAuthentication(factory, scenario, "codex", "bound");
      const result = await prepare(scenario, "codex", "logout");
      assert.equal(result.kind, "blocked");
      assert.equal(result.kind === "blocked" && result.blockers.unknown, 1);
    } finally {
      await scenario.subject.close();
    }
  });

  await recorder.observe("guard.blocker.unreadable-registry", async () => {
    const scenario = await createScenario(factory);
    try {
      scenario.registry.makeUnreadable();
      await establishAuthentication(factory, scenario, "codex", "bound");
      const result = await prepare(scenario, "codex", "logout");
      assert.equal(result.kind, "blocked");
      assert.equal(result.kind === "blocked" && result.blockers.unknown, 1);
    } finally {
      await scenario.subject.close();
    }
  });

  await recorder.observe(
    "guard.all-registered-projects-selected-clear-other-in-flight",
    async () => {
      const scenario = await createScenario(factory);
      try {
        const endpoint = F104_PROVIDER_CASES[0].endpointSelectionKey;
        scenario.registry.replace([
          project("selected-project", true, []),
          project("other-project", false, [
            guardSession("session-other", endpoint, "in-flight", false),
          ]),
        ]);
        await establishAuthentication(factory, scenario, "codex", "bound");
        const result = await prepare(scenario, "codex", "logout");
        assert.equal(result.kind, "blocked");
        assert.equal(result.kind === "blocked" && result.blockers.inFlight, 1);
        assert.equal(
          transportFor(scenario, "codex").officialActionRequests.length,
          0,
        );
      } finally {
        await scenario.subject.close();
      }
    },
  );

  await recorder.observe(
    "guard.blocker-precedes-terminal-resumable-confirmation",
    async () => {
      const scenario = await createScenario(factory);
      try {
        const endpoint = F104_PROVIDER_CASES[0].endpointSelectionKey;
        scenario.registry.replace([
          project("project-01", true, [
            guardSession("terminal", endpoint, "terminal", true),
            guardSession(
              "recovery",
              endpoint,
              "recovery-required",
              false,
            ),
          ]),
        ]);
        await establishAuthentication(factory, scenario, "codex", "bound");
        const result = await prepare(scenario, "codex", "logout");
        assert.equal(result.kind, "blocked");
        assert.equal(
          result.kind === "blocked" && result.blockers.recoveryRequired,
          1,
        );
      } finally {
        await scenario.subject.close();
      }
    },
  );

  await recorder.observe(
    "guard.terminal-resumable-inline-confirmation-counts",
    async () => {
      const scenario = await terminalConsequenceScenario(factory, "bound");
      try {
        const result = await prepare(scenario, "codex", "logout");
        assert.equal(result.kind, "confirmation-required");
        assert.deepEqual(
          result.kind === "confirmation-required"
            ? result.consequences
            : undefined,
          { resumableSessionCount: 2, projectCount: 2 },
        );
        const card = cardFor(await scenario.subject.renderSettings(), "codex");
        assert.deepEqual(card.confirmation, {
          statement: F104_COPY.consequence,
          resumableSessionCount: 2,
          projectCount: 2,
          actions: [
            { label: F104_COPY.confirmLogout, disabled: false },
            { label: F104_COPY.cancel, disabled: false },
          ],
        });
      } finally {
        await scenario.subject.close();
      }
    },
  );

  await recorder.observe(
    "guard.terminal-resumable-cancel-has-no-effect",
    async () => {
      const scenario = await terminalConsequenceScenario(factory, "bound");
      try {
        const result = await prepare(scenario, "codex", "logout");
        const key = preparationKey(result);
        assert.equal(await scenario.subject.cancelPreparation(key), true);
        assert.equal(scenario.generations.commits.length, 0);
        assert.equal(
          transportFor(scenario, "codex").officialActionRequests.length,
          0,
        );
        const card = cardFor(await scenario.subject.renderSettings(), "codex");
        assert.equal(card.authentication, "Bound");
        assert.equal(card.confirmation, null);
      } finally {
        await scenario.subject.close();
      }
    },
  );

  await recorder.observe(
    "guard.terminal-resumable-confirmation-can-begin",
    async () => {
      const scenario = await terminalConsequenceScenario(factory, "bound");
      try {
        const result = await prepare(scenario, "codex", "logout");
        assert.deepEqual(await begin(scenario, preparationKey(result)), {
          kind: "authentication-action-requested",
          action: "logout",
        });
      } finally {
        await scenario.subject.close();
      }
    },
  );

  await recorder.observe(
    "guard.login-has-same-terminal-resumable-consequence-gate",
    async () => {
      const scenario = await terminalConsequenceScenario(
        factory,
        "sign-in-required",
      );
      try {
        const result = await prepare(scenario, "codex", "login");
        assert.equal(result.kind, "confirmation-required");
        assert.deepEqual(
          result.kind === "confirmation-required"
            ? result.consequences
            : undefined,
          { resumableSessionCount: 2, projectCount: 2 },
        );
      } finally {
        await scenario.subject.close();
      }
    },
  );

  await recorder.observe(
    "guard.begin-recheck-rejects-newly-accepted-command",
    async () => {
      const scenario = await createScenario(factory);
      try {
        const endpoint = F104_PROVIDER_CASES[0].endpointSelectionKey;
        await establishAuthentication(factory, scenario, "codex", "bound");
        const ready = await prepare(scenario, "codex", "logout");
        scenario.registry.replace([
          project("project-01", true, [
            guardSession("new-command", endpoint, "accepted", false),
          ]),
        ]);
        const begun = await scenario.subject.request({
          preparationKey: preparationKey(ready),
        });
        assert.deepEqual(begun, { accepted: false });
        assert.equal(scenario.generations.commits.length, 0);
        assert.equal(
          transportFor(scenario, "codex").officialActionRequests.length,
          0,
        );
      } finally {
        await scenario.subject.close();
      }
    },
  );

  await recorder.observe(
    "guard.terminal-already-non-resumable-is-ready",
    async () => {
      const scenario = await createScenario(factory);
      try {
        const endpoint = F104_PROVIDER_CASES[0].endpointSelectionKey;
        scenario.registry.replace([
          project("project-01", true, [
            guardSession("terminal", endpoint, "terminal", false),
          ]),
        ]);
        await establishAuthentication(factory, scenario, "codex", "bound");
        assert.equal(
          (await prepare(scenario, "codex", "logout")).kind,
          "ready",
        );
      } finally {
        await scenario.subject.close();
      }
    },
  );

  await recorder.observe(
    "guard.begin-recheck-requires-fresh-confirmation-for-new-consequence",
    async () => {
      const scenario = await createScenario(factory);
      try {
        const endpoint = F104_PROVIDER_CASES[0].endpointSelectionKey;
        await establishAuthentication(factory, scenario, "codex", "bound");
        const ready = await prepare(scenario, "codex", "logout");
        scenario.registry.replace([
          project("project-01", true, [
            guardSession("new-terminal", endpoint, "terminal", true),
          ]),
        ]);
        assert.deepEqual(
          await scenario.subject.request({
            preparationKey: preparationKey(ready),
          }),
          { accepted: false },
        );
        assert.equal(scenario.generations.commits.length, 0);
        assert.equal(
          transportFor(scenario, "codex").officialActionRequests.length,
          0,
        );
        const fresh = await prepare(scenario, "codex", "logout");
        assert.equal(fresh.kind, "confirmation-required");
      } finally {
        await scenario.subject.close();
      }
    },
  );
}

async function runGenerationAndResumeMatrix(
  factory: F104AcceptanceFactory,
  recorder: ObservationRecorder,
): Promise<void> {
  await recorder.observe(
    "generation.commit-failure-after-launch-reports-partial-not-failure",
    async () => {
      const scenario = await createScenario(factory);
      try {
        await establishAuthentication(factory, scenario, "codex", "bound");
        const ready = await prepare(scenario, "codex", "logout");
        scenario.generations.failNextCommit();
        // F115: the provider CLI was asked to log out before the rotation was
        // attempted, so this outcome may never claim nothing happened — and it
        // may not claim the rotation succeeded either, so it crosses the public
        // seam as its own kind rather than as the requested one.
        assert.deepEqual(await begin(scenario, preparationKey(ready)), {
          kind: "authentication-action-partially-completed",
          action: "logout",
        });
        assert.equal(scenario.generations.commits.length, 0);
        assert.equal(
          transportFor(scenario, "codex").officialActionRequests.length,
          1,
        );
        const feedback = cardFor(
          await scenario.subject.renderSettings(),
          "codex",
        ).feedback;
        assert.equal(feedback, F104_COPY.logoutPartiallyCompleted);
        assert.notEqual(feedback, F104_COPY.logoutNotRequested);
        assert.notEqual(feedback, F104_COPY.logoutRequested);
        assert.match(feedback ?? "", /can no longer be resumed/u);
      } finally {
        await scenario.subject.close();
      }
    },
  );

  await recorder.observe(
    "generation.launch-failure-leaves-generation-and-resume-untouched",
    async () => {
      const scenario = await createScenario(factory);
      try {
        const endpoint = F104_PROVIDER_CASES[0].endpointSelectionKey;
        await establishAuthentication(factory, scenario, "codex", "bound");
        scenario.transcripts.set({
          sessionControlKey: "session-control-01",
          endpointSelectionKey: endpoint,
          generation: { kind: "missing" },
          preF104ResumeEligible: true,
          transcript: ["recorded message", "recorded response"],
        });
        const ready = await prepare(scenario, "codex", "logout");
        transportFor(scenario, "codex").failNextLaunch();
        assert.deepEqual(await begin(scenario, preparationKey(ready)), {
          kind: "authentication-action-not-requested",
          action: "logout",
        });
        // F115: reporting "not requested" is a promise that nothing was lost,
        // so the generation must be untouched and the Session still resumable.
        assert.equal(scenario.generations.commits.length, 0);
        const resume = await scenario.subject.attemptNativeResume(
          "session-control-01",
        );
        assert.deepEqual(resume, {
          nativeResumeRequested: true,
          transcript: ["recorded message", "recorded response"],
        });
        assert.equal(
          JSON.stringify(await scenario.subject.renderSettings()).includes(
            "success",
          ),
          false,
        );
        assert.equal(
          cardFor(await scenario.subject.renderSettings(), "codex").feedback,
          F104_COPY.logoutNotRequested,
        );
      } finally {
        await scenario.subject.close();
      }
    },
  );

  await recorder.observe(
    "generation.every-action-begin-is-fresh-including-retry",
    async () => {
      const scenario = await createScenario(factory);
      try {
        await establishAuthentication(factory, scenario, "codex", "bound");
        let ready = await prepare(scenario, "codex", "logout");
        transportFor(scenario, "codex").failNextLaunch();
        await begin(scenario, preparationKey(ready));
        // The failed launch committed nothing, so the retry mints the first
        // rotation and the next action must still mint a different one.
        assert.equal(scenario.generations.commits.length, 0);
        ready = await prepare(scenario, "codex", "logout");
        await begin(scenario, preparationKey(ready));
        transportFor(scenario, "codex").children[0]?.exit(0);
        await tick();
        await establishAuthentication(
          factory,
          scenario,
          "codex",
          "sign-in-required",
        );
        ready = await prepare(scenario, "codex", "login");
        await begin(scenario, preparationKey(ready));
        assert.equal(scenario.generations.commits.length, 2);
        assert.notEqual(
          scenario.generations.commits[0]?.generation,
          scenario.generations.commits[1]?.generation,
        );
      } finally {
        await scenario.subject.close();
      }
    },
  );

  await recorder.observe(
    "generation.external-auth-observation-does-not-advance-generation",
    async () => {
      const scenario = await createScenario(factory);
      try {
        await establishAuthentication(factory, scenario, "codex", "bound");
        assert.deepEqual(
          await establishAuthentication(
            factory,
            scenario,
            "codex",
            "sign-in-required",
          ),
          { kind: "authentication-state", state: "sign-in-required" },
        );
        assert.equal(scenario.generations.commits.length, 0);
        assert.equal(
          transportFor(scenario, "codex").officialActionRequests.length,
          0,
        );
      } finally {
        await scenario.subject.close();
      }
    },
  );

  const resumeRows: readonly Readonly<{
    id: string;
    endpoint: F104EndpointGenerationRecord;
    session: F104SessionGeneration;
    preEligible: boolean;
    expectedNativeResume: boolean;
  }>[] = [
    {
      id: "pristine-legacy-missing-session-generation-preserves-old-checks",
      endpoint: { classification: "pristine-legacy" },
      session: { kind: "missing" },
      preEligible: true,
      expectedNativeResume: true,
    },
    {
      id: "pristine-legacy-present-session-generation-rejects",
      endpoint: { classification: "pristine-legacy" },
      session: { kind: "value", value: "unexpected" },
      preEligible: true,
      expectedNativeResume: false,
    },
    {
      id: "pristine-legacy-malformed-session-generation-rejects",
      endpoint: { classification: "pristine-legacy" },
      session: { kind: "malformed" },
      preEligible: true,
      expectedNativeResume: false,
    },
    {
      id: "managed-exact-generation-continues-old-checks",
      endpoint: { classification: "managed", generation: "generation-current" },
      session: { kind: "value", value: "generation-current" },
      preEligible: true,
      expectedNativeResume: true,
    },
    {
      id: "managed-missing-session-generation-rejects",
      endpoint: { classification: "managed", generation: "generation-current" },
      session: { kind: "missing" },
      preEligible: true,
      expectedNativeResume: false,
    },
    {
      id: "managed-older-session-generation-rejects",
      endpoint: { classification: "managed", generation: "generation-current" },
      session: { kind: "value", value: "generation-older" },
      preEligible: true,
      expectedNativeResume: false,
    },
    {
      id: "managed-mismatched-session-generation-rejects",
      endpoint: { classification: "managed", generation: "generation-current" },
      session: { kind: "value", value: "generation-other" },
      preEligible: true,
      expectedNativeResume: false,
    },
    {
      id: "managed-malformed-session-generation-rejects",
      endpoint: { classification: "managed", generation: "generation-current" },
      session: { kind: "malformed" },
      preEligible: true,
      expectedNativeResume: false,
    },
    {
      id: "managed-malformed-endpoint-record-rejects",
      endpoint: { classification: "malformed" },
      session: { kind: "value", value: "generation-current" },
      preEligible: true,
      expectedNativeResume: false,
    },
    {
      id: "unreadable-endpoint-history-rejects",
      endpoint: { classification: "unreadable" },
      session: { kind: "value", value: "generation-current" },
      preEligible: true,
      expectedNativeResume: false,
    },
    {
      id: "exact-generation-does-not-bypass-preexisting-resume-checks",
      endpoint: { classification: "managed", generation: "generation-current" },
      session: { kind: "value", value: "generation-current" },
      preEligible: false,
      expectedNativeResume: false,
    },
  ];

  for (const row of resumeRows) {
    await recorder.observe(`resume.${row.id}`, async () => {
      const scenario = await createScenario(factory);
      const endpoint = F104_PROVIDER_CASES[0].endpointSelectionKey;
      scenario.generations.set(endpoint, row.endpoint);
      scenario.transcripts.set({
        sessionControlKey: "session-control-01",
        endpointSelectionKey: endpoint,
        generation: row.session,
        preF104ResumeEligible: row.preEligible,
        transcript: ["message-01", "response-01", "handoff-01"],
      });
      await scenario.subject.close();
      const restarted = await factory.createSubject({
        adapters: scenario.adapters,
        registry: scenario.registry,
        generations: scenario.generations,
        transcripts: scenario.transcripts,
        opaqueKeys: scenario.opaqueKeys,
      });
      try {
        assert.deepEqual(await restarted.attemptNativeResume("session-control-01"), {
          nativeResumeRequested: row.expectedNativeResume,
          transcript: ["message-01", "response-01", "handoff-01"],
        });
        assert.equal(
          scenario.transcripts.nativeResumeRequests.length,
          row.expectedNativeResume ? 1 : 0,
        );
      } finally {
        await restarted.close();
      }
    });
  }

  await recorder.observe(
    "resume.generation-rotation-preserves-complete-transcript",
    async () => {
      const scenario = await createScenario(factory);
      try {
        const endpoint = F104_PROVIDER_CASES[0].endpointSelectionKey;
        const transcript = [
          "command-accepted",
          "event-01",
          "update-01",
          "handoff-01",
        ];
        scenario.transcripts.set({
          sessionControlKey: "session-control-01",
          endpointSelectionKey: endpoint,
          generation: { kind: "missing" },
          preF104ResumeEligible: true,
          transcript,
        });
        await establishAuthentication(factory, scenario, "codex", "bound");
        const ready = await prepare(scenario, "codex", "logout");
        await begin(scenario, preparationKey(ready));
        assert.deepEqual(
          await scenario.subject.attemptNativeResume("session-control-01"),
          { nativeResumeRequested: false, transcript },
        );
        assert.deepEqual(
          scenario.transcripts.read("session-control-01")?.transcript,
          transcript,
        );
      } finally {
        await scenario.subject.close();
      }
    },
  );
}

async function runSupersessionMatrix(
  factory: F104AcceptanceFactory,
  recorder: ObservationRecorder,
): Promise<void> {
  await recorder.observe(
    "race.pre-action-inspection-resolving-after-action-begin-is-discarded",
    async () => {
      const scenario = await createScenario(factory);
      try {
        const fixture = factory.providerFixture("codex");
        await establishAuthentication(factory, scenario, "codex", "bound");
        const late = transportFor(scenario, "codex").queuePendingStatus();
        const inspection = scenario.subject.request({
          endpointSelectionKey:
            F104_PROVIDER_CASES[0].endpointSelectionKey,
        });
        await tick();
        const ready = await prepare(scenario, "codex", "logout");
        await begin(scenario, preparationKey(ready));
        late.resolve(fixture.recognizedSignInRequired);
        assert.deepEqual(await inspection, { accepted: false });
        const card = cardFor(await scenario.subject.renderSettings(), "codex");
        assert.equal(card.authentication, "Bound");
        assert.equal(card.actions[0]?.disabled, true);
      } finally {
        await scenario.subject.close();
      }
    },
  );

  await recorder.observe(
    "race.post-action-inspection-resolving-after-later-action-is-discarded",
    async () => {
      const scenario = await createScenario(factory);
      try {
        const fixture = factory.providerFixture("codex");
        await establishAuthentication(factory, scenario, "codex", "bound");
        let ready = await prepare(scenario, "codex", "logout");
        await begin(scenario, preparationKey(ready));
        transportFor(scenario, "codex").children[0]?.exit(0);
        await tick();
        const late = transportFor(scenario, "codex").queuePendingStatus();
        const inspection = scenario.subject.request({
          endpointSelectionKey:
            F104_PROVIDER_CASES[0].endpointSelectionKey,
        });
        await tick();
        ready = await prepare(scenario, "codex", "logout");
        await begin(scenario, preparationKey(ready));
        late.resolve(fixture.recognizedSignInRequired);
        assert.deepEqual(await inspection, { accepted: false });
        assert.equal(scenario.generations.commits.length, 2);
        assert.equal(
          transportFor(scenario, "codex").officialActionRequests.length,
          2,
        );
      } finally {
        await scenario.subject.close();
      }
    },
  );
}

async function runPublicBoundaryMatrix(
  factory: F104AcceptanceFactory,
  recorder: ObservationRecorder,
): Promise<void> {
  const validRequestNames = [
    "inspect",
    "prepare-login",
    "prepare-logout",
    "begin-prepared",
  ] as const;
  for (const requestName of validRequestNames) {
    await recorder.observe(`public.request.valid.${requestName}`, async () => {
      const context = await publicBoundaryContext(factory);
      try {
        const request = requestFor(context, requestName);
        assert.equal(context.scenario.subject.sanitizePublicRequest(request).accepted, true);
      } finally {
        await context.scenario.subject.close();
      }
    });
    await recorder.observe(
      `public.request.extra-key-rejects.${requestName}`,
      async () => {
        const context = await publicBoundaryContext(factory);
        try {
          const request = requestFor(context, requestName);
          assert.deepEqual(
            context.scenario.subject.sanitizePublicRequest({
              ...request,
              diagnostic: "controlled-extra",
            }),
            { accepted: false },
          );
        } finally {
          await context.scenario.subject.close();
        }
      },
    );
  }

  const malformedRequests: readonly Readonly<{
    id: string;
    value: unknown;
  }>[] = [
    { id: "null", value: null },
    { id: "array", value: [] },
    { id: "empty", value: {} },
    { id: "prepare-missing-endpoint", value: { action: "logout" } },
    {
      id: "wrong-endpoint-primitive",
      value: { endpointSelectionKey: 1 },
    },
    {
      id: "wrong-action-literal",
      value: {
        endpointSelectionKey: F104_PROVIDER_CASES[0].endpointSelectionKey,
        action: "bind",
      },
    },
    { id: "begin-wrong-key-primitive", value: { preparationKey: 1 } },
    {
      id: "foreign-prototype",
      value: Object.assign(Object.create(null), {
        endpointSelectionKey: F104_PROVIDER_CASES[0].endpointSelectionKey,
      }),
    },
    {
      id: "accessor",
      value: Object.defineProperty({}, "endpointSelectionKey", {
        enumerable: true,
        get: () => F104_PROVIDER_CASES[0].endpointSelectionKey,
      }),
    },
    {
      id: "throwing-proxy",
      value: new Proxy(
        {},
        {
          ownKeys(): never {
            throw new Error("controlled-proxy-failure");
          },
        },
      ),
    },
  ];
  for (const row of malformedRequests) {
    await recorder.observe(`public.request.malformed.${row.id}`, async () => {
      const scenario = await createScenario(factory);
      try {
        assert.deepEqual(scenario.subject.sanitizePublicRequest(row.value), {
          accepted: false,
        });
      } finally {
        await scenario.subject.close();
      }
    });
  }

  for (const [id, value] of [
    ["forged-endpoint-selection", { endpointSelectionKey: "forged-selection" }],
    ["forged-preparation", { preparationKey: "forged-preparation" }],
  ] as const) {
    await recorder.observe(`public.request.${id}`, async () => {
      const scenario = await createScenario(factory);
      try {
        assert.deepEqual(scenario.subject.sanitizePublicRequest(value), {
          accepted: false,
        });
      } finally {
        await scenario.subject.close();
      }
    });
  }

  const responseNames = [
    "authentication-bound",
    "authentication-sign-in-required",
    "authentication-unknown",
    "blocked",
    "confirmation",
    "ready",
    "logout-requested",
    "login-requested",
    "logout-not-requested",
    "login-not-requested",
    "logout-partially-completed",
    "login-partially-completed",
  ] as const;
  for (const responseName of responseNames) {
    await recorder.observe(`public.response.valid.${responseName}`, async () => {
      const context = await publicBoundaryContext(factory);
      try {
        assert.equal(
          context.scenario.subject.sanitizePublicResponse(
            responseFor(context, responseName),
          ).accepted,
          true,
        );
      } finally {
        await context.scenario.subject.close();
      }
    });
    await recorder.observe(
      `public.response.extra-key-rejects.${responseName}`,
      async () => {
        const context = await publicBoundaryContext(factory);
        try {
          assert.deepEqual(
            context.scenario.subject.sanitizePublicResponse({
              ...responseFor(context, responseName),
              diagnostic: "controlled-extra",
            }),
            { accepted: false },
          );
        } finally {
          await context.scenario.subject.close();
        }
      },
    );
  }

  const malformedResponses: readonly Readonly<{
    id: string;
    value: unknown;
  }>[] = [
    { id: "null", value: null },
    { id: "array", value: [] },
    { id: "empty", value: {} },
    { id: "unknown-kind", value: { kind: "native-error" } },
    { id: "state-missing", value: { kind: "authentication-state" } },
    {
      id: "state-unknown-literal",
      value: { kind: "authentication-state", state: "logged-out" },
    },
    { id: "blocked-missing", value: { kind: "blocked" } },
    {
      id: "blocked-partial",
      value: {
        kind: "blocked",
        blockers: {
          accepted: 0,
          starting: 0,
          inFlight: 0,
          recoveryRequired: 0,
        },
      },
    },
    {
      id: "blocked-nested-extra",
      value: {
        kind: "blocked",
        blockers: {
          accepted: 0,
          starting: 0,
          inFlight: 0,
          recoveryRequired: 0,
          unknown: 0,
          total: 0,
        },
      },
    },
    { id: "ready-missing-key", value: { kind: "ready" } },
    {
      id: "ready-forged-key",
      value: { kind: "ready", preparationKey: "forged-preparation" },
    },
    {
      id: "confirmation-missing-consequences",
      value: {
        kind: "confirmation-required",
        preparationKey: "forged-preparation",
      },
    },
    {
      id: "confirmation-partial-consequences",
      value: {
        kind: "confirmation-required",
        preparationKey: "forged-preparation",
        consequences: { projectCount: 1 },
      },
    },
    {
      id: "action-missing",
      value: { kind: "authentication-action-requested" },
    },
    {
      id: "action-unknown-literal",
      value: { kind: "authentication-action-requested", action: "bind" },
    },
    {
      id: "foreign-prototype",
      value: Object.assign(Object.create(null), {
        kind: "authentication-state",
        state: "bound",
      }),
    },
    {
      id: "accessor",
      value: Object.defineProperty(
        { kind: "authentication-state" },
        "state",
        {
          enumerable: true,
          get: () => "bound",
        },
      ),
    },
    {
      id: "throwing-proxy",
      value: new Proxy(
        {},
        {
          ownKeys(): never {
            throw new Error("controlled-response-proxy-failure");
          },
        },
      ),
    },
  ];
  for (const row of malformedResponses) {
    await recorder.observe(`public.response.malformed.${row.id}`, async () => {
      const scenario = await createScenario(factory);
      try {
        assert.deepEqual(scenario.subject.sanitizePublicResponse(row.value), {
          accepted: false,
        });
      } finally {
        await scenario.subject.close();
      }
    });
  }

  for (const [id, buildValue] of [
    [
      "confirmation-missing-consequences-with-valid-key",
      (key: string) => ({
        kind: "confirmation-required",
        preparationKey: key,
      }),
    ],
    [
      "confirmation-partial-consequences-with-valid-key",
      (key: string) => ({
        kind: "confirmation-required",
        preparationKey: key,
        consequences: { projectCount: 1 },
      }),
    ],
    [
      "confirmation-nested-extra-with-valid-key",
      (key: string) => ({
        kind: "confirmation-required",
        preparationKey: key,
        consequences: {
          resumableSessionCount: 1,
          projectCount: 1,
          affectedProvider: "controlled-extra",
        },
      }),
    ],
  ] as const) {
    await recorder.observe(`public.response.malformed.${id}`, async () => {
      const context = await publicBoundaryContext(factory);
      try {
        assert.deepEqual(
          context.scenario.subject.sanitizePublicResponse(
            buildValue(context.preparationKey),
          ),
          { accepted: false },
        );
      } finally {
        await context.scenario.subject.close();
      }
    });
  }

  await recorder.observe(
    "public.response.stale-preparation-key-rejected",
    async () => {
      const context = await publicBoundaryContext(factory);
      try {
        await begin(context.scenario, context.preparationKey);
        assert.deepEqual(
          context.scenario.subject.sanitizePublicResponse({
            kind: "ready",
            preparationKey: context.preparationKey,
          }),
          { accepted: false },
        );
      } finally {
        await context.scenario.subject.close();
      }
    },
  );

  for (const field of F104_FORBIDDEN_PUBLIC_FIELDS) {
    await recorder.observe(`public.request.forbidden-field.${field}`, async () => {
      const scenario = await createScenario(factory);
      try {
        assert.deepEqual(
          scenario.subject.sanitizePublicRequest({
            endpointSelectionKey: F104_PROVIDER_CASES[0].endpointSelectionKey,
            [field]: forbiddenFieldValue(field),
          }),
          { accepted: false },
        );
      } finally {
        await scenario.subject.close();
      }
    });
    await recorder.observe(`public.response.forbidden-field.${field}`, async () => {
      const scenario = await createScenario(factory);
      try {
        assert.deepEqual(
          scenario.subject.sanitizePublicResponse({
            kind: "authentication-state",
            state: "bound",
            [field]: forbiddenFieldValue(field),
          }),
          { accepted: false },
        );
      } finally {
        await scenario.subject.close();
      }
    });
  }

  const invalidCounts: readonly Readonly<{ id: string; value: unknown }>[] = [
    { id: "negative", value: -1 },
    { id: "fractional", value: 0.5 },
    { id: "positive-infinity", value: Number.POSITIVE_INFINITY },
    { id: "negative-infinity", value: Number.NEGATIVE_INFINITY },
    { id: "nan", value: Number.NaN },
    { id: "string", value: "1" },
    { id: "unsafe-integer", value: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const member of [
    "accepted",
    "starting",
    "inFlight",
    "recoveryRequired",
    "unknown",
  ] as const) {
    for (const invalid of invalidCounts) {
      await recorder.observe(
        `public.response.blocker-count.${member}.${invalid.id}`,
        async () => {
          const scenario = await createScenario(factory);
          try {
            const blockers = {
              accepted: 0,
              starting: 0,
              inFlight: 0,
              recoveryRequired: 0,
              unknown: 0,
              [member]: invalid.value,
            };
            assert.deepEqual(
              scenario.subject.sanitizePublicResponse({
                kind: "blocked",
                blockers,
              }),
              { accepted: false },
            );
          } finally {
            await scenario.subject.close();
          }
        },
      );
    }
  }
  for (const member of [
    "resumableSessionCount",
    "projectCount",
  ] as const) {
    for (const invalid of invalidCounts) {
      await recorder.observe(
        `public.response.consequence-count.${member}.${invalid.id}`,
        async () => {
          const context = await publicBoundaryContext(factory);
          try {
            assert.deepEqual(
              context.scenario.subject.sanitizePublicResponse({
                kind: "confirmation-required",
                preparationKey: context.preparationKey,
                consequences: {
                  resumableSessionCount: 1,
                  projectCount: 1,
                  [member]: invalid.value,
                },
              }),
              { accepted: false },
            );
          } finally {
            await context.scenario.subject.close();
          }
        },
      );
    }
  }
}

async function runRenderedSettingsMatrix(
  factory: F104AcceptanceFactory,
  recorder: ObservationRecorder,
): Promise<void> {
  await recorder.observe("render.existing-settings-provider-selectors", async () => {
    const scenario = await createScenario(factory);
    try {
      const rendered = await scenario.subject.renderSettings();
      assert.equal(rendered.heading, "Settings");
      assert.deepEqual(rendered.sections, ["Providers", "Appearance"]);
      assert.deepEqual(rendered.selectorCounts, {
        [F104_SETTINGS_SELECTORS.settingsRoot]: 1,
        [F104_SETTINGS_SELECTORS.providerRegion]: 1,
        [F104_SETTINGS_SELECTORS.providerCard]: 2,
        [F104_SETTINGS_SELECTORS.providerName]: 2,
        [F104_SETTINGS_SELECTORS.providerActions]: 2,
        [F104_SETTINGS_SELECTORS.subscriptionStatus]: 2,
      });
      assert.deepEqual(
        rendered.cards.map((card) => card.label),
        ["Codex", "Claude"],
      );
    } finally {
      await scenario.subject.close();
    }
  });

  await recorder.observe("render.exact-f13-copy-byte-preserved", async () => {
    const scenario = await createScenario(factory);
    try {
      const rendered = await scenario.subject.renderSettings();
      assert.equal(rendered.exactTexts.includes(F104_COPY.credentialHeading), true);
      assert.equal(rendered.exactTexts.includes(F104_COPY.credentialSentence), true);
    } finally {
      await scenario.subject.close();
    }
  });

  await recorder.observe("render.no-credential-or-browser-controls", async () => {
    const scenario = await createScenario(factory);
    try {
      const rendered = await scenario.subject.renderSettings();
      assert.equal(rendered.credentialControls, false);
      assert.equal(rendered.embeddedBrowserControls, false);
      assert.equal(rendered.otherProviderControls, false);
    } finally {
      await scenario.subject.close();
    }
  });

  await recorder.observe("render.forbidden-success-identity-and-credential-copy-absent", async () => {
    const scenario = await createScenario(factory);
    try {
      const serialized = JSON.stringify(await scenario.subject.renderSettings());
      assert.doesNotMatch(
        serialized,
        /Logged out successfully|Login successful|Signed in as|same account|different account|account changed|deleted credentials|removed credentials|cleared credentials|revoked credentials|replaced credentials/iu,
      );
    } finally {
      await scenario.subject.close();
    }
  });

  for (const [provider, catalog, authentication] of [
    ["codex", "Catalog available", "sign-in-required"],
    ["codex", "Catalog unavailable", "bound"],
    ["claude", "Not checked", "bound"],
    ["claude", "Catalog available", "unknown"],
  ] as const) {
    await recorder.observe(
      `render.catalog-auth-independent.${provider}.${slug(catalog)}.${authentication}`,
      async () => {
        const scenario = await createScenario(factory);
        try {
          const endpoint = providerCaseFor(provider).endpointSelectionKey;
          scenario.subject.setCatalogObservation(endpoint, catalog);
          await establishAuthentication(
            factory,
            scenario,
            provider,
            authentication,
          );
          const card = cardFor(await scenario.subject.renderSettings(), provider);
          assert.equal(card.catalog, catalog);
          assert.equal(card.authentication, authLabel(authentication));
        } finally {
          await scenario.subject.close();
        }
      },
    );
  }

  for (const providerCase of F104_PROVIDER_CASES) {
    await recorder.observe(
      `render.unknown-auth-fail-closed.${providerCase.provider}`,
      async () => {
        const scenario = await createScenario(factory);
        try {
          await establishAuthentication(
            factory,
            scenario,
            providerCase.provider,
            "unknown",
          );
          for (const action of ["login", "logout"] as const) {
            assert.deepEqual(
              await scenario.subject.request({
                endpointSelectionKey: providerCase.endpointSelectionKey,
                action,
              }),
              { accepted: false },
            );
          }
          assert.deepEqual(
            cardFor(
              await scenario.subject.renderSettings(),
              providerCase.provider,
            ).actions,
            [{ label: "Check sign-in", disabled: false }],
          );
          assert.equal(scenario.generations.commits.length, 0);
          assert.equal(
            transportFor(scenario, providerCase.provider)
              .officialActionRequests.length,
            0,
          );
        } finally {
          await scenario.subject.close();
        }
      },
    );
  }

  await recorder.observe("render.blockers-remain-separate-observations", async () => {
    const scenario = await createScenario(factory);
    try {
      const endpoint = F104_PROVIDER_CASES[0].endpointSelectionKey;
      scenario.registry.replace([
        project("project-01", true, [
          guardSession("accepted", endpoint, "accepted", false),
          guardSession("starting", endpoint, "starting", false),
          guardSession("running", endpoint, "in-flight", false),
          guardSession("recovery", endpoint, "recovery-required", false),
          guardSession("unknown", endpoint, "unknown", false),
        ]),
      ]);
      await establishAuthentication(factory, scenario, "codex", "bound");
      const blocked = await prepare(scenario, "codex", "logout");
      assert.deepEqual(blocked, {
        kind: "blocked",
        blockers: {
          accepted: 1,
          starting: 1,
          inFlight: 1,
          recoveryRequired: 1,
          unknown: 1,
        },
      });
      const card = cardFor(await scenario.subject.renderSettings(), "codex");
      assert.equal(card.blockedStatement, F104_COPY.logoutBlocked);
      assert.deepEqual(card.blockers, [
        { label: F104_BLOCKER_LABELS.accepted, count: 1 },
        { label: F104_BLOCKER_LABELS.starting, count: 1 },
        { label: F104_BLOCKER_LABELS.inFlight, count: 1 },
        { label: F104_BLOCKER_LABELS.recoveryRequired, count: 1 },
        { label: F104_BLOCKER_LABELS.unknown, count: 1 },
      ]);
    } finally {
      await scenario.subject.close();
    }
  });
}

async function createScenario(factory: F104AcceptanceFactory): Promise<Scenario> {
  const events = new ControlledEventLog();
  const transports = new Map<F104Provider, ControlledNativeProviderTransport>();
  const schedulers = new Map<F104Provider, ControlledScheduler>();
  const adapters = new Map<string, F104ProviderAdapter>();
  for (const providerCase of F104_PROVIDER_CASES) {
    const transport = new ControlledNativeProviderTransport(
      providerCase.provider,
      events,
    );
    const scheduler = new ControlledScheduler();
    const adapter = factory.createProviderAdapter({
      provider: providerCase.provider,
      transport,
      scheduler,
      inspectionTimeoutMilliseconds: 10,
    });
    transports.set(providerCase.provider, transport);
    schedulers.set(providerCase.provider, scheduler);
    adapters.set(providerCase.endpointSelectionKey, adapter);
  }
  const registry = new ControlledProjectRegistry();
  const generations = new ControlledGenerationStore(events);
  const transcripts = new ControlledTranscriptStore();
  const opaqueKeys = new ControlledOpaqueKeySource();
  const subject = await factory.createSubject({
    adapters,
    registry,
    generations,
    transcripts,
    opaqueKeys,
  });
  return Object.freeze({
    events,
    transports,
    schedulers,
    adapters,
    registry,
    generations,
    transcripts,
    opaqueKeys,
    subject,
  });
}

function providerProbe(factory: F104AcceptanceFactory, provider: F104Provider) {
  const events = new ControlledEventLog();
  const transport = new ControlledNativeProviderTransport(provider, events);
  const scheduler = new ControlledScheduler();
  const adapter = factory.createProviderAdapter({
    provider,
    transport,
    scheduler,
    inspectionTimeoutMilliseconds: 10,
  });
  return Object.freeze({ events, transport, scheduler, adapter });
}

async function runCompleteCycle(
  factory: F104AcceptanceFactory,
  provider: F104Provider,
  finalState: F104AuthenticationState,
  logoutExitCode = 0,
  loginExitCode = 0,
): Promise<CycleResult> {
  const scenario = await createScenario(factory);
  try {
    const initial = await establishAuthentication(
      factory,
      scenario,
      provider,
      "bound",
    );
    const initialRender = await scenario.subject.renderSettings();
    const logoutPreparation = await prepare(scenario, provider, "logout");
    const logoutKey = preparationKey(logoutPreparation);
    const logoutBegin = await begin(scenario, logoutKey);
    const midLogoutRender = await scenario.subject.renderSettings();
    const replayRejected = !(
      await scenario.subject.request({ preparationKey: logoutKey })
    ).accepted;
    const duplicatePreparationRejected = !(
      await scenario.subject.request({
        endpointSelectionKey: providerCaseFor(provider).endpointSelectionKey,
        action: "logout",
      })
    ).accepted;
    transportFor(scenario, provider).children[0]?.exit(logoutExitCode);
    await tick();
    const preInspectionRender = await scenario.subject.renderSettings();
    const signedOut = await establishAuthentication(
      factory,
      scenario,
      provider,
      "sign-in-required",
    );
    const signedOutRender = await scenario.subject.renderSettings();
    const loginPreparation = await prepare(scenario, provider, "login");
    const loginBegin = await begin(
      scenario,
      preparationKey(loginPreparation),
    );
    transportFor(scenario, provider).children[1]?.exit(loginExitCode);
    await tick();
    const finalResponse = await establishAuthentication(
      factory,
      scenario,
      provider,
      finalState,
    );
    const finalRender = await scenario.subject.renderSettings();
    return Object.freeze({
      initial,
      initialRender,
      logoutPreparation,
      logoutBegin,
      midLogoutRender,
      replayRejected,
      duplicatePreparationRejected,
      preInspectionRender,
      signedOut,
      signedOutRender,
      loginPreparation,
      loginBegin,
      finalState: finalResponse,
      finalRender,
      events: Object.freeze([...scenario.events.entries]),
      generations: Object.freeze(
        scenario.generations.commits.map((commit) => commit.generation),
      ),
      officialActions: Object.freeze([
        ...transportFor(scenario, provider).officialActionRequests,
      ]),
    });
  } finally {
    await scenario.subject.close();
  }
}

async function establishAuthentication(
  factory: F104AcceptanceFactory,
  scenario: Scenario,
  provider: F104Provider,
  state: F104AuthenticationState,
): Promise<F104PublicResponse> {
  const fixture = factory.providerFixture(provider);
  const nativeValue =
    state === "bound"
      ? fixture.recognizedBound
      : state === "sign-in-required"
        ? fixture.recognizedSignInRequired
        : fixture.invalidConsumed.find(
            (entry) => entry.category === "unknown-literal",
          )?.value;
  assert.notEqual(nativeValue, undefined);
  transportFor(scenario, provider).queueStatus(nativeValue);
  return acceptedValue(
    await scenario.subject.request({
      endpointSelectionKey: providerCaseFor(provider).endpointSelectionKey,
    }),
  );
}

async function prepare(
  scenario: Scenario,
  provider: F104Provider,
  action: F104AuthenticationAction,
): Promise<F104PublicResponse> {
  return acceptedValue(
    await scenario.subject.request({
      endpointSelectionKey: providerCaseFor(provider).endpointSelectionKey,
      action,
    }),
  );
}

async function begin(
  scenario: Scenario,
  preparationKeyValue: string,
): Promise<F104PublicResponse> {
  return acceptedValue(
    await scenario.subject.request({ preparationKey: preparationKeyValue }),
  );
}

async function terminalConsequenceScenario(
  factory: F104AcceptanceFactory,
  state: "bound" | "sign-in-required",
): Promise<Scenario> {
  const scenario = await createScenario(factory);
  const endpoint = F104_PROVIDER_CASES[0].endpointSelectionKey;
  scenario.registry.replace([
    project("project-01", true, [
      guardSession("terminal-01", endpoint, "terminal", true),
    ]),
    project("project-02", false, [
      guardSession("terminal-02", endpoint, "terminal", true),
      guardSession("terminal-03", endpoint, "terminal", false),
    ]),
  ]);
  await establishAuthentication(factory, scenario, "codex", state);
  return scenario;
}

async function publicBoundaryContext(factory: F104AcceptanceFactory) {
  const scenario = await createScenario(factory);
  await establishAuthentication(factory, scenario, "codex", "bound");
  const ready = await prepare(scenario, "codex", "logout");
  return Object.freeze({
    scenario,
    preparationKey: preparationKey(ready),
  });
}

function requestFor(
  context: Awaited<ReturnType<typeof publicBoundaryContext>>,
  name:
    | "inspect"
    | "prepare-login"
    | "prepare-logout"
    | "begin-prepared",
): Record<string, unknown> {
  const endpointSelectionKey = F104_PROVIDER_CASES[0].endpointSelectionKey;
  if (name === "inspect") return { endpointSelectionKey };
  if (name === "prepare-login") {
    return { endpointSelectionKey, action: "login" };
  }
  if (name === "prepare-logout") {
    return { endpointSelectionKey, action: "logout" };
  }
  return { preparationKey: context.preparationKey };
}

function responseFor(
  context: Awaited<ReturnType<typeof publicBoundaryContext>>,
  name:
    | "authentication-bound"
    | "authentication-sign-in-required"
    | "authentication-unknown"
    | "blocked"
    | "confirmation"
    | "ready"
    | "logout-requested"
    | "login-requested"
    | "logout-not-requested"
    | "login-not-requested"
    | "logout-partially-completed"
    | "login-partially-completed",
): Record<string, unknown> {
  if (name.startsWith("authentication-")) {
    const state = name.slice("authentication-".length);
    return { kind: "authentication-state", state };
  }
  if (name === "blocked") {
    return {
      kind: "blocked",
      blockers: {
        accepted: 0,
        starting: 0,
        inFlight: 0,
        recoveryRequired: 0,
        unknown: 0,
      },
    };
  }
  if (name === "confirmation") {
    return {
      kind: "confirmation-required",
      preparationKey: context.preparationKey,
      consequences: { resumableSessionCount: 1, projectCount: 1 },
    };
  }
  if (name === "ready") {
    return { kind: "ready", preparationKey: context.preparationKey };
  }
  const action = name.startsWith("logout") ? "logout" : "login";
  const kind = name.endsWith("not-requested")
    ? "authentication-action-not-requested"
    : name.endsWith("partially-completed")
      ? "authentication-action-partially-completed"
      : "authentication-action-requested";
  return { kind, action };
}

function acceptedValue(
  result: F104BoundaryResult<F104PublicResponse>,
): F104PublicResponse {
  assert.equal(result.accepted, true);
  if (!result.accepted) throw new Error("acceptance-result-rejected");
  return result.value;
}

function preparationKey(response: F104PublicResponse): string {
  assert.ok(
    response.kind === "ready" || response.kind === "confirmation-required",
  );
  if (
    response.kind !== "ready" &&
    response.kind !== "confirmation-required"
  ) {
    throw new Error("preparation-key-unavailable");
  }
  return response.preparationKey;
}

function providerCaseFor(provider: F104Provider) {
  const providerCase = F104_PROVIDER_CASES.find(
    (candidate) => candidate.provider === provider,
  );
  assert.ok(providerCase);
  return providerCase;
}

function transportFor(
  scenario: Scenario,
  provider: F104Provider,
): ControlledNativeProviderTransport {
  const transport = scenario.transports.get(provider);
  assert.ok(transport);
  return transport;
}

function cardFor(rendered: F104RenderedSettings, provider: F104Provider) {
  const label = providerCaseFor(provider).label;
  const card = rendered.cards.find((candidate) => candidate.label === label);
  assert.ok(card);
  return card;
}

function project(
  projectKey: string,
  selected: boolean,
  sessions: F104RegisteredProject["sessions"],
): F104RegisteredProject {
  return Object.freeze({ projectKey, selected, sessions: Object.freeze([...sessions]) });
}

function guardSession(
  sessionKey: string,
  endpointMembership: string | "unknown",
  activity: Parameters<typeof project>[2][number]["activity"],
  nativeResumable: boolean,
) {
  return Object.freeze({
    sessionKey,
    endpointMembership,
    activity,
    nativeResumable,
  });
}

function withUnrelatedNativeExtras(value: unknown): unknown {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return Object.freeze({
    ...(value as Record<string, unknown>),
    email: "private@example.invalid",
    accountId: "private-account",
    organization: "private-organization",
    plan: "private-plan",
    profile: Object.freeze({ label: "private-profile" }),
    browserUrl: "https://private.invalid/controlled",
  });
}

function forbiddenFieldValue(field: string): unknown {
  if (field === "arguments") return Object.freeze(["controlled-private"]);
  if (field === "environment") {
    return Object.freeze({ CONTROLLED_SECRET: "private" });
  }
  if (
    field === "exitCode" ||
    field === "sameAccount" ||
    field === "differentAccount" ||
    field === "accountChanged"
  ) {
    return field === "exitCode" ? 0 : true;
  }
  if (field === "providerRequest" || field === "providerResponse") {
    return Object.freeze({ controlled: "private" });
  }
  return "controlled-private";
}

function authLabel(
  state: F104AuthenticationState,
): "Bound" | "Sign-in required" | "Unknown" {
  return state === "bound"
    ? "Bound"
    : state === "sign-in-required"
      ? "Sign-in required"
      : "Unknown";
}

function slug(value: F104CatalogLabel): string {
  return value.toLocaleLowerCase("en-US").replaceAll(" ", "-");
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
