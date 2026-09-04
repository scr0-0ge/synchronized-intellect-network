import type {
  AgentRuntimeAdapter,
  NormalizedRuntimeEvent,
  RuntimeBinding,
  RuntimeCatalog,
  RuntimeStart,
} from "../../../src/agent-runtime/index.ts";
import type { DirectSessionProfileCatalog } from "../../../src/workbench-shell/direct-session-profile-snapshot.ts";

export interface NeutralEndpointFixture {
  readonly preferenceKey: string;
  readonly runtimeFamilyLabel: string;
  readonly endpointLabel: string;
  readonly adapter: FixtureEndpointAdapter;
}

export class FixtureEndpointAdapter implements AgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;
  readonly starts: RuntimeStart[] = [];
  readonly catalog: DirectSessionProfileCatalog;

  constructor(catalog: DirectSessionProfileCatalog) {
    this.catalog = catalog;
  }

  async inspect(): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    return this.catalog;
  }

  async start(request: RuntimeStart): Promise<RuntimeBinding> {
    this.startCalls += 1;
    this.starts.push({
      projectDirectory: request.projectDirectory,
      profile: { ...request.profile },
    });
    return {
      profile: { ...request.profile },
      async send() {},
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        yield { kind: "turn-completed", status: "completed" };
      },
    };
  }
}

export function dissimilarNeutralEndpointFixtures(): readonly [
  NeutralEndpointFixture,
  NeutralEndpointFixture,
] {
  return Object.freeze([
    Object.freeze({
      preferenceKey: "quartz-studio",
      runtimeFamilyLabel: "Quartz Runtime",
      endpointLabel: "Quartz Studio",
      adapter: new FixtureEndpointAdapter(
        Object.freeze({
          runtime: "quartz-native-runtime",
          models: Object.freeze([
            Object.freeze({
              id: "quartz-private-model-a",
              resolvedModel: "Shared Compass",
              displayName: "Shared Compass",
              workIntensityLabel: "Deliberation",
              effortLevels: Object.freeze(["q-brief", "q-deep"]),
              effortLevelLabels: Object.freeze([
                "Quick consideration",
                "Thorough consideration",
              ]),
            }),
          ]),
          executionModes: Object.freeze([
            "single-agent",
            "coordinated-workflow",
          ]),
          accessModes: Object.freeze(["full-access"]),
          workIntensityExecutionModeCouplings: Object.freeze([
            Object.freeze({
              model: "quartz-private-model-a",
              workIntensity: "q-deep",
              executionMode: "coordinated-workflow",
            }),
          ]),
        }),
      ),
    }),
    Object.freeze({
      preferenceKey: "nimbus-relay",
      runtimeFamilyLabel: "Nimbus Runtime",
      endpointLabel: "Nimbus Relay",
      adapter: new FixtureEndpointAdapter(
        Object.freeze({
          runtime: "nimbus-native-runtime",
          models: Object.freeze([
            Object.freeze({
              id: "nimbus-private-model-b",
              resolvedModel: "Shared Compass",
              displayName: "Shared Compass",
              effortLevels: Object.freeze([
                "n-glance",
                "n-review",
                "n-exhaustive",
              ]),
              effortLevelLabels: Object.freeze([
                "Glance",
                "Structured review",
                "Exhaustive review",
              ]),
            }),
          ]),
          executionModes: Object.freeze(["single-agent"]),
          accessModes: Object.freeze(["full-access"]),
        }),
      ),
    }),
  ]);
}
