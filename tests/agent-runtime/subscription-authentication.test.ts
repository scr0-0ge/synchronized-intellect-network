import assert from "node:assert/strict";
import test from "node:test";

import {
  createSubscriptionAuthenticationService,
  type SubscriptionAuthenticationChild,
  type SubscriptionAuthenticationProvider,
  type SubscriptionAuthenticationScheduler,
} from "../../src/agent-runtime/subscription-authentication.ts";

test("login and logout share one serialized action lane and return action-specific sanitized results", async () => {
  const loginChild = controlledChild();
  const logoutChild = controlledChild();
  const events: string[] = [];
  const service = createSubscriptionAuthenticationService({
    providers: [
      Object.freeze({
        endpointId: "claude-code-desktop" as const,
        async launchLogin() {
          events.push("login");
          return loginChild;
        },
        async launchLogout() {
          events.push("logout");
          return logoutChild;
        },
        async inspectAuthentication() {
          events.push("inspect");
          return "sign-in-required" as const;
        },
      }),
    ],
    timeoutMilliseconds: 30_000,
  });

  const login = service.requestAction("claude-code-desktop", "login");
  await tick();
  assert.deepEqual(events, ["login"]);
  assert.deepEqual(
    await service.requestAction("claude-code-desktop", "logout"),
    {
      endpointId: "claude-code-desktop",
      action: "logout",
      effect: "pending",
      request: "not-started",
      authentication: "unknown",
    },
  );
  assert.deepEqual(events, ["login"]);

  loginChild.finish();
  assert.deepEqual(await login, {
    endpointId: "claude-code-desktop",
    action: "login",
    effect: "finished",
    request: "started",
    authentication: "sign-in-required",
  });
  assert.deepEqual(events, ["login", "inspect"]);

  const logout = service.requestAction("claude-code-desktop", "logout");
  await tick();
  assert.deepEqual(events, ["login", "inspect", "logout"]);
  logoutChild.finish();
  assert.deepEqual(await logout, {
    endpointId: "claude-code-desktop",
    action: "logout",
    effect: "finished",
    request: "started",
    authentication: "sign-in-required",
  });
  await service.close();
});

test("the shared action interface rejects every action outside the fixed login/logout vocabulary", async () => {
  let launches = 0;
  const service = createSubscriptionAuthenticationService({
    providers: [
      Object.freeze({
        endpointId: "codex-desktop" as const,
        async launchLogin() {
          launches += 1;
          return controlledChild();
        },
        async launchLogout() {
          launches += 1;
          return controlledChild();
        },
        async inspectAuthentication() {
          return "unknown" as const;
        },
      }),
    ],
    timeoutMilliseconds: 30_000,
  });

  let thrown: unknown;
  try {
    service.requestAction(
      "codex-desktop",
      "logout --with-renderer-arguments" as "logout",
    );
  } catch (error) {
    thrown = error;
  }
  await tick();
  await service.close();
  assert.equal(thrown instanceof TypeError, true);
  assert.equal(launches, 0);
});

test("action begin supersedes every earlier inspection and only its fresh post-action inspection establishes state", async () => {
  const child = controlledChild();
  const inspections = [
    deferred<"bound" | "sign-in-required">(),
    deferred<"bound" | "sign-in-required">(),
  ];
  let inspectionIndex = 0;
  const service = createSubscriptionAuthenticationService({
    providers: [
      Object.freeze({
        endpointId: "codex-desktop" as const,
        async launchLogin() {
          throw new Error("not used");
        },
        async launchLogout() {
          return child;
        },
        inspectAuthentication() {
          const inspection = inspections[inspectionIndex];
          inspectionIndex += 1;
          if (inspection === undefined) throw new Error("unexpected inspection");
          return inspection.promise;
        },
      }),
    ],
    timeoutMilliseconds: 30_000,
  });

  const staleInspection = service.inspect("codex-desktop");
  await tick();
  const logout = service.requestAction("codex-desktop", "logout");
  await tick();

  inspections[0]?.resolve("bound");
  assert.deepEqual(await staleInspection, {
    endpointId: "codex-desktop",
    authentication: "unknown",
  });

  child.finish();
  await tick();
  assert.equal(inspectionIndex, 2);
  inspections[1]?.resolve("sign-in-required");
  assert.deepEqual(await logout, {
    endpointId: "codex-desktop",
    action: "logout",
    effect: "finished",
    request: "started",
    authentication: "sign-in-required",
  });
  await service.close();
});

