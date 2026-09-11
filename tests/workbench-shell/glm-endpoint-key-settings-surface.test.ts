import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderToString } from "solid-js/web";
import solid from "vite-plugin-solid";

import { publicRuntimeEndpointDiscovery } from "../../src/workbench-shell/contract.ts";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";
import {
  beginDirectSessionProfileLoad,
  completeDirectSessionProfileLoad,
  initialRendererState,
  replaceProjectResult,
} from "../../src/workbench-shell/renderer/view-model.ts";
import { emptyVisualFixture } from "./visual-harness/fixture.ts";
import type {
  WorkbenchEndpointKeyPanel,
} from "../../src/workbench-shell/renderer/endpoint-key-state.ts";
import type { WorkbenchEndpointBaseUrlPanel } from "../../src/workbench-shell/renderer/endpoint-base-url-state.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function panel(
  overrides: Partial<WorkbenchEndpointKeyPanel> = {},
): WorkbenchEndpointKeyPanel {
  return Object.freeze({
    phase: "ready",
    snapshot: {
      configured: true,
      maskedHint: "••••4321",
      isPersistent: true,
      environmentFallback: false,
    },
    draft: "",
    busy: null,
    revealed: false,
    revealedValue: null,
    probeOutcome: null,
    feedback: null,
    onDraft: () => undefined,
    onSave: () => undefined,
    onReveal: () => undefined,
    onHideReveal: () => undefined,
    onRemove: () => undefined,
    onProbe: () => undefined,
    ...overrides,
  });
}

function baseUrlPanel(): WorkbenchEndpointBaseUrlPanel {
  return Object.freeze({
    phase: "ready",
    savedBaseUrl: "",
    draft: "",
    busy: false,
    feedback: null,
    onDraft: () => undefined,
    onSave: () => undefined,
  });
}

async function loadSettingsScreen() {
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });
  try {
    const module = (await server.ssrLoadModule(
      "/src/workbench-shell/renderer/settings.tsx",
    )) as {
      SettingsScreen: (props: Record<string, unknown>) => unknown;
    };
    return { server, SettingsScreen: module.SettingsScreen };
  } catch (error) {
    await server.close();
    throw error;
  }
}

function buildProfile() {
  const project = replaceProjectResult(initialRendererState, {
    ok: true,
    view: emptyVisualFixture,
  });
  const state = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(project),
    {
      ok: false,
      endpointDiscovery: publicRuntimeEndpointDiscovery([
        { endpointId: "codex-desktop", category: "not-inspected" },
        { endpointId: "claude-code-desktop", category: "not-inspected" },
        { endpointId: "glm-coding-plan", category: "not-inspected" },
        { endpointId: "kimi-code", category: "not-inspected" },
        { endpointId: "deepseek-api", category: "not-inspected" },
      ]),
      error: {
        category: "profile-unavailable",
        message:
          "Codex Session Profile options are unavailable. Keep your draft and try again.",
      },
    },
  );
  return state.profile;
}

/**
 * WO21 extended the endpoint-key roster with claude-api/codex-api; WO23 found
 * the renderer copy dictionary was not extended with them, so a Settings
 * render carrying their provider rows + key panels crashed the whole surface
 * (`Cannot read properties of undefined (reading 'heading')` out of
 * workbenchEndpointKeyCopy). This fixture is that exact harness shape.
 */
function buildApiTransportProfile() {
  const project = replaceProjectResult(initialRendererState, {
    ok: true,
    view: emptyVisualFixture,
  });
  const state = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(project),
    {
      ok: false,
      endpointDiscovery: publicRuntimeEndpointDiscovery([
        { endpointId: "codex-desktop", category: "not-inspected" },
        { endpointId: "claude-code-desktop", category: "not-inspected" },
        { endpointId: "glm-coding-plan", category: "not-inspected" },
        { endpointId: "kimi-code", category: "not-inspected" },
        { endpointId: "deepseek-api", category: "not-inspected" },
        { endpointId: "kimi-platform", category: "not-inspected" },
        { endpointId: "claude-api", category: "authentication-required" },
        { endpointId: "codex-api", category: "authentication-required" },
      ]),
      error: {
        category: "profile-unavailable",
        message:
          "Codex Session Profile options are unavailable. Keep your draft and try again.",
      },
    },
  );
  return state.profile;
}

