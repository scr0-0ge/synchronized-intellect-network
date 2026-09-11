import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderToString } from "solid-js/web";
import type { Plugin } from "vite";
import solid from "vite-plugin-solid";

import { publicRuntimeEndpointDiscovery } from "../../src/workbench-shell/contract.ts";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";
import {
  beginSettingsSubscriptionAuthenticationAction,
  beginSettingsSubscriptionAuthenticationInspection,
  beginSettingsSubscriptionAuthenticationPreparation,
  clearSettingsSubscriptionAuthenticationConfirmation,
  completeSettingsSubscriptionAuthenticationPartialOutcome,
  completeSettingsSubscriptionAuthenticationResponse,
  initialSettingsSubscriptionAuthenticationState,
  settingsSubscriptionAuthenticationPresentation,
} from "../../src/workbench-shell/renderer/settings-view-model.ts";
import {
  beginDirectSessionProfileLoad,
  completeDirectSessionProfileLoad,
  hasHostedProjectView,
  initialRendererState,
  replaceProjectResult,
  selectedCommand,
} from "../../src/workbench-shell/renderer/view-model.ts";
import { emptyVisualFixture } from "./visual-harness/fixture.ts";
import { presentationText } from "../../src/workbench-shell/renderer/presentation-text.ts";
import { setLocale as setDirectLocale } from "../../src/workbench-shell/renderer/locale.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const noOp = (): void => undefined;
const credentialControlPattern =
  /\b(?:password|api\s*key|token|credential(?:s|\s*file)?)\b/iu;

function htmlAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(
    `\\b${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "iu",
  ).exec(attributes);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function plainControlText(html: string): string {
  return html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
}

function settingsControlSurface(html: string): string {
  const match = /<main\b[^>]*\bclass="settings"[^>]*>[\s\S]*<\/main>/u.exec(
    html,
  );
  assert.ok(match, "missing Settings control ownership seam");
  return match[0];
}

function assertNoCredentialEntryControls(settingsHtml: string): void {
  const labelsByControlId = new Map<string, string[]>();
  const textByElementId = new Map<string, string>();
  for (const match of settingsHtml.matchAll(
    /<(label|span|b|strong|p|h[1-6])\b([^>]*)>([\s\S]*?)<\/\1>/giu,
  )) {
    const elementId = htmlAttribute(match[2] ?? "", "id");
    if (elementId !== undefined) {
      textByElementId.set(elementId, plainControlText(match[3] ?? ""));
    }
  }
  for (const match of settingsHtml.matchAll(
    /<label\b([^>]*)>([\s\S]*?)<\/label>/giu,
  )) {
    const controlId = htmlAttribute(match[1] ?? "", "for");
    if (controlId === undefined) continue;
    const labels = labelsByControlId.get(controlId) ?? [];
    labels.push(plainControlText(match[2] ?? ""));
    labelsByControlId.set(controlId, labels);
  }

  for (const match of settingsHtml.matchAll(
    /<(button|select|textarea)\b([^>]*)>([\s\S]*?)<\/\1>|<input\b([^>]*)\/?\s*>/giu,
  )) {
    const tagName = (match[1] ?? "input").toLocaleLowerCase("en-US");
    const attributes = match[2] ?? match[4] ?? "";
    const controlId = htmlAttribute(attributes, "id");
    const labelledBy = (htmlAttribute(attributes, "aria-labelledby") ?? "")
      .split(/\s+/u)
      .filter((id) => id.length > 0);
    const descriptor = [
      tagName,
      ...[
        "type",
        "name",
        "aria-label",
        "aria-labelledby",
        "placeholder",
        "autocomplete",
        "accept",
        "title",
      ].map((name) => htmlAttribute(attributes, name) ?? ""),
      ...(controlId === undefined
        ? []
        : [controlId, ...(labelsByControlId.get(controlId) ?? [])]),
      ...labelledBy.map((id) => textByElementId.get(id) ?? ""),
      plainControlText(match[3] ?? ""),
    ]
      .join(" ")
      .replace(/([a-z])([A-Z])/gu, "$1 $2")
      .replace(/[_-]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    assert.doesNotMatch(
      descriptor,
      credentialControlPattern,
      `Settings credential entry control exposed: ${descriptor}`,
    );
  }
}

test("Settings credential-control guard rejects entry surfaces without rejecting subscription OAuth", () => {
  for (const allowed of [
    '<p>This page never asks for a password, API key or token, never reads a credential file, and never stores credentials.</p><button type="button">Login</button>',
    '<button type="button" aria-label="Login Codex subscription authentication">Login</button>',
    '<button type="button" aria-label="Log out Claude subscription authentication">Log out</button>',
  ]) {
    assert.doesNotThrow(() => assertNoCredentialEntryControls(allowed));
  }

  for (const forbidden of [
    '<label for="provider-secret">Password</label><input id="provider-secret" type="password">',
    '<label for="provider-secret">API key</label><input id="provider-secret" type="text">',
    '<span id="provider-secret-label">API key</span><input aria-labelledby="provider-secret-label">',
    '<textarea aria-label="Paste access token"></textarea>',
    '<select name="authenticationToken"><option>Stored value</option></select>',
    '<button type="button">Choose credential file</button>',
    '<button type="button" aria-label="Manage credentials">Configure</button>',
    '<input type="file" aria-label="Credential file">',
  ]) {
    assert.throws(
      () => assertNoCredentialEntryControls(forbidden),
      /Settings credential entry control exposed/u,
    );
  }
});

test("Settings models exact D20 inspection, guard, confirmation, pending, and fresh-state transitions", () => {
  const discovery = publicRuntimeEndpointDiscovery([
    { endpointId: "codex-desktop", category: "catalog-ready" },
    { endpointId: "claude-code-desktop", category: "authentication-required" },
  ]);
  const initial = initialSettingsSubscriptionAuthenticationState(discovery);
  assert.deepEqual(initial["codex-desktop"]!, {
    authentication: "unknown",
    inspectionPending: false,
    preparationPending: null,
    pendingAction: null,
    outcome: null,
    feedback: null,
    signInUrl: null,
    blockers: null,
    confirmation: null,
  });

  for (const category of [
    "catalog-ready",
    "authentication-required",
    "inspection-failed",
    "runtime-not-located",
    "not-inspected",
  ] as const) {
    const catalogOnly = initialSettingsSubscriptionAuthenticationState(
      publicRuntimeEndpointDiscovery([
        { endpointId: "codex-desktop", category },
        { endpointId: "claude-code-desktop", category },
      ]),
    );
    assert.deepEqual(
      [
        catalogOnly["codex-desktop"]!.authentication,
        catalogOnly["claude-code-desktop"]!.authentication,
      ],
      ["unknown", "unknown"],
      `catalog ${category} must not imply subscription authentication`,
    );
  }

  const inspecting = beginSettingsSubscriptionAuthenticationInspection(
    initial,
    "codex-desktop",
  );
  assert.equal(inspecting["codex-desktop"]!.inspectionPending, true);
  assert.match(
    presentationText(inspecting["codex-desktop"]!.feedback) ?? "",
    /re-check subscription sign-in/u,
  );
  const signedOut = completeSettingsSubscriptionAuthenticationResponse(
    inspecting,
    "codex-desktop",
    { kind: "authentication-state", state: "sign-in-required" },
  );
  assert.equal(signedOut["codex-desktop"]!.inspectionPending, false);
  assert.equal(signedOut["codex-desktop"]!.authentication, "sign-in-required");

  const preparing = beginSettingsSubscriptionAuthenticationPreparation(
    signedOut,
    "codex-desktop",
    "login",
  );
  assert.equal(preparing["codex-desktop"]!.preparationPending, "login");
  assert.equal(
    settingsSubscriptionAuthenticationPresentation(
      preparing["codex-desktop"]!,
    ).pending,
    true,
  );
  assert.equal(
    beginSettingsSubscriptionAuthenticationPreparation(
      preparing,
      "codex-desktop",
      "login",
    ),
    preparing,
  );

  const blocked = completeSettingsSubscriptionAuthenticationResponse(
    preparing,
    "codex-desktop",
    {
      kind: "blocked",
      blockers: {
        accepted: 1,
        starting: 2,
        inFlight: 3,
        recoveryRequired: 4,
        unknown: 5,
      },
    },
  );
  assert.deepEqual(
    settingsSubscriptionAuthenticationPresentation(
      blocked["codex-desktop"]!,
    ),
    {
      label: "Sign-in required",
      tone: "warn",
      detail:
        "The provider CLI reports that subscription sign-in is required.",
      actionLabel: "Login",
      action: "login",
      pending: false,
      inspectionPending: false,
      outcome: null,
      feedback: null,
      blockedStatement: "Login is blocked.",
      blockers: [
        { label: "Accepted", count: 1 },
        { label: "Starting", count: 2 },
        { label: "Running", count: 3 },
        { label: "Recovery required", count: 4 },
        { label: "Unknown", count: 5 },
      ],
    },
  );

  const confirmation = completeSettingsSubscriptionAuthenticationResponse(
    signedOut,
    "codex-desktop",
    {
      kind: "confirmation-required",
      preparationKey: "opaque-preparation-01",
      consequences: { resumableSessionCount: 2, projectCount: 1 },
    },
  );
  assert.deepEqual(confirmation["codex-desktop"]!.confirmation, {
    preparationKey: "opaque-preparation-01",
    action: "login",
    resumableSessionCount: 2,
    projectCount: 1,
  });
  assert.equal(
    clearSettingsSubscriptionAuthenticationConfirmation(
      confirmation,
      "codex-desktop",
    )["codex-desktop"]!.confirmation,
    null,
  );

  const pending = beginSettingsSubscriptionAuthenticationAction(
    confirmation,
    "codex-desktop",
    "login",
  );
  const requested = completeSettingsSubscriptionAuthenticationResponse(
    pending,
    "codex-desktop",
    { kind: "authentication-action-requested", action: "login" },
  );
  assert.equal(requested["codex-desktop"]!.pendingAction, "login");
  // The sentence must still open by naming what the Workbench did, and must
  // now also say where the sign-in happens, that this window cannot show it,
  // and what the reader does if it did not work. Reporting only the first
  // clause is F-w187 / public issue #4.
  const requestedFeedback = presentationText(
    requested["codex-desktop"]!.feedback,
  );
  assert.match(
    requestedFeedback ?? "",
    /^The Workbench asked the provider CLI to log in\./,
  );
  assert.match(requestedFeedback ?? "", /no window and no console/);
  assert.match(requestedFeedback ?? "", /reports the sign-in state once that CLI exits/);
  assert.match(requestedFeedback ?? "", /run the provider CLI's own sign-in command in a terminal/);
  assert.match(requestedFeedback ?? "", /Re-check sign-in/);
  assert.equal(
    typeof requested["codex-desktop"]!.feedback === "string"
      ? null
      : requested["codex-desktop"]!.feedback?.key,
    "authentication.login.requested",
  );
  assert.equal(requested["codex-desktop"]!.outcome, "requested");
  const fresh = completeSettingsSubscriptionAuthenticationResponse(
    requested,
    "codex-desktop",
    { kind: "authentication-state", state: "bound" },
  );
  assert.equal(fresh["codex-desktop"]!.pendingAction, null);
  assert.equal(fresh["codex-desktop"]!.authentication, "bound");
  assert.equal(fresh["codex-desktop"]!.outcome, null);
});

test("F115 the partial outcome is neither the success nor the failure state and names the lost resumability", () => {
  let state = initialSettingsSubscriptionAuthenticationState();
  state = completeSettingsSubscriptionAuthenticationResponse(
    state,
    "codex-desktop",
    { kind: "authentication-state", state: "bound" },
  );
  state = beginSettingsSubscriptionAuthenticationAction(
    state,
    "codex-desktop",
    "logout",
  );

  const notRequested = completeSettingsSubscriptionAuthenticationResponse(
    state,
    "codex-desktop",
    { kind: "authentication-action-not-requested", action: "logout" },
  );
  const partial = completeSettingsSubscriptionAuthenticationPartialOutcome(
    state,
    "codex-desktop",
    "logout",
  );
  const requested = completeSettingsSubscriptionAuthenticationResponse(
    state,
    "codex-desktop",
    { kind: "authentication-action-requested", action: "logout" },
  );

  assert.deepEqual(
    [
      notRequested["codex-desktop"]!.outcome,
      partial["codex-desktop"]!.outcome,
      requested["codex-desktop"]!.outcome,
    ],
    ["not-requested", "partially-completed", "requested"],
  );
  assert.equal(
    presentationText(partial["codex-desktop"]!.feedback),
    "The Workbench asked the provider CLI to log out but could not record the log out. Sessions started before this log out can no longer be resumed, even where the Workbench still offers to resume them.",
  );
  assert.notEqual(
    presentationText(partial["codex-desktop"]!.feedback),
    presentationText(notRequested["codex-desktop"]!.feedback),
  );
  assert.notEqual(
    presentationText(partial["codex-desktop"]!.feedback),
    presentationText(requested["codex-desktop"]!.feedback),
  );
  assert.match(
    presentationText(partial["codex-desktop"]!.feedback) ?? "",
    /can no longer be resumed/u,
  );
  assert.equal(
    settingsSubscriptionAuthenticationPresentation(partial["codex-desktop"]!)
      .outcome,
    "partially-completed",
  );

  const partialLogin = completeSettingsSubscriptionAuthenticationPartialOutcome(
    state,
    "claude-code-desktop",
    "login",
  );
  assert.match(
    presentationText(partialLogin["claude-code-desktop"]!.feedback) ?? "",
    /could not record the sign-in change/u,
  );
  assert.match(
    presentationText(partialLogin["claude-code-desktop"]!.feedback) ?? "",
    /can no longer be resumed/u,
  );

  // A partial outcome must never be describable as success anywhere.
  for (const entry of [partial, partialLogin]) {
    assert.equal(JSON.stringify(entry).includes("success"), false);
  }

  // The same transition is reachable from the public response itself, so the
  // sentence survives the seam instead of being reconstructed behind it.
  const fromResponse = completeSettingsSubscriptionAuthenticationResponse(
    state,
    "codex-desktop",
    { kind: "authentication-action-partially-completed", action: "logout" },
  );
  assert.deepEqual(
    {
      ...fromResponse["codex-desktop"]!,
      feedback: presentationText(fromResponse["codex-desktop"]!.feedback),
    },
    {
      ...partial["codex-desktop"]!,
      feedback: presentationText(partial["codex-desktop"]!.feedback),
    },
  );
  assert.equal(
    typeof fromResponse["codex-desktop"]!.feedback === "string"
      ? null
      : fromResponse["codex-desktop"]!.feedback?.key,
    "authentication.logout.partially-completed",
  );
  assert.equal(fromResponse["codex-desktop"]!.outcome, "partially-completed");
  // The card is left usable: nothing else will arrive to release it, and a
  // fresh inspection would replace the sentence that names what was lost.
  assert.equal(fromResponse["codex-desktop"]!.pendingAction, null);
  assert.equal(
    presentationText(notRequested["codex-desktop"]!.feedback),
    "The Workbench could not ask the provider CLI to log out. Nothing changed, and every Session stays exactly as resumable as it was.",
  );
  assert.equal(
    typeof notRequested["codex-desktop"]!.feedback === "string"
      ? null
      : notRequested["codex-desktop"]!.feedback?.key,
    "authentication.logout.not-requested",
  );
});

test("existing provider cards render independent states, exact copy, blockers, and inline consequence controls", async () => {
  const exposeWorkbenchScreen: Plugin = {
    name: "expose-subscription-authentication-settings-screen",
    enforce: "pre",
    transform(source, id) {
      if (
        id
          .replaceAll("\\", "/")
          .endsWith("/src/workbench-shell/renderer/mount.tsx")
      ) {
        return source.replace(
          "const WorkbenchScreen",
          "export const WorkbenchScreen",
        );
      }
    },
  };
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [exposeWorkbenchScreen, solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });
  try {
    const module = {
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/mount.tsx",
      )),
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/locale.ts",
      )),
    } as {
      readonly WorkbenchScreen: (
        props: Readonly<Record<string, unknown>>,
      ) => unknown;
      readonly setLocale: (locale: "en" | "zh-CN") => void;
    };
    setDirectLocale("en");
    module.setLocale("en");
    const project = replaceProjectResult(initialRendererState, {
      ok: true,
      view: emptyVisualFixture,
    });
    const state = completeDirectSessionProfileLoad(
      beginDirectSessionProfileLoad(project),
      {
        ok: false,
        endpointDiscovery: publicRuntimeEndpointDiscovery([
          { endpointId: "codex-desktop", category: "authentication-required" },
          {
            endpointId: "claude-code-desktop",
            category: "authentication-required",
          },
        ]),
        error: {
          category: "profile-unavailable",
          message:
            "Codex Session Profile options are unavailable. Keep your draft and try again.",
        },
      },
    );
    let authentication = initialSettingsSubscriptionAuthenticationState();
    authentication = completeSettingsSubscriptionAuthenticationResponse(
      authentication,
      "codex-desktop",
      { kind: "authentication-state", state: "bound" },
    );
    authentication = completeSettingsSubscriptionAuthenticationResponse(
      authentication,
      "codex-desktop",
      {
        kind: "blocked",
        blockers: {
          accepted: 1,
          starting: 0,
          inFlight: 2,
          recoveryRequired: 0,
          unknown: 0,
        },
      },
    );
    authentication = completeSettingsSubscriptionAuthenticationResponse(
      authentication,
      "claude-code-desktop",
      { kind: "authentication-state", state: "sign-in-required" },
    );
    authentication = completeSettingsSubscriptionAuthenticationResponse(
      authentication,
      "claude-code-desktop",
      {
        kind: "confirmation-required",
        preparationKey: "opaque-preparation-02",
        consequences: { resumableSessionCount: 3, projectCount: 2 },
      },
    );
    const html = renderSettings(
      module.WorkbenchScreen,
      state,
      authentication,
    );
    const visibleHtml = html.replace(/<!--(?:\$|\/)-->/gu, "");

    assert.match(
      visibleHtml,
      /aria-label="Codex subscription authentication: Bound"/u,
    );
    assert.match(visibleHtml, /Log out is blocked\./u);
    assert.match(visibleHtml, /Accepted:\s*1/u);
    assert.match(visibleHtml, /Running:\s*2/u);
    assert.match(
      visibleHtml,
      /<button[^>]*disabled[^>]*aria-label="Log out Codex subscription authentication"[^>]*>Log out/u,
    );
    assert.match(
      visibleHtml,
      /aria-label="Claude subscription authentication: Sign-in required"/u,
    );
    assert.match(
      visibleHtml,
      /Recorded conversations stay in the Workbench\. Resumable Sessions for this provider will no longer be resumable when this authentication action begins\./u,
    );
    assert.match(visibleHtml, /Resumable Sessions:\s*3; Projects:\s*2/u);
    assert.match(visibleHtml, />Continue with Login</u);
    assert.match(visibleHtml, />Cancel</u);
    assert.match(
      visibleHtml,
      /Subscription credentials never pass through the Workbench/u,
    );
    assert.match(
      visibleHtml,
      /Subscription sign-in happens in each provider's own app\. This page never asks for a subscription password or token, never reads a subscription credential file, and never stores subscription credentials\. The exceptions — the API keys of the API-key endpoints — are each disclosed in that provider's API key section below\./u,
    );
    assert.doesNotMatch(
      visibleHtml,
      /--bare|private account|Signed in as/iu,
    );
    assert.doesNotMatch(html, /--bare/u);
    assertNoCredentialEntryControls(settingsControlSurface(visibleHtml));

    let storedFeedback = initialSettingsSubscriptionAuthenticationState();
    storedFeedback = completeSettingsSubscriptionAuthenticationResponse(
      storedFeedback,
      "codex-desktop",
      { kind: "authentication-state", state: "bound" },
    );
    storedFeedback = completeSettingsSubscriptionAuthenticationResponse(
      storedFeedback,
      "codex-desktop",
      { kind: "authentication-action-partially-completed", action: "logout" },
    );
    const englishStored = renderSettings(
      module.WorkbenchScreen,
      state,
      storedFeedback,
    );
    assert.equal(
      renderedProviderBindingFeedback(englishStored),
      "The Workbench asked the provider CLI to log out but could not record the log out. Sessions started before this log out can no longer be resumed, even where the Workbench still offers to resume them.",
    );

    setDirectLocale("zh-CN");
    module.setLocale("zh-CN");
    const chineseStored = renderSettings(
      module.WorkbenchScreen,
      state,
      storedFeedback,
    );
    assert.equal(
      renderedProviderBindingFeedback(chineseStored),
      "Workbench 已要求提供方 CLI 退出登录，但无法记录这次退出。在这次退出前启动的会话已无法恢复，即使 Workbench 仍显示恢复选项。",
    );
    assert.doesNotMatch(
      chineseStored,
      /asked the provider CLI to log out/u,
    );

    setDirectLocale("en");
    module.setLocale("en");
    assert.equal(
      renderSettings(module.WorkbenchScreen, state, storedFeedback),
      englishStored,
    );

    // F-w187 / public issue #4. A sign-in link the CLI printed reaches the card
    // verbatim and copyable; a card that received none shows nothing at all.
    const syntheticSignInUrl =
      "https://auth.example.invalid/oauth/authorize?code=SYNTHETIC-NOT-A-REAL-CODE";
    let withLink = initialSettingsSubscriptionAuthenticationState();
    withLink = completeSettingsSubscriptionAuthenticationResponse(
      withLink,
      "codex-desktop",
      { kind: "authentication-state", state: "sign-in-required" },
    );
    const withoutLinkHtml = renderSettings(
      module.WorkbenchScreen,
      state,
      withLink,
    ).replace(/<!--(?:\$|\/)-->/gu, "");
    assert.doesNotMatch(withoutLinkHtml, /provider-auth-signin-url/u);
    assert.doesNotMatch(withoutLinkHtml, /Sign-in link from the provider CLI/u);

    withLink = completeSettingsSubscriptionAuthenticationResponse(
      withLink,
      "codex-desktop",
      { kind: "authentication-sign-in-url", url: syntheticSignInUrl },
    );
    const withLinkHtml = renderSettings(
      module.WorkbenchScreen,
      state,
      withLink,
    ).replace(/<!--(?:\$|\/)-->/gu, "");
    assert.match(withLinkHtml, /Sign-in link from the provider CLI/u);
    assert.match(
      withLinkHtml,
      /The provider CLI printed this sign-in link\. If a browser opened, finish there and ignore this\. If none opened, open this link yourself\./u,
    );
    // Shown whole -- a reader who has to retype it needs every character -- and
    // never as a live anchor.
    assert.ok(
      withLinkHtml.includes(
        syntheticSignInUrl.replace(/&/gu, "&amp;"),
      ),
      "the sign-in link must be rendered verbatim",
    );
    assert.doesNotMatch(withLinkHtml, /<a[^>]*auth\.example\.invalid/u);
    assert.match(
      withLinkHtml,
      /aria-label="Copy the provider sign-in link"/u,
    );

    // A fresh inspected state ends the run, and a spent authorisation code must
    // not stay on the card offering a link that signs nobody in.
    withLink = completeSettingsSubscriptionAuthenticationResponse(
      withLink,
      "codex-desktop",
      { kind: "authentication-state", state: "bound" },
    );
    const afterStateHtml = renderSettings(
      module.WorkbenchScreen,
      state,
      withLink,
    ).replace(/<!--(?:\$|\/)-->/gu, "");
    assert.doesNotMatch(afterStateHtml, /auth\.example\.invalid/u);
    assert.doesNotMatch(afterStateHtml, /provider-auth-signin-url/u);
  } finally {
    setDirectLocale("en");
    await server.close();
  }
});

function renderSettings(
  Screen: (props: Readonly<Record<string, unknown>>) => unknown,
  state: ReturnType<typeof completeDirectSessionProfileLoad>,
  subscriptionAuthentication: unknown,
): string {
  assert.equal(hasHostedProjectView(state.result), true);
  if (!hasHostedProjectView(state.result)) assert.fail("Expected a Project view.");
  const view = state.result.view;
  return renderToString(() =>
    Screen({
      view,
      surface: "settings",
      selected: selectedCommand(view, state.selectedKey),
      composer: state.composer,
      profile: state.profile,
      subscriptionAuthentication,
      appearance: {
        tone: "dark",
        crt: "screen",
        phosphor: "neutral",
        phosphorTier: "b",
      },
      appearancePersistencePhase: "saved",
      claudePermissionHandling: "without-asking",
      claudePermissionHandlingPersistencePhase: "saved",
      newSession: state.newSession,
      projectSwitch: state.projectSwitch,
      projectOpen: state.projectOpen,
      canCreateProject: () => true,
      canOpenProject: () => true,
      canSelectProject: () => true,
      onSurface: noOp,
      onAppearance: noOp,
      onClaudePermissionHandling: noOp,
      onCreateProject: noOp,
      onOpenProject: noOp,
      onSelectProject: noOp,
      onSelect: noOp,
      onDraft: noOp,
      onLoadProfile: noOp,
      onRefreshProfile: noOp,
      onBindSubscriptionAuthentication: noOp,
      onBeginSubscriptionAuthentication: noOp,
      onCancelSubscriptionAuthentication: noOp,
      onEnterNewSession: noOp,
      onEnterReplacementSession: noOp,
      onCancelNewSession: noOp,
      onEndpoint: noOp,
      onModel: noOp,
      onWorkIntensity: noOp,
      onExecutionMode: noOp,
      onAccessMode: noOp,
      onUseAsDefault: noOp,
      onSubmit: noOp,
    }),
  );
}

function renderedProviderBindingFeedback(html: string): string {
  const rendered = html.replace(/<!--(?:\$|\/)-->/gu, "");
  const classIndex = rendered.indexOf(
    'class="provider-binding-feedback"',
  );
  assert.notEqual(classIndex, -1, "rendered provider authentication feedback");
  const contentStart = rendered.indexOf(">", classIndex) + 1;
  const contentEnd = rendered.indexOf("</p>", contentStart);
  assert.ok(contentStart > 0 && contentEnd >= contentStart);
  return rendered
    .slice(contentStart, contentEnd)
    .replace(/<[^>]+>/gu, "")
    .trim();
}