test("an inspection requested while the native action is active cannot establish state early", async () => {
  const child = controlledChild();
  let inspections = 0;
  const service = createSubscriptionAuthenticationService({
    providers: [
      Object.freeze({
        endpointId: "codex-desktop" as const,
        async launchLogin() {
          return child;
        },
        async launchLogout() {
          return child;
        },
        async inspectAuthentication() {
          inspections += 1;
          return "bound" as const;
        },
      }),
    ],
    timeoutMilliseconds: 30_000,
  });

  const action = service.requestAction("codex-desktop", "logout");
  await tick();
  assert.deepEqual(await service.inspect("codex-desktop"), {
    endpointId: "codex-desktop",
    authentication: "unknown",
  });
  assert.equal(inspections, 0);

  child.finish();
  assert.equal((await action).authentication, "bound");
  assert.equal(inspections, 1);
  await service.close();
});

test("a later action supersedes an earlier post-action inspection after the earlier child exits", async () => {
  const logoutChild = controlledChild();
  const loginChild = controlledChild();
  const inspections = [
    deferred<"bound" | "sign-in-required">(),
    deferred<"bound" | "sign-in-required">(),
  ];
  const launches: string[] = [];
  let inspectionIndex = 0;
  const service = createSubscriptionAuthenticationService({
    providers: [
      Object.freeze({
        endpointId: "claude-code-desktop" as const,
        async launchLogin() {
          launches.push("login");
          return loginChild;
        },
        async launchLogout() {
          launches.push("logout");
          return logoutChild;
        },
        inspectAuthentication() {
          const inspection = inspections[inspectionIndex];
          inspectionIndex += 1;
          if (inspection === undefined) throw new Error("unexpected inspection");
          return inspection.promise;
        },
      }),
    ],
    timeoutMilliseconds: 30_000,
  });

  const logout = service.requestAction("claude-code-desktop", "logout");
  await tick();
  logoutChild.finish();
  await tick();
  assert.equal(inspectionIndex, 1);

  const login = service.requestAction("claude-code-desktop", "login");
  await tick();
  if (launches.length !== 2) {
    await service.close();
  }
  assert.deepEqual(launches, ["logout", "login"]);
  const logoutResult = await settlesWithin(logout);
  if (logoutResult === "timeout") {
    await service.close();
    assert.fail("the superseded post-action inspection must settle promptly");
  }
  assert.deepEqual(logoutResult, {
    endpointId: "claude-code-desktop",
    action: "logout",
    effect: "finished",
    request: "started",
    authentication: "unknown",
  });

  inspections[0]?.resolve("sign-in-required");
  loginChild.finish();
  await tick();
  assert.equal(inspectionIndex, 2);
  inspections[1]?.resolve("bound");
  assert.deepEqual(await login, {
    endpointId: "claude-code-desktop",
    action: "login",
    effect: "finished",
    request: "started",
    authentication: "bound",
  });
  await service.close();
});

test("both registered endpoints reject duplicate native actions through the same shared interface", async () => {
  for (const endpointId of [
    "codex-desktop",
    "claude-code-desktop",
  ] as const) {
    const child = controlledChild();
    const launches: string[] = [];
    const service = createSubscriptionAuthenticationService({
      providers: [
        Object.freeze({
          endpointId,
          async launchLogin() {
            launches.push("login");
            return child;
          },
          async launchLogout() {
            launches.push("logout");
            return child;
          },
          async inspectAuthentication() {
            return "unknown" as const;
          },
        }),
      ],
      timeoutMilliseconds: 30_000,
    });

    const first = service.requestAction(endpointId, "logout");
    await tick();
    assert.equal(
      (await service.requestAction(endpointId, "login")).request,
      "not-started",
    );
    assert.deepEqual(launches, ["logout"]);
    child.finish();
    await first;
    await service.close();
  }
});