/** Both Kimi backends present (ticket 20): the merged card's full fixture. */
function buildKimiFacadeProfile() {
  const project = replaceProjectResult(initialRendererState, {
    ok: true,
    view: emptyVisualFixture,
  });
  const state = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(project),
    {
      ok: false,
      endpointDiscovery: publicRuntimeEndpointDiscovery([
        { endpointId: "codex-desktop", category: "not-inspected" },
        { endpointId: "claude-code-desktop", category: "not-inspected" },
        { endpointId: "glm-coding-plan", category: "not-inspected" },
        { endpointId: "kimi-code", category: "authentication-required" },
        { endpointId: "deepseek-api", category: "not-inspected" },
        { endpointId: "kimi-platform", category: "authentication-required" },
      ]),
      error: {
        category: "profile-unavailable",
        message:
          "Codex Session Profile options are unavailable. Keep your draft and try again.",
      },
    },
  );
  return state.profile;
}

const noOp = (): void => undefined;

/**
 * Slice the rendered settings page into per-provider card texts. A provider
 * card's class attribute is exactly "provider" or, for the merged family
 * cards (tickets 20/25), "provider provider-kimi" / "provider
 * provider-claude" / "provider provider-codex" (the wrapper
 * provider-settings and provider-group sections do not match), and SSR may
 * place hydration attributes before it, so openings are located by regex;
 * each card closes at the nearest </section> with no nested section inside.
 */
function providerSections(html: string): string[] {
  const openings =
    /<section[^>]*class="provider(?: provider-(?:kimi|claude|codex))?"[^>]*>/gu;
  const sections: string[] = [];
  for (let match = openings.exec(html); match !== null; match = openings.exec(html)) {
    sections.push(
      html.slice(match.index + match[0].length, html.indexOf("</section>", match.index)),
    );
  }
  return sections;
}

function providerSection(html: string, headingId: string): string {
  const sections = providerSections(html);
  const section = sections.find((candidate) =>
    candidate.includes(`id="provider-${headingId}-heading"`),
  );
  assert.ok(section, `${headingId} provider row renders`);
  return section;
}

function assertOptionalBaseUrlDetails(section: string, headingId: string): void {
  assert.match(
    section,
    /<details[^>]*class="settings-details endpoint-base-url-details"[^>]*>[\s\S]*?<summary>Base URL \(optional\)<\/summary>[\s\S]*?Save base URL[\s\S]*?<\/details>/u,
    `${headingId}: optional Base URL belongs behind Details`,
  );
  assert.match(section, /<button[^>]*class="btn sm"[^>]*>Save key<\/button>/u);
  assert.match(section, /<button[^>]*class="btn ghost sm"[^>]*>Save base URL<\/button>/u);
}

function renderSettings(
  SettingsScreen: (props: Record<string, unknown>) => unknown,
  options: {
    readonly endpointKeyPanels?: Partial<
      Record<
        "glm-coding-plan" | "kimi-code" | "deepseek-api" | "claude-api" | "codex-api",
        WorkbenchEndpointKeyPanel
      >
    >;
    readonly endpointBaseUrlPanels?: Partial<
      Record<"glm-coding-plan" | "kimi-code" | "deepseek-api" | "codex-api", WorkbenchEndpointBaseUrlPanel>
    >;
    readonly profile?: ReturnType<typeof buildProfile>;
    readonly endpointPreferences?: {
      readonly claude: "claude-code-desktop" | "claude-api";
      readonly codex: "codex-desktop" | "codex-api";
      readonly kimi: "kimi-code" | "kimi-platform";
    };
  },
): string {
  return renderToString(() =>
    SettingsScreen({
      onClose: noOp,
      profile: options.profile ?? buildProfile(),
      appearance: {
        tone: "dark",
        crt: "screen",
        phosphor: "neutral",
        phosphorTier: "b",
        language: "en",
      },
      appearancePersistencePhase: "saved",
      claudePermissionHandling: "without-asking",
      claudePermissionHandlingPersistencePhase: "saved",
      onClaudePermissionHandling: noOp,
      endpointPreferences:
        options.endpointPreferences ?? {
          claude: "claude-code-desktop",
          codex: "codex-desktop",
          kimi: "kimi-code",
        },
      onEndpointPreference: noOp,
      ...(options.endpointKeyPanels === undefined
        ? {}
        : { endpointKeyPanels: options.endpointKeyPanels }),
      ...(options.endpointBaseUrlPanels === undefined
        ? {}
        : { endpointBaseUrlPanels: options.endpointBaseUrlPanels }),
      canRead: false,
      onRead: noOp,
    }),
  ).replace(/<!--(?:\$|\/)-->/gu, "");
}

