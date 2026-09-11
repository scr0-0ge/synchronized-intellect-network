import assert from "node:assert/strict";
import test from "node:test";

import { redactToolActivityCredentials } from "../../src/agent-runtime/tool-activity-redaction.ts";

const secretBearingCommands = [
  ["curl -H Authorization:synthetic_header_token https://api.example.com", "synthetic_header_token"],
  ["gh auth login --with-token ghp_w172SECRETtokenVALUE0001", "ghp_w172SECRETtokenVALUE0001"],
  ["curl -u admin:hunter2 https://api.example.com/v1/me", "admin:hunter2"],
  ["mysql -h db -u root -pS3cretPass app", "S3cretPass"],
  ["aws configure set aws_secret_access_key wJalrXUtnFEMIK7MDENG", "wJalrXUtnFEMIK7MDENG"],
  ["docker login -u deploy -p dckr_pat_W172SECRET registry.example.com", "dckr_pat_W172SECRET"],
  ["npm config set //registry.npmjs.org/:_authToken npm_W172SECRETTOKEN", "npm_W172SECRETTOKEN"],
  ["az login --service-principal -u app -p SPsecretW172 --tenant t", "SPsecretW172"],
  ["TOKEN=synthetic_env_token command", "synthetic_env_token"],
  ["curl https://user:synthetic_url_password@host/path", "synthetic_url_password"],
  ["sshpass -p synthetic_ssh_password ssh deploy@host", "synthetic_ssh_password"],
  ["redis-cli -a synthetic_redis_password ping", "synthetic_redis_password"],
  ["vault login synthetic_vault_token", "synthetic_vault_token"],
  ["gh secret set NPM_TOKEN --body synthetic_gh_secret", "synthetic_gh_secret"],
  ["echo synthetic_gh_token | gh auth login --with-token", "synthetic_gh_token"],
  [
    "docker login --password-stdin -u deploy registry.example.com <<< synthetic_docker_password",
    "synthetic_docker_password",
  ],
] as const;

test("keeps an unquoted credential header followed by shell redirection byte-for-byte", () => {
  for (const command of [
    "curl -H Authorization:< headers.txt",
    "curl -H Authorization:> headers.txt",
  ]) {
    assert.equal(redactToolActivityCredentials(command), command);
  }
});

test("keeps curl user-info followed by shell redirection byte-for-byte", () => {
  for (const command of ["curl -u admin:< request.txt", "curl -u admin:> response.txt"]) {
    assert.equal(redactToolActivityCredentials(command), command);
  }
});

test("keeps a short password flag followed by shell redirection byte-for-byte", () => {
  for (const command of ["docker login -p < password.txt", "docker login -p > output.txt"]) {
    assert.equal(redactToolActivityCredentials(command), command);
  }
});

test("keeps an attached mysql password flag followed by shell redirection byte-for-byte", () => {
  for (const command of ["mysql -p<input.sql", "mysql -p>output.txt"]) {
    assert.equal(redactToolActivityCredentials(command), command);
  }
});

test("keeps a positional credential setting followed by shell redirection byte-for-byte", () => {
  for (const command of [
    "aws configure set aws_secret_access_key < secret.txt",
    "aws configure set aws_secret_access_key > output.txt",
  ]) {
    assert.equal(redactToolActivityCredentials(command), command);
  }
});

test("keeps a generic credential flag followed by shell redirection byte-for-byte", () => {
  for (const command of ["tool --token < token.txt", "tool --token > output.txt"]) {
    assert.equal(redactToolActivityCredentials(command), command);
  }
});

test("keeps a credential environment assignment with shell redirection byte-for-byte", () => {
  for (const command of ["TOKEN=< token.txt", "TOKEN=> output.txt"]) {
    assert.equal(redactToolActivityCredentials(command), command);
  }
});

test("keeps a URL-shaped value from crossing an unquoted pipe byte-for-byte", () => {
  const command = "curl https://user:|tool@host";
  assert.equal(redactToolActivityCredentials(command), command);
});

test("redacts only the token piped into gh auth login", () => {
  assert.equal(
    redactToolActivityCredentials("echo synthetic_gh_token | gh auth login --with-token"),
    "echo <redacted> | gh auth login --with-token",
  );
});

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
  "gh auth login --with-token < token.txt",
  "sshpass -V",
  "redis-cli -h cache.example.com ping",
  "vault login -method=oidc",
  "gh secret set NPM_TOKEN --body-file token.txt",
  "cat token.txt | gh auth login --with-token",
  "docker login --username deploy --password-stdin < password.txt",
  "mysql -h db -u root -p app",
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