test("provider-private post-action payloads collapse to an exact unknown action result", async () => {
  const child = controlledChild();
  const service = createSubscriptionAuthenticationService({
    providers: [
      Object.freeze({
        endpointId: "claude-code-desktop" as const,
        async launchLogin() {
          return child;
        },
        async launchLogout() {
          return child;
        },
        async inspectAuthentication() {
          return Object.freeze({
            state: "bound",
            account: "private-account",
            tokenHint: "private-token-hint",
          }) as never;
        },
      }),
    ],
    timeoutMilliseconds: 30_000,
  });

  const action = service.requestAction("claude-code-desktop", "login");
  await tick();
  child.finish();
  const result = await action;
  assert.deepEqual(result, {
    endpointId: "claude-code-desktop",
    action: "login",
    effect: "finished",
    request: "started",
    authentication: "unknown",
  });
  assert.deepEqual(Object.keys(result).sort(), [
    "action",
    "authentication",
    "effect",
    "endpointId",
    "request",
  ]);
  assert.equal(Object.isFrozen(result), true);
  await service.close();
});

test("subscription binding owns one pending child and refreshes status only after exit", async () => {
  const child = controlledChild();
  const events: string[] = [];
  const provider: SubscriptionAuthenticationProvider = Object.freeze({
    endpointId: "claude-code-desktop",
    async launchLogin() {
      events.push("launch");
      return child;
    },
    async launchLogout() {
      throw new Error("not used");
    },
    async inspectAuthentication() {
      events.push("inspect");
      return "bound" as const;
    },
  });
  const service = createSubscriptionAuthenticationService({
    providers: [provider],
    timeoutMilliseconds: 30_000,
  });

  const binding = service.bind("claude-code-desktop");
  await tick();
  assert.deepEqual(events, ["launch"]);
  assert.deepEqual(await service.bind("claude-code-desktop"), {
    endpointId: "claude-code-desktop",
    effect: "pending",
    authentication: "unknown",
  });
  assert.deepEqual(events, ["launch"]);

  child.finish();
  assert.deepEqual(await binding, {
    endpointId: "claude-code-desktop",
    effect: "finished",
    authentication: "bound",
  });
  assert.deepEqual(events, ["launch", "inspect"]);
  await service.close();
});

test("cancel, timeout, and teardown terminate only the exact owned children", async () => {
  const first = controlledChild();
  const second = controlledChild();
  const scheduler = controlledScheduler();
  let launchCount = 0;
  const service = createSubscriptionAuthenticationService({
    providers: [
      provider("claude-code-desktop", () => (launchCount++ === 0 ? first : second)),
    ],
    scheduler,
    timeoutMilliseconds: 30_000,
  });

  const cancelledBinding = service.requestAction(
    "claude-code-desktop",
    "logout",
  );
  await tick();
  assert.deepEqual(await service.cancel("claude-code-desktop"), {
    endpointId: "claude-code-desktop",
    effect: "cancelled",
    authentication: "unbound",
  });
  assert.deepEqual(await cancelledBinding, {
    endpointId: "claude-code-desktop",
    action: "logout",
    effect: "cancelled",
    request: "started",
    authentication: "sign-in-required",
  });
  assert.equal(first.terminateCalls(), 1);

  const timedBinding = service.requestAction("claude-code-desktop", "login");
  await tick();
  scheduler.fireNext();
  assert.deepEqual(await timedBinding, {
    endpointId: "claude-code-desktop",
    action: "login",
    effect: "timed-out",
    request: "started",
    authentication: "sign-in-required",
  });
  assert.equal(second.terminateCalls(), 1);

  await service.close();
  await service.close();
  assert.equal(first.terminateCalls(), 1);
  assert.equal(second.terminateCalls(), 1);
});

test("launch and shutdown failures remain action effects while fresh inspection alone supplies state", async () => {
  const events: string[] = [];
  const launchFailure = createSubscriptionAuthenticationService({
    providers: [
      Object.freeze({
        endpointId: "codex-desktop" as const,
        async launchLogin(): Promise<SubscriptionAuthenticationChild> {
          events.push("launch-login");
          throw new Error("private executable path");
        },
        async launchLogout(): Promise<SubscriptionAuthenticationChild> {
          events.push("launch-logout");
          throw new Error("private executable path");
        },
        async inspectAuthentication() {
          events.push("inspect");
          return "bound" as const;
        },
      }),
    ],
    timeoutMilliseconds: 30_000,
  });
  assert.deepEqual(
    await launchFailure.requestAction("codex-desktop", "logout"),
    {
    endpointId: "codex-desktop",
    action: "logout",
    effect: "launch-failed",
    request: "not-started",
    authentication: "bound",
    },
  );
  assert.deepEqual(events, ["launch-logout", "inspect"]);

  const child = controlledChild({ terminateFailure: true });
  const shutdownFailure = createSubscriptionAuthenticationService({
    providers: [provider("codex-desktop", () => child, "sign-in-required")],
    timeoutMilliseconds: 30_000,
  });
  const binding = shutdownFailure.requestAction("codex-desktop", "login");
  await tick();
  assert.deepEqual(await shutdownFailure.cancel("codex-desktop"), {
    endpointId: "codex-desktop",
    effect: "shutdown-failed",
    authentication: "unbound",
  });
  assert.deepEqual(await binding, {
    endpointId: "codex-desktop",
    action: "login",
    effect: "shutdown-failed",
    request: "started",
    authentication: "sign-in-required",
  });
  child.finish();
  await shutdownFailure.close();
});