test("the GLM key block lives inside the GLM provider row and renders the stored-key truth, the full DPAPI disclosure, and its actions", async () => {
  const { server, SettingsScreen } = await loadSettingsScreen();
  try {
    const html = renderSettings(SettingsScreen, {
      endpointKeyPanels: { "glm-coding-plan": panel() },
      endpointBaseUrlPanels: { "glm-coding-plan": baseUrlPanel() },
    });
    // Relocated layout (WO10): the key block sits inside the GLM provider
    // row, in the same actions slot where codex/claude rows place login
    // controls — not in a standalone section after the groups.
    const sections = providerSections(html);
    assert.equal(sections.length, 5, "one provider card per fixture endpoint");
    const glmSection = providerSection(html, "glm-coding-plan");
    assert.match(glmSection, /GLM Coding Plan/u);
    assert.match(glmSection, /provider-actions/u);
    assert.match(glmSection, /provider-binding-copy endpoint-key-copy/u);
    assert.match(glmSection, /endpoint-key-controls/u);
    assert.match(
      glmSection,
      /provider-binding-status endpoint-key-status ok/u,
    );
    // Login slot = key input slot: the GLM row carries no subscription
    // surface, and the subscription rows carry no key markup.
    assert.doesNotMatch(glmSection, /Subscription sign-in/u);
    assert.doesNotMatch(glmSection, /provider-auth-/u);
    for (const section of sections) {
      if (section === glmSection) continue;
      assert.doesNotMatch(section, /endpoint-key-/u);
    }
    assert.match(
      html,
      /encrypted with this OS user account \(DPAPI on Windows\) and stored in a local Workbench file\./u,
    );
    // ADR 0022 §4 both truths, always together.
    assert.match(
      html,
      /protects the key against offline disk inspection/u,
    );
    assert.match(
      html,
      /does not protect the key against processes already running as your user account/u,
    );
    assert.match(html, /Key saved · ••••4321/u);
    assert.match(
      html,
      /Stored durably for this OS user account\./u,
    );
    assert.match(
      html,
      /<label for="endpoint-key-input-glm-coding-plan">API key<\/label>/u,
    );
    assert.match(html, /type="password"/u);
    assert.match(html, />Save key</u);
    assertOptionalBaseUrlDetails(glmSection, "glm-coding-plan");
    assert.match(html, />Reveal key</u);
    assert.match(html, />Remove key</u);
    assert.match(html, />Check connection</u);
    // Exactly one credential entry input exists on the whole page — the
    // disclosed GLM one. The other inputs are the optional GLM Base URL and
    // the two Tools rows' typed executable paths, all plain text rather than
    // secrets.
    assert.equal(
      (html.match(/<input[^>]*type="password"/gu) ?? []).length,
      1,
      "exactly one credential input on the settings page",
    );
    assert.deepEqual(
      [...html.matchAll(/<input[^>]*\sid="([^"]+)"/gu)]
        .map((match) => match[1])
        .filter((id) => !id.startsWith("endpoint-key-input-"))
        .sort(),
      [
        "endpoint-base-url-input-glm-coding-plan",
        "runtime-executable-claude",
        "runtime-executable-codex",
      ],
      "the only non-credential inputs are the optional Base URL and two Tools executable paths",
    );
  } finally {
    await server.close();
  }
});

