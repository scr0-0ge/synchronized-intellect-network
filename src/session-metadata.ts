import type { DatabaseSync } from "node:sqlite";

export const SESSION_DISPLAY_NAME_MAX_CODE_POINTS = 80;
export const SESSION_AUTOMATIC_DISPLAY_NAME_MAX_CODE_POINTS = 60;

export type SessionDisplayNameSource = "default" | "manual";

export type SessionMetadataOperation =
  | { readonly kind: "rename"; readonly displayName: string }
  | { readonly kind: "archive" }
  | { readonly kind: "restore" };

export interface SessionMetadataMutationRequest {
  readonly sessionId: string;
  readonly operation: SessionMetadataOperation;
}

export type SessionMetadataMutationResult =
  | { readonly status: "renamed" }
  | { readonly status: "archived" }
  | { readonly status: "restored" }
  | { readonly status: "unchanged" }
  | { readonly status: "not-found" }
  | { readonly status: "invalid-name" }
  | {
      readonly status: "blocked";
      readonly activity: "accepted" | "in-flight" | "unknown";
    };

export interface StoredSessionMetadata {
  readonly displayName: string | null;
  readonly displayNameSource: SessionDisplayNameSource | null;
  readonly archived: 0 | 1;
}

export interface SessionMetadataProjection {
  readonly displayName: string;
  readonly archived: boolean;
}

export interface SessionMetadataProjectionRow {
  readonly display_name: string | null;
  readonly display_name_source: string | null;
  readonly display_ordinal: number;
  readonly archived: number;
  readonly lifecycle_status: string;
  readonly root_accepted_cursor: number;
  readonly root_private_envelope_json: string | null;
}

/**
 * The durable Session-metadata Module. Its narrow Interface owns generated and
 * legacy names, manual-name normalization, stored-row invariants, and the
 * archive/restore transition guard. SQLite remains a local Implementation
 * detail behind this seam.
 */
export interface SessionMetadataModule {
  acceptedInitial(input: unknown, displayOrdinal: number): StoredSessionMetadata;
  project(row: SessionMetadataProjectionRow): SessionMetadataProjection;
  mutate(
    request: SessionMetadataMutationRequest,
  ): SessionMetadataMutationResult;
  assertStoredRows(): void;
}

