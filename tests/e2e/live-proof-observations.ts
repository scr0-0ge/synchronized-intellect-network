export type PendingLiveObservation<Name extends string> = Readonly<{
  name: Name;
  observed: false;
}>;

export type RecordedLiveObservation<Name extends string> = Readonly<{
  name: Name;
  observed: true;
  ordinal: number;
  value: unknown;
}>;

export type LiveObservation<Name extends string> =
  | PendingLiveObservation<Name>
  | RecordedLiveObservation<Name>;

export interface IndependentObservationRecorder<Name extends string> {
  record(name: Name, value: unknown): RecordedLiveObservation<Name>;
  snapshot(): readonly LiveObservation<Name>[];
  outstanding(): readonly Name[];
}

export function createIndependentObservationRecorder<
  const Names extends readonly string[],
>(
  names: Names,
  emit: (observation: RecordedLiveObservation<Names[number]>) => void,
): IndependentObservationRecorder<Names[number]> {
  const orderedNames = Object.freeze([...names]);
  if (new Set(orderedNames).size !== orderedNames.length) {
    throw new Error("observation-name-invalid");
  }

  const records = new Map<
    Names[number],
    RecordedLiveObservation<Names[number]>
  >();
  let ordinal = 0;

  return Object.freeze({
    record(name: Names[number], value: unknown) {
      if (!orderedNames.includes(name) || records.has(name)) {
        throw new Error("observation-record-invalid");
      }
      const observation = Object.freeze({
        name,
        observed: true as const,
        ordinal: ++ordinal,
        value,
      });
      records.set(name, observation);
      emit(observation);
      return observation;
    },
    snapshot() {
      return Object.freeze(
        orderedNames.map(
          (name): LiveObservation<Names[number]> =>
            records.get(name) ??
            Object.freeze({ name, observed: false as const }),
        ),
      );
    },
    outstanding() {
      return Object.freeze(
        orderedNames.filter((name) => !records.has(name)),
      );
    },
  });
}

export function classifyInterruptTerminal(
  event: NormalizedRuntimeEvent,
): InterruptTerminalObservation | undefined {
  if (event.kind === "turn-interrupted") {
    return Object.freeze({
      state: "stopped" as const,
      normalizedEventKind: "turn-interrupted" as const,
      interruptionStatus: event.status,
    });
  }
  if (event.kind === "turn-completed") {
    return Object.freeze({
      state: "completed" as const,
      normalizedEventKind: "turn-completed" as const,
      completionStatus: event.status,
    });
  }
  if (event.kind !== "failed") return undefined;
  if (event.category === "turn-failed") {
    return Object.freeze({
      state: "stopped" as const,
      normalizedEventKind: "failed" as const,
      failureCategory: "turn-failed" as const,
    });
  }
  return Object.freeze({
    state: "failed" as const,
    normalizedEventKind: "failed" as const,
    failureCategory: event.category,
  });
}
import type { NormalizedRuntimeEvent } from "../../src/agent-runtime/index.ts";

export type InterruptTerminalObservation =
  | Readonly<{
      state: "stopped";
      normalizedEventKind: "turn-interrupted";
      interruptionStatus: "interrupted";
    }>
  | Readonly<{
      state: "stopped";
      normalizedEventKind: "failed";
      failureCategory: "turn-failed";
    }>
  | Readonly<{
      state: "completed";
      normalizedEventKind: "turn-completed";
      completionStatus: "completed";
    }>
  | Readonly<{
      state: "failed";
      normalizedEventKind: "failed";
      failureCategory: Extract<NormalizedRuntimeEvent, { kind: "failed" }>[
        "category"
      ];
    }>;