test("the Kimi key block renders its own placeholder, env fallback, and the shown-once × 5-keys warning", async () => {
  const { server, SettingsScreen } = await loadSettingsScreen();
  try {
    const html = renderSettings(SettingsScreen, {
      endpointKeyPanels: {
        "kimi-code": panel({
          snapshot: {
            configured: false,
            maskedHint: null,
            isPersistent: true,
            environmentFallback: true,
          },
        }),
        "deepseek-api": panel(),
      },
      endpointBaseUrlPanels: {
        "kimi-code": baseUrlPanel(),
        "deepseek-api": baseUrlPanel(),
      },
    });
    const kimiSection = providerSection(html, "kimi");
    assert.match(kimiSection, /endpoint-key-copy/u);
    assert.match(kimiSection, /No key saved/u);
    assert.match(kimiSection, /Paste your Kimi API key/u);
    assert.match(
      kimiSection,
      /Sessions currently fall back to the KIMI_CODE_ANTHROPIC_AUTH_TOKEN environment variable\./u,
    );
    // ADR 0022 two-truth sentence pattern reused verbatim.
    assert.match(
      kimiSection,
      /protects the key against offline disk inspection/u,
    );
    assert.match(
      kimiSection,
      /does not protect the key against processes already running as your user account/u,
    );
    // The Kimi key-handling warning (ticket 11: shown exactly once, at most
    // 5 keys) renders in the key block.
    assert.match(kimiSection, /exactly once/u);
    assert.match(kimiSection, /at most 5 keys/u);
    assert.match(
      kimiSection,
      /<label for="endpoint-key-input-kimi-code">API key<\/label>/u,
    );
    assertOptionalBaseUrlDetails(kimiSection, "kimi");
    assert.equal(
      (html.match(/<input[^>]*type="password"/gu) ?? []).length,
      2,
      "one credential input per rendered key block",
    );
    // The DeepSeek key block renders the same structure, and its copy never
    // says "plan" (ticket 12: the endpoint deliberately carries no
    // subscription wording anywhere).
    const deepseekSection = providerSection(html, "deepseek-api");
    assert.match(deepseekSection, /DeepSeek API/u);
    assert.match(deepseekSection, /endpoint-key-copy/u);
    assert.match(deepseekSection, /Paste your DeepSeek API key/u);
    assert.doesNotMatch(deepseekSection, /plan/iu);
    assertOptionalBaseUrlDetails(deepseekSection, "deepseek-api");
  } finally {
    await server.close();
  }
});

test("catalog freshness controls render supplied reports generically, including a non-production Kimi report fixture", async () => {
  const { server, SettingsScreen } = await loadSettingsScreen();
  try {
    const html = renderToString(() =>
      SettingsScreen({
        onClose: noOp,
        profile: buildProfile(),
        appearance: {
          tone: "dark",
          crt: "screen",
          phosphor: "neutral",
          phosphorTier: "b",
          language: "en",
        },
        appearancePersistencePhase: "saved",
        claudePermissionHandling: "without-asking",
        claudePermissionHandlingPersistencePhase: "saved",
        onClaudePermissionHandling: noOp,
        endpointPreferences: {
          claude: "claude-code-desktop",
          codex: "codex-desktop",
          kimi: "kimi-code",
        },
        onEndpointPreference: noOp,
        catalogFreshness: {
          unavailable: false,
          refreshing: false,
          onRefresh: noOp,
          reports: [
            {
              endpointId: "glm-coding-plan",
              status: "fresh",
              newModels: [
                {
                  id: "glm-6",
                  displayName: "GLM 6",
                  createdAt: "2026-09-05T00:00:00Z",
                },
              ],
              enrolledModels: [{ id: "glm-6", displayName: "GLM 6" }],
            },
            // Deliberately exercises the generic presentation path. Production
            // does not enroll Kimi Code because it has no verified
            // zero-inference models-list route.
            {
              endpointId: "kimi-code",
              status: "silent-failure",
              newModels: [],
              enrolledModels: [],
            },
          ],
        },
        canRead: false,
        onRead: noOp,
      }),
    ).replace(/<!--(?:\$|\/)-->/gu, "");
    const glmSection = providerSection(html, "glm-coding-plan");
    // The surfacing: count heading, id list, untiered marker, refresh action.
    assert.match(glmSection, /1 new model available/u);
    assert.match(glmSection, /GLM 6 · new \(untiered\)/u);
    assert.match(glmSection, />Check for new models</u);
    assert.match(glmSection, /endpoint-catalog-freshness/u);
    // A silent failure renders one calm sentence, no error chrome.
    const kimiSection = providerSection(html, "kimi");
    assert.match(
      kimiSection,
      /New models could not be checked just now\. The models you already have remain available\./u,
    );
    assert.match(kimiSection, />Check for new models</u);
    // The merged Claude/Codex family cards carry no freshness markup at all.
    for (const family of ["claude", "codex"]) {
      assert.doesNotMatch(
        providerSection(html, family),
        /endpoint-catalog-freshness/u,
      );
    }
  } finally {
    await server.close();
  }
});

