import assert from "node:assert/strict";
import test from "node:test";

import { redactToolActivityCredentials } from "../../src/agent-runtime/tool-activity-redaction.ts";

const secretBearingCommands = [
  ["gh auth login --with-token ghp_w172SECRETtokenVALUE0001", "ghp_w172SECRETtokenVALUE0001"],
  ["curl -u admin:hunter2 https://api.example.com/v1/me", "admin:hunter2"],
  ["mysql -h db -u root -pS3cretPass app", "S3cretPass"],
  ["aws configure set aws_secret_access_key wJalrXUtnFEMIK7MDENG", "wJalrXUtnFEMIK7MDENG"],
  ["docker login -u deploy -p dckr_pat_W172SECRET registry.example.com", "dckr_pat_W172SECRET"],
  ["npm config set //registry.npmjs.org/:_authToken npm_W172SECRETTOKEN", "npm_W172SECRETTOKEN"],
  ["az login --service-principal -u app -p SPsecretW172 --tenant t", "SPsecretW172"],
] as const;

for (const [command, secret] of secretBearingCommands) {
  test(`redacts the observed credential syntax: ${command.split(" ").slice(0, 4).join(" ")}`, () => {
    const redacted = redactToolActivityCredentials(command);
    assert.doesNotMatch(redacted, new RegExp(secret, "u"));
    assert.match(redacted, /<redacted>/u);
  });
}

for (const command of [
  "pip install --user requests",
  "docker run --user 1000:1000 alpine echo hello",
  'echo "auth = required" >> pam.conf',
  "gh auth login --with-token",
]) {
  test(`keeps a credential-free command byte-for-byte: ${command}`, () => {
    assert.equal(redactToolActivityCredentials(command), command);
  });
}

test("redacting a nested token keeps its closing quote", () => {
  assert.equal(
    redactToolActivityCredentials("ssh -o ProxyCommand='auth --token tkn_W172SECRET' host"),
    "ssh -o ProxyCommand='auth --token <redacted>' host",
  );
});
