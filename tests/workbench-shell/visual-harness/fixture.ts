import type {
  WorkbenchPublicDirectSessionProfileResult,
  WorkbenchHostedProjectView,
} from "../../../src/workbench-shell/contract.ts";
import { publicRuntimeEndpointDiscovery } from "../../../src/workbench-shell/contract.ts";

const profile = Object.freeze({
  requested: Object.freeze({
    kind: "recorded" as const,
    runtimeFamilyLabel: "Codex",
    endpointLabel: "Codex desktop",
    modelLabel: "Solution 5.6",
    workIntensityControlLabel: Object.freeze({
      label: "Reasoning",
      provenance: "runtime-catalog" as const,
    }),
    workIntensityLabel: "Maximum",
    executionModeLabel: "Single agent",
    accessModeLabel: "Full access",
  }),
  effective: Object.freeze({
    kind: "observed" as const,
    provenance: "post-turn-observation" as const,
    model: Object.freeze({
      label: "Solution 5.6",
      comparison: "matches-requested" as const,
    }),
    workIntensity: Object.freeze({
      label: "Observed different value",
      comparison: "differs-from-requested" as const,
    }),
    accessMode: Object.freeze({
      label: "Full access",
      comparison: "matches-requested" as const,
    }),
  }),
});

const historicalProfile = Object.freeze({
  requested: Object.freeze({ kind: "not-recorded" as const }),
  effective: Object.freeze({ kind: "not-recorded" as const }),
});

const firstSelectedProjects = Object.freeze({
  projects: Object.freeze([
    Object.freeze({
      label: "Atlas Fieldnotes",
      availability: "available" as const,
      selected: true,
      selectionKey:
        "project-selection:00000000-0000-4000-8000-000000000111",
    }),
    Object.freeze({
      label: "Atlas Fieldnotes",
      availability: "available" as const,
      selected: false,
      selectionKey:
        "project-selection:00000000-0000-4000-8000-000000000112",
    }),
    Object.freeze({
      label: "Archive Notes",
      availability: "missing" as const,
      selected: false,
      selectionKey:
        "project-selection:00000000-0000-4000-8000-000000000113",
    }),
  ]),
});

const secondSelectedProjects = Object.freeze({
  projects: Object.freeze(
    firstSelectedProjects.projects.map((project, index) =>
      Object.freeze({
        ...project,
        selected: index === 1,
        selectionKey: `project-selection:00000000-0000-4000-8000-${String(
          121 + index,
        ).padStart(12, "0")}`,
      }),
    ),
  ),
});

const unavailableSelectedProjects = Object.freeze({
  projects: Object.freeze(
    firstSelectedProjects.projects.map((project, index) =>
      Object.freeze({
        ...project,
        selected: index === 2,
        selectionKey: `project-selection:00000000-0000-4000-8000-${String(
          141 + index,
        ).padStart(12, "0")}`,
      }),
    ),
  ),
});

const openedProjectSelection = Object.freeze({
  projects: Object.freeze([
    ...firstSelectedProjects.projects.map((project) =>
      Object.freeze({ ...project, selected: false }),
    ),
    Object.freeze({
      label: "Northstar Lab",
      availability: "available" as const,
      selected: true,
      selectionKey:
        "project-selection:00000000-0000-4000-8000-000000000154",
    }),
  ]),
});

