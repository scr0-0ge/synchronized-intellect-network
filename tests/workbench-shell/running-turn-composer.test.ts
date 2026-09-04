import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  WorkbenchHostedProjectView,
  WorkbenchHostedProjectResult,
} from "../../src/workbench-shell/contract.ts";
import {
  initialRendererState,
  replaceProjectResult,
  updateDirectInputDraft,
} from "../../src/workbench-shell/renderer/view-model.ts";
import { interruptVisualFixture } from "./visual-harness/fixture.ts";

const composerSource = await readFile(
  new URL("../../src/workbench-shell/renderer/composer.tsx", import.meta.url),
  "utf8",
);

test("the running-turn textarea stays enabled without weakening blur-only focus or lazy picker discovery", () => {
  assert.doesNotMatch(
    composerSource,
    /classList=\{\{\s*"is-disabled":\s*activeTurn\(\)\s*\}\}/u,
  );
  assert.doesNotMatch(
    composerSource,
    /disabled=\{\s*activeTurn\(\)\s*\|\|/u,
  );
  assert.match(composerSource, /onBlur=\{noteComposerBlur\}/u);
  assert.match(composerSource, /currentTarget as HTMLTextAreaElement[\s\S]*?\.disabled/u);
  assert.doesNotMatch(composerSource, /onFocus=/u);
  assert.match(
    composerSource,
    /kind === "endpoint" && props\.profile\.phase === "idle"[\s\S]*?props\.onLoadProfile\(\)/u,
  );
});

test("Codex and Claude running-turn drafts survive the terminal snapshot unchanged", () => {
  for (const runtimeFamilyLabel of ["Codex", "Claude Code"] as const) {
    const running = runtimeView(runtimeFamilyLabel, "in-flight");
    const active = replaceProjectResult(initialRendererState, result(running));
    const typed = updateDirectInputDraft(
      active,
      `Corrective draft for ${runtimeFamilyLabel}`,
    );
    assert.equal(
      typed.composer.draft,
      `Corrective draft for ${runtimeFamilyLabel}`,
      `${runtimeFamilyLabel} accepts typing while active`,
    );

    const settled = replaceProjectResult(
      typed,
      result(runtimeView(runtimeFamilyLabel, "completed")),
    );
    assert.equal(
      settled.composer.draft,
      typed.composer.draft,
      `${runtimeFamilyLabel} keeps an unsent active-turn draft after terminal`,
    );
  }
});

function runtimeView(
  runtimeFamilyLabel: "Codex" | "Claude Code",
  status: "in-flight" | "completed",
): WorkbenchHostedProjectView {
  return Object.freeze({
    ...interruptVisualFixture,
    observation: Object.freeze({
      ...interruptVisualFixture.observation,
      cursor: status === "in-flight" ? 41 : 42,
    }),
    commands: Object.freeze(
      interruptVisualFixture.commands.map((command) => {
        if (command.key !== "command-2") return command;
        const { interrupt: _interrupt, ...base } = command;
        const session = command.session!;
        return Object.freeze({
          ...base,
          runtime: runtimeFamilyLabel,
          status,
          ...(status === "in-flight"
            ? { interrupt: command.interrupt }
            : {}),
          session: Object.freeze({
            ...session,
            profile: Object.freeze({
              ...session.profile,
              requested:
                session.profile.requested.kind === "recorded"
                  ? Object.freeze({
                      ...session.profile.requested,
                      runtimeFamilyLabel,
                    })
                  : session.profile.requested,
            }),
            resumable: status === "completed",
            selectionKey:
              status === "completed"
                ? "session-selection:00000000-0000-4000-8000-000000000099"
                : null,
            timeline:
              status === "completed"
                ? Object.freeze([
                    ...session.timeline,
                    Object.freeze({
                      kind: "turn-completed" as const,
                      status: "completed" as const,
                    }),
                  ])
                : session.timeline,
          }),
        });
      }),
    ),
  });
}

function result(view: WorkbenchHostedProjectView): WorkbenchHostedProjectResult {
  return Object.freeze({ ok: true, view });
}
