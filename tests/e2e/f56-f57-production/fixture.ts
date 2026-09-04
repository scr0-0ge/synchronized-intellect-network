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

export const oldHistoryMarker = "F56_PRODUCTION_OLD_HISTORY_MARKER_5d21a8";

export class ProductionHistoryFixtureAdapter
  implements ResumableAgentRuntimeAdapter
{
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
      opaqueSessionReference: "f56-production-fixture-capability",
      async send(_input: RuntimeInput): Promise<void> {},
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        yield { kind: "turn-started" };
        yield {
          kind: "agent-message",
          text: "The durable production history remains available.",
        };
        yield { kind: "turn-completed", status: "completed" };
      },
    };
  }
}