export const visualFixture: WorkbenchHostedProjectView = Object.freeze({
  project: Object.freeze({ label: "Atlas Fieldnotes" }),
  observation: Object.freeze({ cursor: 11, live: true }),
  commands: Object.freeze([
    Object.freeze({
      key: "command-1",
      label: "Agent Session 01",
      runtime: "Codex",
      status: "completed",
      session: Object.freeze({
        profile,
        context: Object.freeze({
          usedTokens: 122_000,
          windowTokens: 200_000,
        }),
        archived: false,
        metadataKey:
          "session-metadata:00000000-0000-4000-8000-000000000711",
        resumable: true,
        removalKey:
          "session-removal:00000000-0000-4000-8000-000000000711",
        selectionKey:
          "session-selection:00000000-0000-4000-8000-000000000011",
        timeline: Object.freeze([
          Object.freeze({ kind: "session-started" }),
          Object.freeze({ kind: "turn-started" }),
          Object.freeze({ kind: "item-started", itemType: "agent-message" }),
          Object.freeze({
            kind: "agent-message",
            text: "F56_OLD_HISTORY_MARKER_7f3c9a — the durable review is current.",
          }),
          Object.freeze({ kind: "item-completed", itemType: "agent-message" }),
          Object.freeze({ kind: "turn-completed", status: "completed" }),
        ]),
      }),
    }),
    Object.freeze({
      key: "command-2",
      label: "Agent Session 02",
      runtime: "Codex",
      status: "failed",
      failureCategory: "runtime-failed",
    }),
    Object.freeze({
      key: "command-3",
      label: "Agent Session 03",
      runtime: "Codex",
      status: "recovery-required",
      session: Object.freeze({
        profile: historicalProfile,
        archived: false,
        metadataKey:
          "session-metadata:00000000-0000-4000-8000-000000000713",
        resumable: false,
        removalKey:
          "session-removal:00000000-0000-4000-8000-000000000713",
        selectionKey: null,
        timeline: Object.freeze([
          Object.freeze({ kind: "session-started" }),
          Object.freeze({ kind: "turn-started" }),
        ]),
      }),
    }),
  ]),
  initialSelectionKey: "command-1",
  projectSelection: firstSelectedProjects,
});

export const codeBlockCopyVisualFixture: WorkbenchHostedProjectView =
  Object.freeze({
    ...visualFixture,
    observation: Object.freeze({ cursor: 12, live: true }),
    commands: Object.freeze([
      Object.freeze({
        ...visualFixture.commands[0]!,
        session: Object.freeze({
          ...visualFixture.commands[0]!.session!,
          timeline: Object.freeze([
            Object.freeze({ kind: "session-started" as const }),
            Object.freeze({ kind: "turn-started" as const }),
            Object.freeze({
              kind: "agent-message" as const,
              text: [
                "A precise copy target follows.",
                "```ts",
                '  const greeting = "hello";',
                "\tconsole.log(greeting);",
                "",
                "return greeting;  ",
                "```",
              ].join("\n"),
            }),
            Object.freeze({ kind: "turn-completed" as const, status: "completed" as const }),
          ]),
        }),
      }),
      ...visualFixture.commands.slice(1),
    ]),
    initialSelectionKey: "command-1",
  });

export const emptyVisualFixture: WorkbenchHostedProjectView = Object.freeze({
  project: Object.freeze({ label: "Atlas Fieldnotes" }),
  observation: Object.freeze({ cursor: 0, live: true }),
  commands: Object.freeze([]),
  initialSelectionKey: null,
  projectSelection: firstSelectedProjects,
});

export const unavailableVisualFixture: WorkbenchHostedProjectView =
  Object.freeze({
    project: Object.freeze({ label: "Archive Notes" }),
    observation: Object.freeze({ cursor: 0, live: true }),
    commands: Object.freeze([]),
    initialSelectionKey: null,
    projectSelection: unavailableSelectedProjects,
  });

export const openedProjectVisualFixture: WorkbenchHostedProjectView =
  Object.freeze({
    project: Object.freeze({ label: "Northstar Lab" }),
    observation: Object.freeze({ cursor: 0, live: true }),
    commands: Object.freeze([]),
    initialSelectionKey: null,
    projectSelection: openedProjectSelection,
  });