export function createSessionMetadataModule(
  database: DatabaseSync,
  projectId: string,
): SessionMetadataModule {
  const acceptedInitial = (
    input: unknown,
    displayOrdinal: number,
  ): StoredSessionMetadata => {
    assertDisplayOrdinal(displayOrdinal);
    const automaticName = automaticSessionDisplayName(input);
    return Object.freeze({
      displayName: automaticName ?? defaultDisplayName(displayOrdinal),
      displayNameSource: "default" as const,
      archived: 0 as const,
    });
  };

  const project = (
    row: SessionMetadataProjectionRow,
  ): SessionMetadataProjection => {
    assertProjectionRow(row);
    return Object.freeze({
      displayName:
        row.display_name ?? legacyFallbackDisplayName(row.root_accepted_cursor),
      archived: row.archived === 1,
    });
  };

  const assertStoredRows = (): void => {
    const rows = database
      .prepare(
        `SELECT session.display_name, session.display_name_source,
                session.display_ordinal, session.archived,
                session.lifecycle_status,
                root.accepted_cursor AS root_accepted_cursor,
                root.private_envelope_json AS root_private_envelope_json
           FROM sessions AS session
           JOIN commands AS root ON root.command_id = session.root_command_id
          WHERE session.project_id = ?`,
      )
      .all(projectId) as unknown as SessionMetadataProjectionRow[];
    for (const row of rows) project(row);
  };

  const mutate = (
    request: SessionMetadataMutationRequest,
  ): SessionMetadataMutationResult => {
    const exact = reconstructMutationRequest(request);
    if (exact === undefined) throw new Error("invalid-session-metadata-request");
    const normalizedName =
      exact.operation.kind === "rename"
        ? normalizeSessionDisplayName(exact.operation.displayName)
        : undefined;
    if (exact.operation.kind === "rename" && normalizedName === undefined) {
      return Object.freeze({ status: "invalid-name" as const });
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      const row = database
        .prepare(
          `SELECT session.display_name, session.display_name_source,
                  session.display_ordinal, session.archived,
                  session.lifecycle_status,
                  root.accepted_cursor AS root_accepted_cursor,
                  root.private_envelope_json AS root_private_envelope_json
             FROM sessions AS session
             JOIN commands AS root ON root.command_id = session.root_command_id
            WHERE session.project_id = ? AND session.session_id = ?`,
        )
        .get(projectId, exact.sessionId) as
        | SessionMetadataProjectionRow
        | undefined;
      if (row === undefined) {
        database.exec("COMMIT");
        return Object.freeze({ status: "not-found" as const });
      }
      project(row);

      let result: SessionMetadataMutationResult;
      if (exact.operation.kind === "rename") {
        if (
          row.display_name === normalizedName &&
          row.display_name_source === "manual"
        ) {
          result = Object.freeze({ status: "unchanged" as const });
        } else {
          requireSingleChange(
            database
              .prepare(
                `UPDATE sessions
                    SET display_name = ?, display_name_source = 'manual'
                  WHERE project_id = ? AND session_id = ?`,
              )
              .run(normalizedName!, projectId, exact.sessionId).changes,
          );
          result = Object.freeze({ status: "renamed" as const });
        }
      } else if (exact.operation.kind === "archive") {
        if (row.archived === 1) {
          result = Object.freeze({ status: "unchanged" as const });
        } else {
          const activity = archiveBlockingActivity(
            database,
            projectId,
            exact.sessionId,
            row.lifecycle_status,
          );
          if (activity !== undefined) {
            result = Object.freeze({
              status: "blocked" as const,
              activity,
            });
          } else {
            requireSingleChange(
              database
                .prepare(
                  `UPDATE sessions SET archived = 1
                    WHERE project_id = ? AND session_id = ? AND archived = 0`,
                )
                .run(projectId, exact.sessionId).changes,
            );
            result = Object.freeze({ status: "archived" as const });
          }
        }
      } else if (row.archived === 0) {
        result = Object.freeze({ status: "unchanged" as const });
      } else {
        requireSingleChange(
          database
            .prepare(
              `UPDATE sessions SET archived = 0
                WHERE project_id = ? AND session_id = ? AND archived = 1`,
            )
            .run(projectId, exact.sessionId).changes,
        );
        result = Object.freeze({ status: "restored" as const });
      }
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The caller still receives one fixed storage failure.
      }
      throw error;
    }
  };

  return Object.freeze({ acceptedInitial, project, mutate, assertStoredRows });
}

/**
 * Derives one deterministic, local title from the first meaningful prompt
 * line. No Runtime request is made, and the complete prompt is never copied
 * into presentation metadata.
 */
export function automaticSessionDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let firstMeaningfulLine: string | undefined;
  try {
    firstMeaningfulLine = value
      .split(/\r\n|[\n\r]/u)
      .map((line) => line.trim().replace(/\s+/gu, " ").normalize("NFC"))
      .find((line) => line.length > 0);
  } catch {
    return undefined;
  }
  if (firstMeaningfulLine === undefined) return undefined;
  const codePoints = Array.from(firstMeaningfulLine);
  const candidate =
    codePoints.length <= SESSION_AUTOMATIC_DISPLAY_NAME_MAX_CODE_POINTS
      ? firstMeaningfulLine
      : `${codePoints
          .slice(0, SESSION_AUTOMATIC_DISPLAY_NAME_MAX_CODE_POINTS - 1)
          .join("")}…`;
  return normalizeSessionDisplayName(candidate);
}

