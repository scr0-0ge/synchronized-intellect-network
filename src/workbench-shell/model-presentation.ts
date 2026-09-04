// Owner-approved product wording is deliberately keyed by the resolved catalog
// identity. Unknown identities retain their resolved/native label; nothing is
// inferred from a future model name.
const codexProductNameByResolvedIdentity: ReadonlyMap<string, string> = new Map([
  ["gpt-5.6-sol", "GPT-5.6-Sol"],
  ["gpt-5.6-terra", "GPT-5.6-Terra"],
  ["gpt-5.6-luna", "GPT-5.6-Luna"],
  ["gpt-5.5", "GPT-5.5"],
  ["gpt-5.4", "GPT-5.4"],
  ["gpt-5.4-mini", "GPT-5.4-Mini"],
  ["gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark"],
]);

const claudeProductNameByResolvedIdentity: ReadonlyMap<string, string> = new Map([
  ["claude-opus-5[1m]", "Opus 5"],
  ["claude-fable-5", "Fable 5"],
  ["claude-sonnet-5", "Sonnet 5"],
  ["claude-haiku-4-5-20251001", "Haiku 4.5"],
]);

export function workbenchModelPresentationLabel(
  runtimeFamilyLabel: string,
  resolvedIdentity: string,
): string {
  const approvedNames =
    runtimeFamilyLabel === "Codex"
      ? codexProductNameByResolvedIdentity
      : runtimeFamilyLabel === "Claude"
        ? claudeProductNameByResolvedIdentity
        : undefined;
  return approvedNames?.get(resolvedIdentity) ?? resolvedIdentity;
}