test("a child whose shutdown is unconfirmed keeps the endpoint action lane closed until exit", async () => {
  const first = controlledChild({ terminateFailure: true });
  const second = controlledChild();
  let launches = 0;
  const service = createSubscriptionAuthenticationService({
    providers: [
      Object.freeze({
        endpointId: "codex-desktop" as const,
        async launchLogin() {
          launches += 1;
          return launches === 1 ? first : second;
        },
        async launchLogout() {
          launches += 1;
          return launches === 1 ? first : second;
        },
        async inspectAuthentication() {
          return "unknown" as const;
        },
      }),
    ],
    timeoutMilliseconds: 30_000,
  });

  const firstAction = service.requestAction("codex-desktop", "logout");
  await tick();
  await service.cancel("codex-desktop");
  assert.equal((await firstAction).effect, "shutdown-failed");
  assert.deepEqual(
    await service.requestAction("codex-desktop", "login"),
    {
      endpointId: "codex-desktop",
      action: "login",
      effect: "pending",
      request: "not-started",
      authentication: "unknown",
    },
  );
  assert.equal(launches, 1);

  first.finish();
  await tick();
  const secondAction = service.requestAction("codex-desktop", "login");
  await tick();
  assert.equal(launches, 2);
  second.finish();
  await secondAction;
  await service.close();
});

test("pending is orthogonal to the last sanitized authentication snapshot", async () => {
  const child = controlledChild();
  const service = createSubscriptionAuthenticationService({
    providers: [provider("claude-code-desktop", () => child, "bound")],
    timeoutMilliseconds: 30_000,
  });

  assert.deepEqual(await service.inspect("claude-code-desktop"), {
    endpointId: "claude-code-desktop",
    authentication: "bound",
  });
  const binding = service.bind("claude-code-desktop");
  await tick();
  assert.deepEqual(await service.bind("claude-code-desktop"), {
    endpointId: "claude-code-desktop",
    effect: "pending",
    authentication: "bound",
  });
  child.finish();
  await binding;
  await service.close();
});

test("cancel, timeout, and close settle even when launch never resolves and terminate a late exact child", async () => {
  for (const terminal of ["cancel", "timeout", "close"] as const) {
    const scheduler = controlledScheduler();
    const launch = deferred<SubscriptionAuthenticationChild>();
    const child = controlledChild();
    const service = createSubscriptionAuthenticationService({
      providers: [
        Object.freeze({
          endpointId: "codex-desktop" as const,
          launchLogin: () => launch.promise,
          launchLogout: () => launch.promise,
          async inspectAuthentication() {
            return "unknown" as const;
          },
        }),
      ],
      scheduler,
      timeoutMilliseconds: 30_000,
    });
    const action = terminal === "timeout" ? "logout" : "login";
    const binding = service.requestAction("codex-desktop", action);
    await tick();

    if (terminal === "cancel") {
      await service.cancel("codex-desktop");
    } else if (terminal === "close") {
      await service.close();
    } else {
      scheduler.fireNext();
    }
    const result = await settlesWithin(binding);
    assert.notEqual(result, "timeout", `${terminal} must not wait for launch`);
    if (result !== "timeout") {
      assert.deepEqual(result, {
        endpointId: "codex-desktop",
        action,
        effect: terminal === "timeout" ? "timed-out" : "cancelled",
        request: "not-started",
        authentication: "unknown",
      });
    }

    launch.resolve(child);
    await tick();
    await tick();
    assert.equal(child.terminateCalls(), 1);
    await service.close();
  }
});

