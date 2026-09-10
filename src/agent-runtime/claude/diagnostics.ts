import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RuntimeAdapterError,
  type RuntimeFailureCategory,
} from "../index.ts";
import type { SubscriptionAuthenticationState } from "../subscription-authentication.ts";

export const CLAUDE_DIAGNOSTIC_LOG_MAXIMUM_BYTES = 524_288;
export const CLAUDE_DIAGNOSTIC_DETAIL_MAXIMUM_BYTES = 65_536;

const productionDiagnosticFilePath = join(
  tmpdir(),
  `synchronized-intellect-network-claude-diagnostics-${process.pid}.jsonl`,
);

interface ClaudeDiagnosticBase {
  readonly category: RuntimeFailureCategory;
  /** Private native material. It is written only to the bounded diagnostic file. */
  readonly detail?: string;
}

export type ClaudeRuntimeDiagnostic =
  | (ClaudeDiagnosticBase & {
      readonly kind: "optional-data-unavailable";
      readonly gate: "context-usage" | "interrupt-and-steer" | "catalog-settings" | "notification" | "control-response";
      readonly row: null;
    })
  | (ClaudeDiagnosticBase & {
      readonly kind: "correlation-rejected";
      readonly gate: "session-frame";
      readonly row: number;
    })
  | (ClaudeDiagnosticBase & {
      readonly kind: "authentication-status";
      readonly state: SubscriptionAuthenticationState;
    })
  | (ClaudeDiagnosticBase & {
      readonly kind: "child-stderr";
      readonly capturedBytes: number;
      readonly omittedBytes: number;
    })
  | (ClaudeDiagnosticBase & {
      readonly kind: "process-launch-rejected";
      readonly errorCode: string | null;
    })
  | (ClaudeDiagnosticBase & {
      readonly kind:
        | "catalog-shape-rejected"
        | "control-response-rejected"
        | "settings-shape-rejected";
      readonly gate: string;
      readonly row: number | null;
      readonly addedKeys: readonly string[];
      readonly missingKeys: readonly string[];
      readonly invalidKeys: readonly string[];
    });

export type ClaudeDiagnosticObserver = (
  diagnostic: ClaudeRuntimeDiagnostic,
) => void;

export class ClaudeDiagnosticError extends RuntimeAdapterError {
  readonly diagnostic!: ClaudeRuntimeDiagnostic;