export const secondSessionVisualFixture: WorkbenchHostedProjectView = Object.freeze({
  project: Object.freeze({ label: "Atlas Fieldnotes" }),
  observation: Object.freeze({ cursor: 18, live: true }),
  commands: Object.freeze([
    Object.freeze({
      key: "command-1",
      label: "Agent Session 01",
      runtime: "Codex",
      status: "completed",
      session: Object.freeze({
        profile,
        archived: false,
        metadataKey:
          "session-metadata:00000000-0000-4000-8000-000000000721",
        resumable: true,
        removalKey:
          "session-removal:00000000-0000-4000-8000-000000000721",
        selectionKey:
          "session-selection:00000000-0000-4000-8000-000000000021",
        timeline: Object.freeze([
          Object.freeze({ kind: "session-started" }),
          Object.freeze({ kind: "turn-started" }),
          Object.freeze({
            kind: "agent-message",
            text: "The first Agent Session remains complete with its original immutable profile.",
          }),
          Object.freeze({ kind: "turn-completed", status: "completed" }),
        ]),
      }),
    }),
    Object.freeze({
      key: "command-2",
      label: "Agent Session 02",
      runtime: "Codex",
      status: "in-flight",
      session: Object.freeze({
        profile: Object.freeze({
          requested: Object.freeze({
            kind: "recorded" as const,
            runtimeFamilyLabel: "Codex",
            endpointLabel: "Codex desktop",
            modelLabel: "Codex 5.6",
            workIntensityControlLabel: Object.freeze({
              label: null,
              provenance: "not-recorded" as const,
            }),
            workIntensityLabel: "High",
            executionModeLabel: "Single agent",
            accessModeLabel: "Full access",
          }),
          effective: Object.freeze({ kind: "unknown" as const }),
        }),
        context: Object.freeze({
          usedTokens: 17_000,
          windowTokens: null,
        }),
        archived: false,
        metadataKey:
          "session-metadata:00000000-0000-4000-8000-000000000722",
        resumable: false,
        removalKey:
          "session-removal:00000000-0000-4000-8000-000000000722",
        selectionKey: null,
        timeline: Object.freeze([
          Object.freeze({ kind: "session-started" }),
          Object.freeze({ kind: "turn-started" }),
          Object.freeze({ kind: "item-started", itemType: "agent-message" }),
        ]),
      }),
    }),
  ]),
  initialSelectionKey: "command-2",
  projectSelection: secondSelectedProjects,
});

export const interruptVisualFixture: WorkbenchHostedProjectView = Object.freeze({
  ...secondSessionVisualFixture,
  observation: Object.freeze({ cursor: 31, live: true }),
  commands: Object.freeze(
    secondSessionVisualFixture.commands.map((command) =>
      command.key === "command-2"
        ? Object.freeze({
            ...command,
            interrupt: Object.freeze({
              status: "available" as const,
              interruptKey:
                "turn-interrupt:00000000-0000-4000-8000-000000000091",
            }),
            steer: Object.freeze({
              status: "available" as const,
              steerKey: "turn-steer:00000000-0000-4000-8000-000000000092",
            }),
          })
        : command,
    ),
  ),
});

export const interruptedVisualFixture: WorkbenchHostedProjectView = Object.freeze({
  ...interruptVisualFixture,
  observation: Object.freeze({ cursor: 33, live: true }),
  commands: Object.freeze(
    interruptVisualFixture.commands.map((command) => {
      if (command.key !== "command-2" || command.session === undefined) {
        return command;
      }
      const { interrupt: _interrupt, steer: _steer, ...stopped } = command;
      return Object.freeze({
        ...stopped,
        status: "failed" as const,
        failureCategory: "interrupted" as const,
        session: Object.freeze({
          ...command.session,
          resumable: true,
          selectionKey:
            "session-selection:00000000-0000-4000-8000-000000000091",
          timeline: Object.freeze([
            ...command.session.timeline,
            Object.freeze({
              kind: "turn-interrupted" as const,
              status: "interrupted" as const,
            }),
          ]),
        }),
      });
    }),
  ),
});

export const claudeRunningVisualFixture: WorkbenchHostedProjectView =
  Object.freeze({
    ...interruptVisualFixture,
    observation: Object.freeze({ cursor: 35, live: true }),
    commands: Object.freeze(
      interruptVisualFixture.commands.map((command) => {
        if (command.key !== "command-2" || command.session === undefined) {
          return command;
        }
        return Object.freeze({
          ...command,
          runtime: "Claude Code",
          steer: Object.freeze({
            status: "unsupported" as const,
            reason:
              "This Runtime does not support same-turn guidance. Your draft stays local." as const,
          }),
          session: Object.freeze({
            ...command.session,
            profile: Object.freeze({
              ...command.session.profile,
              requested:
                command.session.profile.requested.kind === "recorded"
                  ? Object.freeze({
                      ...command.session.profile.requested,
                      runtimeFamilyLabel: "Claude Code",
                    })
                  : command.session.profile.requested,
            }),
          }),
        });
      }),
    ),
  });

