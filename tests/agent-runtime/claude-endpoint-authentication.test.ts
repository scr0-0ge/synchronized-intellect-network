import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyClaudeAuthenticationForMode,
  classifyApiKeyStaticAuthentication,
  claudeAuthenticationActionAvailability,
} from "../../src/agent-runtime/claude/endpoint-authentication.ts";
import {
  classifyClaudeSubscriptionAuthentication,
} from "../../src/agent-runtime/claude/authentication-status.ts";

function statusShape(output: {
  loggedIn: boolean;
  authMethod: string;
  apiProvider: string;
}): string {
  return JSON.stringify(output);
}

test("api-key-static accepts the live-verified oauth_token shape as its healthy form", () => {
  assert.equal(
    classifyClaudeAuthenticationForMode(
      statusShape({
        loggedIn: true,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
      }),
      "api-key-static",
    ),
    "bound",
  );
});

test("api-key-static reads a signed-out shape as sign-in-required", () => {
  assert.equal(
    classifyClaudeAuthenticationForMode(
      statusShape({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }),
      "api-key-static",
    ),
    "sign-in-required",
  );
});

test("api-key-static refuses claude.ai OAuth residue and foreign api_key shapes", () => {
  for (const authMethod of ["claude.ai", "api_key"]) {
    assert.equal(
      classifyClaudeAuthenticationForMode(
        statusShape({ loggedIn: true, authMethod, apiProvider: "firstParty" }),
        "api-key-static",
      ),
      "unknown",
      authMethod,
    );
  }
  assert.equal(
    classifyClaudeAuthenticationForMode("not json", "api-key-static"),
    "unknown",
  );
});

test("subscription-oauth delegation keeps historical classifier behavior byte-identical", () => {
  const outputs = [
    statusShape({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }),
    statusShape({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }),
    statusShape({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }),
    statusShape({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" }),
    "malformed",
  ];
  for (const output of outputs) {
    assert.equal(
      classifyClaudeAuthenticationForMode(output, "subscription-oauth"),
      classifyClaudeSubscriptionAuthentication(output),
    );
    assert.equal(
      classifyClaudeAuthenticationForMode(output),
      classifyClaudeSubscriptionAuthentication(output),
    );
  }
});

test("login/logout availability: available on subscription-oauth, unavailable on api-key-static", () => {
  assert.deepEqual(claudeAuthenticationActionAvailability("subscription-oauth"), {
    login: { status: "available" },
    logout: { status: "available" },
  });
  const staticMode = claudeAuthenticationActionAvailability("api-key-static");
  assert.equal(staticMode.login.status, "unavailable");
  assert.equal(staticMode.logout.status, "unavailable");
  assert.equal(typeof staticMode.login.reason, "string");
  assert.equal(typeof staticMode.logout.reason, "string");
  assert.throws(
    () =>
      claudeAuthenticationActionAvailability(
        "carrier" as Parameters<typeof claudeAuthenticationActionAvailability>[0],
      ),
    TypeError,
  );
});

test("bound-ness comes only from the probe outcome, never from the auth-status shape", () => {
  assert.deepEqual(
    classifyApiKeyStaticAuthentication({
      keyConfigured: true,
      probeOutcome: "accepted",
    }),
    { state: "bound", reason: "key-accepted-by-endpoint" },
  );
  assert.deepEqual(
    classifyApiKeyStaticAuthentication({
      keyConfigured: true,
      probeOutcome: "rejected",
    }),
    { state: "sign-in-required", reason: "key-rejected-by-endpoint" },
  );
  assert.deepEqual(
    classifyApiKeyStaticAuthentication({
      keyConfigured: false,
      probeOutcome: "accepted",
    }),
    { state: "sign-in-required", reason: "key-not-configured" },
  );
  assert.deepEqual(
    classifyApiKeyStaticAuthentication({
      keyConfigured: true,
      probeOutcome: "unreachable",
    }),
    { state: "unknown", reason: "endpoint-unreachable" },
  );
  assert.deepEqual(
    classifyApiKeyStaticAuthentication({
      keyConfigured: true,
      probeOutcome: "not-run",
    }),
    { state: "unknown", reason: "probe-not-run" },
  );
  assert.throws(
    () =>
      classifyApiKeyStaticAuthentication({
        keyConfigured: true,
        probeOutcome: "carrier" as "accepted",
      }),
    TypeError,
  );
});