test("unconfigured, degraded, environment-fallback, probe outcome, and absence render their exact states", async () => {  const { server, SettingsScreen } = await loadSettingsScreen();
  try {
    const render = (
      keyPanels?: Partial<
        Record<"glm-coding-plan", WorkbenchEndpointKeyPanel>
      >,
    ): string =>
      renderSettings(
        SettingsScreen,
        keyPanels === undefined ? {} : { endpointKeyPanels: keyPanels },
      );

    const unconfigured = render({
      "glm-coding-plan": panel({
        snapshot: {
          configured: false,
          maskedHint: null,
          isPersistent: true,
          environmentFallback: true,
        },
      }),
    });
    const unconfiguredGlm = providerSection(unconfigured, "glm-coding-plan");
    assert.match(unconfiguredGlm, /No key saved/u);
    assert.match(
      unconfiguredGlm,
      /provider-binding-status endpoint-key-status warn/u,
    );
    assert.match(
      unconfigured,
      /Sessions currently fall back to the GLM_ANTHROPIC_AUTH_TOKEN environment variable\./u,
    );

    const degraded = render({
      "glm-coding-plan": panel({
        snapshot: { ...panel().snapshot!, isPersistent: false },
      }),
    });
    assert.match(
      degraded,
      /Valid for this session only — the stored key will be gone after a restart\./u,
    );

    const probed = render({
      "glm-coding-plan": panel({
        probeOutcome: { outcome: "failure", reason: "unauthorized" },
      }),
    });
    assert.match(
      probed,
      /Connection failed: the endpoint rejected the key \(unauthorized\)\./u,
    );

    const unavailable = render({
      "glm-coding-plan": panel({ phase: "unavailable", snapshot: null }),
    });
    const unavailableGlm = providerSection(unavailable, "glm-coding-plan");
    assert.match(
      unavailableGlm,
      /Key management is unavailable in this window\. Keep the current key and try again\./u,
    );
    assert.doesNotMatch(unavailableGlm, /endpoint-key-controls/u);

    // Zero-diff ruling: without the panel the block does not render at all —
    // the GLM provider row itself stays, but carries none of the key markup.
    // (The guard sentence names the API-key sections, so pin the block's own
    // DOM markers instead of the phrase.)
    const without = render();
    const withoutGlm = providerSection(without, "glm-coding-plan");
    assert.doesNotMatch(without, /endpoint-key-copy/u);
    assert.doesNotMatch(without, /endpoint-key-controls/u);
    assert.doesNotMatch(without, /endpoint-key-input-/u);
    assert.doesNotMatch(without, /type="password"/u);
    assert.doesNotMatch(without, />Save key</u);
    assert.doesNotMatch(without, />Check connection</u);
    assert.doesNotMatch(withoutGlm, /endpoint-key-/u);
  } finally {
    await server.close();
  }
});