  constructor(
    category: RuntimeFailureCategory,
    diagnostic: ClaudeRuntimeDiagnostic,
  ) {
    super(category);
    Object.defineProperty(this, "diagnostic", {
      value: freezeDiagnostic(diagnostic),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
}

export function claudeDiagnosticFromError(
  error: unknown,
): ClaudeRuntimeDiagnostic | undefined {
  return error instanceof ClaudeDiagnosticError ? error.diagnostic : undefined;
}

export function formatClaudeDiagnosticSummary(
  diagnostic: ClaudeRuntimeDiagnostic,
): string {
  const parts = [
    `kind=${diagnostic.kind}`,
    `category=${diagnostic.category}`,
  ];
  if (diagnostic.kind === "optional-data-unavailable") {
    parts.push(`gate=${diagnostic.gate}`);
  } else if (diagnostic.kind === "correlation-rejected") {
    parts.push(`gate=${diagnostic.gate}`, `row=${diagnostic.row}`);
  } else if (diagnostic.kind === "authentication-status") {
    parts.push(`state=${diagnostic.state}`);
  } else if (diagnostic.kind === "child-stderr") {
    parts.push(`capturedBytes=${diagnostic.capturedBytes}`);
    parts.push(`omittedBytes=${diagnostic.omittedBytes}`);
  } else if (diagnostic.kind === "process-launch-rejected") {
    parts.push(`errorCode=${fixedSummaryToken(diagnostic.errorCode ?? "none")}`);
  } else {
    parts.push(`gate=${fixedSummaryToken(diagnostic.gate)}`);
    parts.push(`row=${diagnostic.row ?? "none"}`);
    parts.push(`addedKeys=${diagnostic.addedKeys.length}`);
    parts.push(`missingKeys=${diagnostic.missingKeys.length}`);
    parts.push(`invalidKeys=${diagnostic.invalidKeys.length}`);
  }
  return parts.join(" ");
}

export function createClaudeDiagnosticRecorder(options: {
  readonly filePath: string;
  readonly maximumBytes?: number;
  readonly writeSummary?: (summary: string) => void;
}): ClaudeDiagnosticObserver {
  const maximumBytes = options.maximumBytes ?? CLAUDE_DIAGNOSTIC_LOG_MAXIMUM_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 512) {
    throw new RangeError("Claude diagnostic maximumBytes must be an integer of at least 512.");
  }
  const writeSummary =
    options.writeSummary ??
    ((summary: string) => process.stderr.write(`[claude-runtime] ${summary}\n`));

  return (diagnostic) => {
    try {
      writeSummary(formatClaudeDiagnosticSummary(diagnostic));
    } catch {
      // A diagnostic surface never changes Runtime behavior.
    }
    try {
      const row = boundedDiagnosticRow(diagnostic, maximumBytes);
      const rowBytes = Buffer.byteLength(row, "utf8");
      const information = statSync(options.filePath, { throwIfNoEntry: false });
      if (information === undefined || information.size + rowBytes > maximumBytes) {
        writeFileSync(options.filePath, row, { encoding: "utf8", mode: 0o600 });
      } else {
        appendFileSync(options.filePath, row, "utf8");
      }
    } catch {
      // The fixed summary remains available if the private durable sink is unavailable.
    }
  };
}

const recordProductionDiagnostic = createClaudeDiagnosticRecorder({
  filePath: productionDiagnosticFilePath,
});

export function productionClaudeDiagnosticObserver(
  diagnostic: ClaudeRuntimeDiagnostic,
): void {
  recordProductionDiagnostic(diagnostic);
}

export function claudeDiagnosticFilePath(): string {
  return productionDiagnosticFilePath;
}

function freezeDiagnostic(
  diagnostic: ClaudeRuntimeDiagnostic,
): ClaudeRuntimeDiagnostic {
  if (
    diagnostic.kind === "catalog-shape-rejected" ||
    diagnostic.kind === "control-response-rejected" ||
    diagnostic.kind === "settings-shape-rejected"
  ) {
    return Object.freeze({
      ...diagnostic,
      addedKeys: Object.freeze([...diagnostic.addedKeys]),
      missingKeys: Object.freeze([...diagnostic.missingKeys]),
      invalidKeys: Object.freeze([...diagnostic.invalidKeys]),
    });
  }
  return Object.freeze({ ...diagnostic });
}

function boundedDiagnosticRow(
  diagnostic: ClaudeRuntimeDiagnostic,
  maximumBytes: number,
): string {
  const recordedAt = new Date().toISOString();
  const detail = diagnostic.detail ?? "";
  const detailBytes = Buffer.from(detail, "utf8");
  const perDetailMaximum = Math.min(
    detailBytes.length,
    CLAUDE_DIAGNOSTIC_DETAIL_MAXIMUM_BYTES,
  );
  let low = 0;
  let high = perDetailMaximum;
  let accepted = serializeDiagnosticRow(recordedAt, diagnostic, "", detailBytes.length);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidateDetail = detailBytes.subarray(0, middle).toString("utf8");
    const candidate = serializeDiagnosticRow(
      recordedAt,
      diagnostic,
      candidateDetail,
      Math.max(0, detailBytes.length - Buffer.byteLength(candidateDetail, "utf8")),
    );
    if (Buffer.byteLength(candidate, "utf8") <= maximumBytes) {
      accepted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (Buffer.byteLength(accepted, "utf8") <= maximumBytes) return accepted;
  return `${JSON.stringify({
    recordedAt,
    kind: diagnostic.kind,
    category: diagnostic.category,
    diagnosticOmitted: true,
  })}\n`;
}

function serializeDiagnosticRow(
  recordedAt: string,
  diagnostic: ClaudeRuntimeDiagnostic,
  detail: string,
  detailOmittedBytes: number,
): string {
  return `${JSON.stringify({
    recordedAt,
    ...diagnostic,
    ...(diagnostic.detail === undefined ? {} : { detail, detailOmittedBytes }),
  })}\n`;
}

function fixedSummaryToken(value: string): string {
  return /^[a-z0-9_-]{1,80}$/u.test(value) ? value : "invalid-token";
}
