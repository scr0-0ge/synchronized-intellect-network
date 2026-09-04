import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  NormalizedRuntimeEvent,
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeInput,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "../../../src/agent-runtime/index.ts";
import { createWorkbenchCoordinator } from "../../../src/coordinator/index.ts";

export const expectedCode =
  '  const greeting = "hello";\n\tconsole.log(greeting);\n\nreturn greeting;  ';

class PackagedCopyFixtureAdapter implements ResumableAgentRuntimeAdapter {
  async inspect(): Promise<RuntimeCatalog> {
    return {
      runtime: "fixture",
      models: [{ id: "fixture-model", effortLevels: ["fixture-effort"] }],
      executionModes: ["single-agent"],
      accessModes: ["full-access"],
    };
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    return this.binding(request.profile);
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    return this.binding(request.profile);
  }

  private binding(profile: SessionProfile): ResumableRuntimeBinding {
    return {
      profile: structuredClone(profile),
      opaqueSessionReference: "f169-packaged-copy-fixture-capability",
      async send(_input: RuntimeInput): Promise<void> {},
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        yield { kind: "turn-started" };
        yield {
          kind: "agent-message",
          text: `A precise copy target follows.\n\`\`\`ts\n${expectedCode}\n\`\`\``,
        };
        yield { kind: "turn-completed", status: "completed" };
      },
    };
  }
}

export async function seedProductionHistory(
  projectDirectory: string,
  userDataDirectory: string,
): Promise<void> {
  const canonicalProject = await realpath(projectDirectory);
  const dataDirectory = join(userDataDirectory, "workbench-project-host");
  const ledgerDirectory = join(dataDirectory, "project-ledgers");
  const recordKey = "project-record-v1-00000000-0000-4000-8000-000000000169";
  const ledgerSlot = "project-ledger-v1-00000000-0000-4000-8000-000000000169";
  await mkdir(ledgerDirectory, { recursive: true });
  await writeFile(
    join(dataDirectory, "project-registry-v1.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      nextProjectOrdinal: 2,
      selectedRecordKey: recordKey,
      records: [{ recordKey, canonicalDirectory: canonicalProject, ledgerSlot }],
    })}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  const channel = await createWorkbenchCoordinator({
    databasePath: join(ledgerDirectory, `${ledgerSlot}.sqlite`),
    adapter: new PackagedCopyFixtureAdapter(),
  }).openProject(canonicalProject);
  try {
    const profile = {
      model: "fixture-model",
      effortLevel: "fixture-effort",
      executionMode: "single-agent",
      accessMode: "full-access",
    } as const;
    const receipt = await channel.act({
      kind: "direct",
      commandKind: "start",
      idempotencyKey: "f169-packaged-copy-history",
      runtime: "codex",
      catalogRevision: "f169-packaged-copy-history-v1",
      preferences: { global: profile },
      profile,
      requestedProfileProjection: {
        kind: "recorded",
        runtimeFamilyLabel: "Codex",
        endpointLabel: "Codex desktop",
        modelLabel: "Fixture model",
        workIntensityControlLabel: {
          label: "Work Intensity",
          provenance: "runtime-catalog",
        },
        workIntensityLabel: "Fixture effort",
        executionModeLabel: "Single agent",
        accessModeLabel: "Full access",
      },
      input: "Render the exact F169 code-block fixture.",
    });
    await waitForTerminal(channel, receipt.commandId);
  } finally {
    await channel.close();
  }
}

async function waitForTerminal(
  channel: Awaited<
    ReturnType<ReturnType<typeof createWorkbenchCoordinator>["openProject"]>
  >,
  commandId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const command = (await channel.snapshot()).commands.find(
      (candidate) => candidate.commandId === commandId,
    );
    if (command?.status === "completed") return;
    if (command?.status === "failed" || command?.status === "recovery-required") {
      throw new Error("f169-production-history-seed-failed");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("f169-production-history-seed-timeout");
}