test("the merged Kimi card switches backends by segment and each side keeps its own full key management", async () => {
  const { server, SettingsScreen } = await loadSettingsScreen();
  try {
    const renderKimiCard = (
      preference: "kimi-code" | "kimi-platform",
    ): string =>
      renderToString(() =>
        SettingsScreen({
          onClose: noOp,
          profile: buildKimiFacadeProfile(),
          appearance: {
            tone: "dark",
            crt: "screen",
            phosphor: "neutral",
            phosphorTier: "b",
            language: "en",
          },
          appearancePersistencePhase: "saved",
          claudePermissionHandling: "without-asking",
          claudePermissionHandlingPersistencePhase: "saved",
          onClaudePermissionHandling: noOp,
          endpointPreferences: {
            claude: "claude-code-desktop",
            codex: "codex-desktop",
            kimi: preference,
          },
          onEndpointPreference: noOp,
          endpointKeyPanels: {
            "kimi-code": panel({
              snapshot: {
                configured: false,
                maskedHint: null,
                isPersistent: true,
                environmentFallback: false,
              },
            }),
            "kimi-platform": panel({
              snapshot: {
                configured: true,
                maskedHint: "••••9999",
                isPersistent: true,
                environmentFallback: false,
              },
            }),
          },
          canRead: false,
          onRead: noOp,
        }),
      ).replace(/<!--(?:\$|\/)-->/gu, "");

    // Exactly one Kimi card exists — both backends merged (ticket 20).
    const codeSideHtml = renderKimiCard("kimi-code");
    assert.equal(
      providerSections(codeSideHtml).filter((section) =>
        section.includes('id="provider-kimi-heading"'),
      ).length,
      1,
      "one merged Kimi card",
    );
    const codeSide = providerSection(codeSideHtml, "kimi");

    // The segment switch renders both backends; the persisted preference
    // marks the active one.
    assert.match(codeSide, /aria-label="Kimi backend"/u);
    assert.match(codeSide, /<button[^>]*aria-pressed="true"[^>]*>\s*Code\s*</u);
    assert.match(
      codeSide,
      /<button[^>]*aria-pressed="false"[^>]*>\s*Platform\s*</u,
    );

    // The active Code side carries the complete key management for its own
    // keyName — and none of the platform side's markup.
    assert.match(codeSide, /<label for="endpoint-key-input-kimi-code">API key<\/label>/u);
    assert.match(codeSide, /Paste your Kimi API key/u);
    assert.doesNotMatch(codeSide, /endpoint-key-input-kimi-platform/u);
    assert.doesNotMatch(codeSide, /Paste your Kimi Platform API key/u);

    // The per-side status detail is the API-key guidance, never the dead
    // subscription sentence (ticket 20 bug ruling, fixture-pinned).
    assert.match(
      codeSide,
      /Add this endpoint's API key on its settings card\./u,
    );
    assert.doesNotMatch(codeSide, /official provider flow/u);

    // Switching the segment flips the side's key management with it.
    const platformSide = providerSection(renderKimiCard("kimi-platform"), "kimi");
    assert.match(
      platformSide,
      /<button[^>]*aria-pressed="true"[^>]*>\s*Platform\s*</u,
    );
    assert.match(
      platformSide,
      /<label for="endpoint-key-input-kimi-platform">API key<\/label>/u,
    );
    assert.match(platformSide, /Paste your Kimi Platform API key/u);
    assert.match(platformSide, /Key saved · ••••9999/u);
    assert.doesNotMatch(platformSide, /endpoint-key-input-kimi-code/u);
    assert.doesNotMatch(platformSide, /official provider flow/u);
  } finally {
    await server.close();
  }
});

test("the API segments of the merged Claude/Codex cards carry their own key blocks instead of crashing the settings surface (WO23, ticket 25)", async () => {
  const { server, SettingsScreen } = await loadSettingsScreen();
  try {
    // The exact harness crash path: discovery rows for the WO21 endpoints
    // plus a key panel for each (mount.tsx builds one for every id in
    // WORKBENCH_ENDPOINT_KEY_ENDPOINT_IDS whenever the bridge exposes the
    // channel). Pre-fix, workbenchEndpointKeyCopy threw while rendering
    // the claude-api row and the whole Settings surface failed to mount.
    // Ticket 25: claude-api/codex-api are the API segments of the merged
    // family cards; the key block renders when that segment is active.
    const html = renderSettings(SettingsScreen, {
      profile: buildApiTransportProfile(),
      endpointPreferences: {
        claude: "claude-api",
        codex: "codex-api",
        kimi: "kimi-code",
      },
      endpointKeyPanels: {
        "claude-api": panel({
          snapshot: {
            configured: false,
            maskedHint: null,
            isPersistent: true,
            environmentFallback: true,
          },
        }),
        "codex-api": panel({
          snapshot: {
            configured: true,
            maskedHint: "••••4321",
            isPersistent: true,
            environmentFallback: true,
          },
        }),
      },
    });
    const claudeSection = providerSection(html, "claude");
    assert.match(claudeSection, /Paste your Claude API key/u);
    assert.match(
      claudeSection,
      /Sessions currently fall back to the CLAUDE_API_KEY environment variable\./u,
    );
    assert.match(
      claudeSection,
      /<label for="endpoint-key-input-claude-api">API key<\/label>/u,
    );
    const codexSection = providerSection(html, "codex");
    assert.match(codexSection, /Paste your Codex API key/u);
    assert.match(
      codexSection,
      /Sessions currently fall back to the CODEX_API_KEY environment variable\./u,
    );
    assert.match(codexSection, /Key saved · ••••4321/u);
    assert.match(
      codexSection,
      /<label for="endpoint-key-input-codex-api">API key<\/label>/u,
    );
    // Both blocks render their credential inputs; no other row does.
    assert.equal(
      (html.match(/type="password"/gu) ?? []).length,
      2,
      "one credential input per WO21 key block",
    );
  } finally {
    await server.close();
  }
});
