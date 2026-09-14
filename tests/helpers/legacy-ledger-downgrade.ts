/**
 * Statements that turn a current (schema v7) Project ledger back into a
 * genuine pre-v7 ledger for migration fixtures: Lane A's auto-iteration
 * tables are removed and the pre-v7 `updates` shape (NOT NULL command_id
 * foreign key) is restored. Era-specific column drops and the
 * `PRAGMA user_version` assignment stay with each fixture.
 */
export function preSevenDowngradeStatements(): readonly string[] {
  const autoIterationTables = [
    "auto_iteration_artifacts",
    "auto_iteration_attempts",
    "auto_iteration_context_observations",
    "auto_iteration_handoffs",
    "auto_iteration_inbox",
    "auto_iteration_outbox",
    "auto_iteration_quota_observations",
    "auto_iteration_receipts",
    "auto_iteration_requests",
    "auto_iteration_review_decisions",
    "auto_iteration_role_slots",
    "auto_iteration_tenures",
    "auto_iteration_work_orders",
  ];
  return Object.freeze([
    ...autoIterationTables.map((table) => `DROP TABLE ${table};`),
    "ALTER TABLE updates RENAME TO fixture_updates_v7;",
    `CREATE TABLE updates (
       cursor INTEGER PRIMARY KEY AUTOINCREMENT,
       project_id TEXT NOT NULL REFERENCES projects(project_id),
       command_id TEXT NOT NULL REFERENCES commands(command_id),
       kind TEXT NOT NULL,
       status TEXT NOT NULL,
       session_id TEXT,
       data_json TEXT
     ) STRICT;`,
    `INSERT INTO updates (
       cursor, project_id, command_id, kind, status, session_id, data_json
     )
     SELECT cursor, project_id, command_id, kind, status, session_id, data_json
       FROM fixture_updates_v7 ORDER BY cursor;`,
    "DROP TABLE fixture_updates_v7;",
  ]);
}