export function normalizeSessionDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let normalized: string;
  try {
    normalized = value.trim().normalize("NFC");
  } catch {
    return undefined;
  }
  if (
    normalized.length === 0 ||
    Array.from(normalized).length > SESSION_DISPLAY_NAME_MAX_CODE_POINTS ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(normalized) ||
    hasUnpairedSurrogate(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function assertProjectionRow(row: SessionMetadataProjectionRow): void {
  if (
    !Number.isSafeInteger(row.root_accepted_cursor) ||
    row.root_accepted_cursor <= 0 ||
    !Number.isSafeInteger(row.display_ordinal) ||
    row.display_ordinal <= 0 ||
    (row.root_private_envelope_json !== null &&
      typeof row.root_private_envelope_json !== "string") ||
    (row.archived !== 0 && row.archived !== 1) ||
    ![
      "accepted",
      "in-flight",
      "completed",
      "failed",
      "recovery-required",
    ].includes(row.lifecycle_status) ||
    (row.archived === 1 &&
      row.lifecycle_status !== "completed" &&
      row.lifecycle_status !== "failed")
  ) {
    throw new Error("invalid-session-metadata-row");
  }
  if (row.display_name === null || row.display_name_source === null) {
    if (row.display_name !== null || row.display_name_source !== null) {
      throw new Error("invalid-session-metadata-row");
    }
    return;
  }
  const normalized = normalizeSessionDisplayName(row.display_name);
  const automaticName = automaticSessionDisplayName(
    storedRootInput(row.root_private_envelope_json),
  );
  if (
    normalized !== row.display_name ||
    (row.display_name_source !== "default" &&
      row.display_name_source !== "manual") ||
    (row.display_name_source === "default" &&
      row.display_name !== defaultDisplayName(row.root_accepted_cursor) &&
      row.display_name !== defaultDisplayName(row.display_ordinal) &&
      row.display_name !== automaticName)
  ) {
    throw new Error("invalid-session-metadata-row");
  }
}

function assertDisplayOrdinal(displayOrdinal: number): void {
  if (!Number.isSafeInteger(displayOrdinal) || displayOrdinal <= 0) {
    throw new Error("invalid-display-ordinal");
  }
}

function storedRootInput(serialized: string | null): unknown {
  if (serialized === null) return undefined;
  try {
    const candidate: unknown = JSON.parse(serialized);
    return isRecord(candidate) ? candidate.input : undefined;
  } catch {
    return undefined;
  }
}

function defaultDisplayName(acceptedCursor: number): string {
  if (!Number.isSafeInteger(acceptedCursor) || acceptedCursor <= 0) {
    throw new Error("invalid-accepted-cursor");
  }
  return `Agent Session ${String(acceptedCursor).padStart(2, "0")}`;
}

function legacyFallbackDisplayName(acceptedCursor: number): string {
  return `Legacy Agent Session ${String(acceptedCursor).padStart(2, "0")}`;
}

function archiveBlockingActivity(
  database: DatabaseSync,
  projectId: string,
  sessionId: string,
  lifecycleStatus: string,
): "accepted" | "in-flight" | "unknown" | undefined {
  const active = database
    .prepare(
      `SELECT status
         FROM commands
        WHERE project_id = ? AND target_session_id = ?
          AND status IN ('accepted', 'in-flight', 'recovery-required')
        ORDER BY CASE status
          WHEN 'in-flight' THEN 0
          WHEN 'accepted' THEN 1
          ELSE 2
        END
        LIMIT 1`,
    )
    .get(projectId, sessionId) as
    | { readonly status: "accepted" | "in-flight" | "recovery-required" }
    | undefined;
  const status = active?.status ?? lifecycleStatus;
  if (status === "in-flight") return "in-flight";
  if (status === "accepted") return "accepted";
  if (status === "recovery-required") return "unknown";
  if (status === "completed" || status === "failed") return undefined;
  throw new Error("invalid-session-activity");
}

function reconstructMutationRequest(
  value: unknown,
): SessionMetadataMutationRequest | undefined {
  try {
    if (!isExactRecord(value, ["operation", "sessionId"])) return undefined;
    if (typeof value.sessionId !== "string" || value.sessionId.trim().length === 0) {
      return undefined;
    }
    const operation = value.operation;
    if (!isRecord(operation) || typeof operation.kind !== "string") {
      return undefined;
    }
    if (operation.kind === "rename") {
      if (
        !isExactRecord(operation, ["displayName", "kind"]) ||
        typeof operation.displayName !== "string"
      ) {
        return undefined;
      }
      return Object.freeze({
        sessionId: value.sessionId,
        operation: Object.freeze({
          kind: "rename" as const,
          displayName: operation.displayName,
        }),
      });
    }
    if (
      (operation.kind !== "archive" && operation.kind !== "restore") ||
      !isExactRecord(operation, ["kind"])
    ) {
      return undefined;
    }
    return Object.freeze({
      sessionId: value.sessionId,
      operation: Object.freeze({ kind: operation.kind }),
    });
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype;
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  const expected = [...expectedKeys].sort();
  const exact = (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    Object.values(descriptors).every(
      (descriptor) =>
        descriptor.enumerable === true &&
        "value" in descriptor &&
        descriptor.get === undefined &&
        descriptor.set === undefined,
    )
  );
  if (!exact) return false;
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

function requireSingleChange(changes: number | bigint): void {
  if (Number(changes) !== 1) throw new Error("session-metadata-write-failed");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
