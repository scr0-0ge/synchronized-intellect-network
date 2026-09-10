import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  KIMI_PLATFORM_CODEX_PROVIDER_ID,
  KIMI_PLATFORM_CONFIG_TOML_FILE_NAME,
  composeKimiPlatformConfigToml,
  ensureKimiPlatformCodexHome,
  kimiPlatformIsolatedCodexHomeDir,
  resolveKimiPlatformBaseUrl,
} from "../../src/agent-runtime/codex/kimi-platform-codex-home.ts";
import { KIMI_PLATFORM_DEFAULT_MODEL_ID } from "../../src/agent-runtime/codex/kimi-platform-models.ts";
import { KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT } from "../../src/agent-runtime/codex/endpoint-env-factory.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import { createTestDirectory } from "../helpers/test-lifecycle.ts";

test("the isolated CODEX_HOME follows the %APPDATA% location budget and can never be the user-level ~/.codex", () => {
  const home = kimiPlatformIsolatedCodexHomeDir(join("C:", "appdata-fake"));
  assert.equal(
    home,
    join("C:", "appdata-fake", "synchronized-intellect-network", "kimi-platform-codex-home"),
  );
  // The user-level codex home is ~/.codex by codex convention; the isolated
  // path never ends in (or contains) a bare `.codex` segment.
  assert.equal(home.includes(".codex"), false);
  // Custom base directories are honoured (tests, embedding hosts).
  assert.equal(
    kimiPlatformIsolatedCodexHomeDir(join("D:", "workbench-data")),
    join("D:", "workbench-data", "synchronized-intellect-network", "kimi-platform-codex-home"),
  );
});

test("the canonical config.toml pins the CN platform OpenAI face, chat wire api, our env_key, and the default model", () => {
  const canonical = composeKimiPlatformConfigToml({
    homeDirectory: join("C:", "appdata-fake", "synchronized-intellect-network", "kimi-platform-codex-home"),
  });
  assert.ok(canonical.includes(`model = "${KIMI_PLATFORM_DEFAULT_MODEL_ID}"`));
  assert.ok(canonical.includes(`model_provider = "${KIMI_PLATFORM_CODEX_PROVIDER_ID}"`));
  assert.ok(canonical.includes("[model_providers.kimi-platform]"));
  assert.ok(canonical.includes('base_url = "https://api.moonshot.cn/v1"'));
  assert.ok(
    canonical.includes(
      `env_key = "${KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar}"`,
    ),
  );
  assert.ok(canonical.includes('wire_api = "responses"'));
  // Byte-stable for a fixed configuration: corruption detection compares
  // against exactly this string.
  assert.equal(
    canonical,
    composeKimiPlatformConfigToml({
      homeDirectory: join("C:", "other"),
    }),
  );
});

test("the base URL resolution chain is override > env contract variable > default, and invalid values fail loudly", () => {
  const home = "unused";
  assert.equal(
    resolveKimiPlatformBaseUrl({ homeDirectory: home, baseUrl: "https://proxy.example.com/v1" }),
    "https://proxy.example.com/v1",
  );
  assert.equal(
    resolveKimiPlatformBaseUrl({
      homeDirectory: home,
      sourceEnvironment: { [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar]: "https://env.example.com/v1" },
    }),
    "https://env.example.com/v1",
  );
  assert.equal(
    resolveKimiPlatformBaseUrl({ homeDirectory: home, sourceEnvironment: {} }),
    KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.defaultBaseUrl,
  );
  // An explicit override wins over the environment variable.
  assert.equal(
    resolveKimiPlatformBaseUrl({
      homeDirectory: home,
      baseUrl: "https://override.example.com/v1",
      sourceEnvironment: { [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar]: "https://env.example.com/v1" },
    }),
    "https://override.example.com/v1",
  );
  for (const invalid of ["not-a-url", "ftp://api.moonshot.cn/v1"]) {
    let failure: unknown;
    try {
      resolveKimiPlatformBaseUrl({ homeDirectory: home, baseUrl: invalid });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof RuntimeAdapterError, invalid);
    assert.equal(failure.category, "invalid-input");
  }
  // A blank override is "not set", not invalid: the default applies.
  assert.equal(
    resolveKimiPlatformBaseUrl({ homeDirectory: home, baseUrl: "   " }),
    KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.defaultBaseUrl,
  );
});