export const claudeInterruptedVisualFixture: WorkbenchHostedProjectView =
  Object.freeze({
    ...claudeRunningVisualFixture,
    observation: Object.freeze({ cursor: 36, live: true }),
    commands: Object.freeze(
      claudeRunningVisualFixture.commands.map((command) => {
        if (command.key !== "command-2" || command.session === undefined) {
          return command;
        }
        const { interrupt: _interrupt, steer: _steer, ...stopped } = command;
        return Object.freeze({
          ...stopped,
          status: "failed" as const,
          failureCategory: "interrupted" as const,
          session: Object.freeze({
            ...command.session,
            resumable: true,
            selectionKey:
              "session-selection:00000000-0000-4000-8000-000000000093",
            timeline: Object.freeze([
              ...command.session.timeline,
              Object.freeze({
                kind: "turn-interrupted" as const,
                status: "interrupted" as const,
              }),
            ]),
          }),
        });
      }),
    ),
  });

export const sessionMetadataLongNonAsciiName =
  `会議-${"界".repeat(75)}-🧭`;

export const sessionMetadataVisualFixture: WorkbenchHostedProjectView =
  Object.freeze({
    ...visualFixture,
    observation: Object.freeze({ cursor: 24, live: true }),
    commands: Object.freeze([
      Object.freeze({
        ...visualFixture.commands[0]!,
        key: "command-1",
        label: sessionMetadataLongNonAsciiName,
      }),
      Object.freeze({
        ...secondSessionVisualFixture.commands[1]!,
        key: "command-2",
        label: `進行中-${"長".repeat(48)}`,
        session: Object.freeze({
          ...secondSessionVisualFixture.commands[1]!.session!,
          metadataKey:
            "session-metadata:00000000-0000-4000-8000-000000000732",
          removalKey:
            "session-removal:00000000-0000-4000-8000-000000000732",
        }),
      }),
      Object.freeze({
        ...visualFixture.commands[2]!,
        key: "command-3",
        label: `結果不明-${"界".repeat(44)}`,
        session: Object.freeze({
          ...visualFixture.commands[2]!.session!,
          metadataKey:
            "session-metadata:00000000-0000-4000-8000-000000000733",
          removalKey:
            "session-removal:00000000-0000-4000-8000-000000000733",
        }),
      }),
      Object.freeze({
        ...visualFixture.commands[0]!,
        key: "command-4",
        label: `归档-${"長".repeat(70)}-済`,
        status: "failed" as const,
        failureCategory: "runtime-failed" as const,
        session: Object.freeze({
          ...visualFixture.commands[0]!.session!,
          archived: true,
          metadataKey:
            "session-metadata:00000000-0000-4000-8000-000000000734",
          removalKey:
            "session-removal:00000000-0000-4000-8000-000000000734",
          resumable: false,
          selectionKey: null,
        }),
      }),
    ]),
    initialSelectionKey: "command-1",
  });

