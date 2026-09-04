import {
  assertF104AcceptanceReport,
  runF104SettingsSubscriptionAuthenticationAcceptance,
} from "../harness/f104-settings-subscription-authentication-runner.ts";
import { createF104ProductionAcceptanceFactory } from "./f104-settings-subscription-authentication-production-adapter.ts";

async function main(): Promise<void> {
  try {
    const factory = await createF104ProductionAcceptanceFactory();
    const report =
      await runF104SettingsSubscriptionAuthenticationAcceptance(factory);
    assertF104AcceptanceReport(report);
    console.log(
      `F104_SETTINGS_SUBSCRIPTION_AUTHENTICATION_ACCEPTANCE ${JSON.stringify({
        schema: report.schema,
        observationCount: report.observations.length,
        providerSpend: report.providerSpend,
        liveProviderActions: report.liveProviderActions,
        browserActions: report.browserActions,
      })}`,
    );
  } catch {
    console.log(
      `F104_SETTINGS_SUBSCRIPTION_AUTHENTICATION_MEETING_POINT_RED ${JSON.stringify({
        category: "production-acceptance-seam-not-connected",
        providerSpend: { codex: 0, claude: 0 },
        liveProviderActions: 0,
        browserActions: 0,
      })}`,
    );
    process.exitCode = 1;
  }
}

await main();