test("cancellation before an action request starts cannot establish state from a premature inspection", async () => {
  const launch = deferred<SubscriptionAuthenticationChild>();
  const child = controlledChild();
  let inspections = 0;
  const service = createSubscriptionAuthenticationService({
    providers: [
      Object.freeze({
        endpointId: "codex-desktop" as const,
        launchLogin: () => launch.promise,
        launchLogout: () => launch.promise,
        async inspectAuthentication() {
          inspections += 1;
          return "bound" as const;
        },
      }),
    ],
    timeoutMilliseconds: 30_000,
  });

  const action = service.requestAction("codex-desktop", "logout");
  await tick();
  await service.cancel("codex-desktop");
  assert.deepEqual(await action, {
    endpointId: "codex-desktop",
    action: "logout",
    effect: "cancelled",
    request: "not-started",
    authentication: "unknown",
  });
  assert.equal(inspections, 0);

  launch.resolve(child);
  await tick();
  await tick();
  assert.equal(child.terminateCalls(), 1);
  await service.close();
});

test("a cancelled deferred launch keeps the endpoint lane reserved until its late exact child exits", async () => {
  const firstLaunch = deferred<SubscriptionAuthenticationChild>();
  const firstChild = controlledChild({ terminateDoesNotFinish: true });
  const secondChild = controlledChild();
  let launches = 0;
  const service = createSubscriptionAuthenticationService({
    providers: [
      Object.freeze({
        endpointId: "codex-desktop" as const,
        launchLogin() {
          launches += 1;
          return launches === 1
            ? firstLaunch.promise
            : Promise.resolve(secondChild);
        },
        launchLogout() {
          launches += 1;
          return launches === 1
            ? firstLaunch.promise
            : Promise.resolve(secondChild);
        },
        async inspectAuthentication() {
          return "unknown" as const;
        },
      }),
    ],
    timeoutMilliseconds: 30_000,
  });

  const firstAction = service.requestAction("codex-desktop", "logout");
  await tick();
  await service.cancel("codex-desktop");
  assert.equal((await firstAction).request, "not-started");
  assert.equal(
    (await service.requestAction("codex-desktop", "login")).request,
    "not-started",
  );
  assert.equal(launches, 1);

  firstLaunch.resolve(firstChild);
  await tick();
  await tick();
  assert.equal(firstChild.terminateCalls(), 1);
  assert.equal(
    (await service.requestAction("codex-desktop", "login")).request,
    "not-started",
  );
  assert.equal(launches, 1);

  firstChild.finish();
  await tick();
  const secondAction = service.requestAction("codex-desktop", "login");
  await tick();
  assert.equal(launches, 2);
  secondChild.finish();
  await secondAction;
  await service.close();
});

test("close terminates an already-started exact child and cannot establish authentication", async () => {
  const child = controlledChild();
  let inspections = 0;
  const service = createSubscriptionAuthenticationService({
    providers: [
      Object.freeze({
        endpointId: "claude-code-desktop" as const,
        async launchLogin() {
          return child;
        },
        async launchLogout() {
          return child;
        },
        async inspectAuthentication() {
          inspections += 1;
          return "bound" as const;
        },
      }),
    ],
    timeoutMilliseconds: 30_000,
  });

  const action = service.requestAction("claude-code-desktop", "logout");
  await tick();
  await service.close();
  assert.deepEqual(await action, {
    endpointId: "claude-code-desktop",
    action: "logout",
    effect: "cancelled",
    request: "started",
    authentication: "unknown",
  });
  assert.equal(child.terminateCalls(), 1);
  assert.equal(inspections, 0);
  await service.close();
  assert.equal(child.terminateCalls(), 1);
});

test("post-action inspection timeout is bounded and establishes only unknown", async () => {
  const scheduler = controlledScheduler();
  const child = controlledChild();
  const service = createSubscriptionAuthenticationService({
    providers: [
      Object.freeze({
        endpointId: "claude-code-desktop" as const,
        async launchLogin() {
          return child;
        },
        async launchLogout() {
          throw new Error("not used");
        },
        inspectAuthentication: () => new Promise<never>(() => undefined),
      }),
    ],
    scheduler,
    timeoutMilliseconds: 30_000,
    inspectionTimeoutMilliseconds: 2_000,
  });

  const binding = service.requestAction("claude-code-desktop", "login");
  await tick();
  child.finish();
  await tick();
  scheduler.fireNext();
  assert.deepEqual(await settlesWithin(binding), {
    endpointId: "claude-code-desktop",
    action: "login",
    effect: "finished",
    request: "started",
    authentication: "unknown",
  });
  await service.close();
});