export const visualDirectProfile: WorkbenchPublicDirectSessionProfileResult =
  Object.freeze({
    ok: true,
    endpointDiscovery: publicRuntimeEndpointDiscovery(
      "catalog-ready",
      "catalog-ready",
    ),
    profile: Object.freeze({
      snapshotKey: "qa-snapshot",
      endpoints: Object.freeze([
        Object.freeze({
          endpointId: "codex-desktop",
          key: "qa-endpoint-1",
          runtimeFamilyLabel: "Codex",
          endpointLabel: "Codex desktop",
          models: Object.freeze([
            Object.freeze({
              key: "qa-model-1",
              label: "gpt-5.6-sol",
              provenanceLabel: null,
              workIntensityLabel: null,
              workIntensities: Object.freeze([
                Object.freeze({ key: "qa-low", label: "low" }),
                Object.freeze({ key: "qa-medium", label: "medium" }),
                Object.freeze({ key: "qa-high", label: "high" }),
                Object.freeze({ key: "qa-xhigh", label: "xhigh" }),
                Object.freeze({ key: "qa-max", label: "max" }),
                Object.freeze({ key: "qa-ultra", label: "ultra" }),
              ]),
            }),
            Object.freeze({
              key: "qa-model-2",
              label: "gpt-5.6-codex",
              provenanceLabel: null,
              workIntensityLabel: null,
              workIntensities: Object.freeze([
                Object.freeze({ key: "qa-medium", label: "medium" }),
                Object.freeze({ key: "qa-high", label: "high" }),
              ]),
            }),
            Object.freeze({
              key: "qa-model-3",
              label: "gpt-5.4",
              provenanceLabel: null,
              workIntensityLabel: null,
              workIntensities: Object.freeze([
                Object.freeze({ key: "qa-low", label: "low" }),
                Object.freeze({ key: "qa-medium", label: "medium" }),
              ]),
            }),
          ]),
          executionModes: Object.freeze([
            Object.freeze({ key: "qa-execution-1", label: "Single agent" }),
          ]),
          accessModes: Object.freeze([
            Object.freeze({ key: "qa-access-1", label: "Full access" }),
          ]),
        }),
        Object.freeze({
          endpointId: "claude-code-desktop",
          key: "qa-endpoint-claude",
          runtimeFamilyLabel: "Claude",
          endpointLabel: "Claude Code",
          models: Object.freeze([
            Object.freeze({
              key: "qa-claude-opus-5-1m",
              label: "claude-opus-5[1m]",
              provenanceLabel: null,
              workIntensityLabel: null,
              workIntensities: Object.freeze([
                Object.freeze({ key: "qa-claude-opus-low", label: "low" }),
                Object.freeze({ key: "qa-claude-opus-medium", label: "medium" }),
                Object.freeze({ key: "qa-claude-opus-high", label: "high" }),
                Object.freeze({ key: "qa-claude-opus-xhigh", label: "xhigh" }),
                Object.freeze({ key: "qa-claude-opus-max", label: "max" }),
                Object.freeze({
                  key: "qa-claude-opus-ultracode",
                  label: "ultracode",
                  impliedExecutionModeKey: "qa-claude-execution-1",
                }),
              ]),
            }),
            Object.freeze({
              key: "qa-claude-fable-5",
              label: "claude-fable-5",
              provenanceLabel: "Fable",
              workIntensityLabel: null,
              workIntensities: Object.freeze([
                Object.freeze({ key: "qa-claude-fable-low", label: "low" }),
                Object.freeze({ key: "qa-claude-fable-medium", label: "medium" }),
                Object.freeze({ key: "qa-claude-fable-high", label: "high" }),
                Object.freeze({ key: "qa-claude-fable-xhigh", label: "xhigh" }),
                Object.freeze({ key: "qa-claude-fable-max", label: "max" }),
                Object.freeze({
                  key: "qa-claude-fable-ultracode",
                  label: "ultracode",
                  impliedExecutionModeKey: "qa-claude-execution-1",
                }),
              ]),
            }),
            Object.freeze({
              key: "qa-claude-sonnet-5",
              label: "claude-sonnet-5",
              provenanceLabel: "Sonnet",
              workIntensityLabel: null,
              workIntensities: Object.freeze([
                Object.freeze({ key: "qa-claude-sonnet-low", label: "low" }),
                Object.freeze({ key: "qa-claude-sonnet-medium", label: "medium" }),
                Object.freeze({ key: "qa-claude-sonnet-high", label: "high" }),
                Object.freeze({ key: "qa-claude-sonnet-xhigh", label: "xhigh" }),
                Object.freeze({ key: "qa-claude-sonnet-max", label: "max" }),
                Object.freeze({
                  key: "qa-claude-sonnet-ultracode",
                  label: "ultracode",
                  impliedExecutionModeKey: "qa-claude-execution-1",
                }),
              ]),
            }),
            Object.freeze({
              key: "qa-claude-haiku-4-5",
              label: "claude-haiku-4-5-20251001",
              provenanceLabel: "Haiku",
              workIntensityLabel: null,
              workIntensities: Object.freeze([
                Object.freeze({
                  key: "qa-claude-haiku-default",
                  label: "default",
                }),
              ]),
            }),
          ]),
          executionModes: Object.freeze([
            Object.freeze({
              key: "qa-claude-execution-1",
              label: "Single agent",
            }),
          ]),
          accessModes: Object.freeze([
            Object.freeze({
              key: "qa-claude-access-1",
              label: "Full access",
            }),
          ]),
        }),
      ]),
      desiredDefault: Object.freeze({
        kind: "resolved",
        endpointKey: "qa-endpoint-1",
        modelKey: "qa-model-1",
        workIntensityKey: "qa-ultra",
        executionModeKey: "qa-execution-1",
        accessModeKey: "qa-access-1",
      }),
    }),
  });