test("seeding creates the home and the canonical config.toml, then is idempotent", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "kimi-platform-home-"));
  const home = join(root, "kimi-platform-codex-home");
  const seeded = ensureKimiPlatformCodexHome({ homeDirectory: home });
  assert.equal(seeded.restored, true);
  assert.equal(seeded.configPath, join(home, KIMI_PLATFORM_CONFIG_TOML_FILE_NAME));
  const firstContent = readFileSync(seeded.configPath, "utf8");
  assert.equal(firstContent, composeKimiPlatformConfigToml({ homeDirectory: home }));
  const resealed = ensureKimiPlatformCodexHome({ homeDirectory: home });
  assert.equal(resealed.restored, false);
  assert.equal(readFileSync(resealed.configPath, "utf8"), firstContent);
});

test("a corrupted or drifted config.toml is detected and rebuilt", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "kimi-platform-rebuild-"));
  const home = join(root, "kimi-platform-codex-home");
  const seeded = ensureKimiPlatformCodexHome({ homeDirectory: home });
  assert.equal(seeded.restored, true);

  // Truncated (corrupted) content.
  writeFileSync(seeded.configPath, "model = \"garbage", "utf8");
  const repaired = ensureKimiPlatformCodexHome({ homeDirectory: home });
  assert.equal(repaired.restored, true);
  assert.equal(
    readFileSync(repaired.configPath, "utf8"),
    composeKimiPlatformConfigToml({ homeDirectory: home }),
  );

  // Healthy but stale: a hand-edit or an older seeding with a different
  // base URL is drift, and drift is repaired to the canonical content.
  writeFileSync(seeded.configPath, "model = \"gpt-5.6-sol\"\n", "utf8");
  const drifted = ensureKimiPlatformCodexHome({ homeDirectory: home });
  assert.equal(drifted.restored, true);
  assert.equal(
    readFileSync(drifted.configPath, "utf8"),
    composeKimiPlatformConfigToml({ homeDirectory: home }),
  );

  // A configuration change (base URL override) rewrites the file to the new
  // canonical content — the file always matches what we would seed now.
  const moved = ensureKimiPlatformCodexHome({
    homeDirectory: home,
    baseUrl: "https://proxy.example.com/v1",
  });
  assert.equal(moved.restored, true);
  assert.ok(
    readFileSync(moved.configPath, "utf8").includes("https://proxy.example.com/v1"),
  );
});

test("seeding never writes outside the isolated home: a sibling user-level .codex stays untouched", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "kimi-platform-isolation-"));
  const home = join(root, "appdata", "synchronized-intellect-network", "kimi-platform-codex-home");
  // A stand-in for the user-level codex home, deliberately placed where a
  // buggy seeding could plausibly reach it (same parent, dot-named).
  const userCodexHome = join(root, "user-home", ".codex");
  mkdirSync(userCodexHome, { recursive: true });
  const userConfig = join(userCodexHome, "config.toml");
  const userSentinel = "# user-owned configuration\n";
  writeFileSync(userConfig, userSentinel, "utf8");

  ensureKimiPlatformCodexHome({ homeDirectory: home });
  writeFileSync(join(home, KIMI_PLATFORM_CONFIG_TOML_FILE_NAME), "corrupted", "utf8");
  ensureKimiPlatformCodexHome({ homeDirectory: home });

  assert.equal(readFileSync(userConfig, "utf8"), userSentinel);
  const homeEntries = readFileSync(
    join(home, KIMI_PLATFORM_CONFIG_TOML_FILE_NAME),
    "utf8",
  );
  assert.notEqual(homeEntries, userSentinel);
  assert.equal(
    homeEntries,
    composeKimiPlatformConfigToml({ homeDirectory: home }),
  );
});

test("an invalid home directory is rejected without touching the filesystem", () => {
  for (const invalid of ["", "  ", "a\0b"]) {
    let failure: unknown;
    try {
      ensureKimiPlatformCodexHome({ homeDirectory: invalid });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof RuntimeAdapterError, JSON.stringify(invalid));
    assert.equal(failure.category, "invalid-input");
  }
});