test("closed service never launches or inspects a provider", async () => {
  let launches = 0;
  let inspections = 0;
  const service = createSubscriptionAuthenticationService({
    providers: [
      Object.freeze({
        endpointId: "codex-desktop" as const,
        async launchLogin() {
          launches += 1;
          return controlledChild();
        },
        async launchLogout() {
          launches += 1;
          return controlledChild();
        },
        async inspectAuthentication() {
          inspections += 1;
          return "bound" as const;
        },
      }),
    ],
    timeoutMilliseconds: 30_000,
  });
  await service.close();

  assert.deepEqual(await service.inspect("codex-desktop"), {
    endpointId: "codex-desktop",
    authentication: "unknown",
  });
  assert.deepEqual(await service.bind("codex-desktop"), {
    endpointId: "codex-desktop",
    effect: "launch-failed",
    authentication: "unknown",
  });
  assert.deepEqual(
    await service.requestAction("codex-desktop", "logout"),
    {
      endpointId: "codex-desktop",
      action: "logout",
      effect: "launch-failed",
      request: "not-started",
      authentication: "unknown",
    },
  );
  assert.deepEqual(await service.cancel("codex-desktop"), {
    endpointId: "codex-desktop",
    effect: "cancelled",
    authentication: "unknown",
  });
  assert.equal(launches, 0);
  assert.equal(inspections, 0);
});

test("cancel and close abort the provider launch token before they settle", async () => {
  const launch = deferred<SubscriptionAuthenticationChild>();
  let capturedSignal: AbortSignal | undefined;
  const service = createSubscriptionAuthenticationService({
    providers: [
      Object.freeze({
        endpointId: "claude-code-desktop" as const,
        launchLogin(signal: AbortSignal) {
          capturedSignal = signal;
          return launch.promise;
        },
        launchLogout(signal: AbortSignal) {
          capturedSignal = signal;
          return launch.promise;
        },
        async inspectAuthentication() {
          return "unknown" as const;
        },
      }),
    ],
    timeoutMilliseconds: 30_000,
  });
  const binding = service.bind("claude-code-desktop");
  await tick();
  assert.equal(capturedSignal?.aborted, false);

  assert.equal((await service.cancel("claude-code-desktop")).effect, "cancelled");
  assert.equal(capturedSignal?.aborted, true);
  await service.close();
  assert.equal((await binding).effect, "cancelled");
});

function provider(
  endpointId: "claude-code-desktop" | "codex-desktop",
  launch: () => ReturnType<typeof controlledChild>,
  authentication: "bound" | "sign-in-required" = "sign-in-required",
): SubscriptionAuthenticationProvider {
  return Object.freeze({
    endpointId,
    async launchLogin() {
      return launch();
    },
    async launchLogout() {
      return launch();
    },
    async inspectAuthentication() {
      return authentication;
    },
  });
}

function controlledChild(options: {
  readonly terminateFailure?: boolean;
  readonly terminateDoesNotFinish?: boolean;
} = {}) {
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  let terminationCount = 0;
  return Object.freeze({
    finished,
    finish: resolveFinished,
    terminateCalls: () => terminationCount,
    async terminate() {
      terminationCount += 1;
      if (options.terminateFailure) throw new Error("private native shutdown");
      if (!options.terminateDoesNotFinish) resolveFinished();
    },
  });
}

function controlledScheduler(): SubscriptionAuthenticationScheduler & {
  fireNext(): void;
} {
  let identifier = 0;
  const callbacks = new Map<number, () => void>();
  return Object.freeze({
    setTimeout(callback: () => void) {
      identifier += 1;
      callbacks.set(identifier, callback);
      return identifier;
    },
    clearTimeout(handle: unknown) {
      if (typeof handle === "number") callbacks.delete(handle);
    },
    fireNext() {
      const entry = callbacks.entries().next().value as
        | readonly [number, () => void]
        | undefined;
      assert.notEqual(entry, undefined);
      if (entry === undefined) return;
      callbacks.delete(entry[0]);
      entry[1]();
    },
  });
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => {
    resolve = accept;
  });
  return Object.freeze({ promise, resolve });
}

async function settlesWithin<Value>(promise: Promise<Value>): Promise<Value | "timeout"> {
  return Promise.race([
    promise,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 25)),
  ]);
}
