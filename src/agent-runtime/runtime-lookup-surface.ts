// What each runtime lookup asks for, and where it asks.
//
// This module has NO IMPORTS on purpose. It is the one description of the
// lookup that both the discovery code and the renderer read, so the sentence a
// user is shown when nothing was found cannot drift away from what was actually
// tried. `start.bat` sets the standard this mirrors: when it cannot find pnpm it
// prints every name and every directory it looked in, plus where to get the
// tool. The in-app path said "No lookup path is exposed." and offered nothing.
//
// Locations are a fixed VOCABULARY, not runtime-derived paths. That is a
// deliberate choice, not an oversight: `path-redaction.ts` is a load-bearing
// privacy boundary in this product because users paste transcripts into public
// bug reports, and naming `%APPDATA%\npm` as a constant tells a user exactly
// where to look without transporting one resolved absolute path -- which would
// carry their account name -- across the IPC boundary.
//
// Names are recorded PER PLACE rather than once for the whole lookup, because
// they genuinely differ: a PATH lookup reaches four names, while the two
// single-file probes only ever ask for the `.exe`. Claiming otherwise would
// make the failure text wrong in the specific way that wastes a user's time.

export type RuntimeLookupLocation =
  | "path"
  | "npm-global-prefix"
  | "codex-official-bin"
  | "claude-local-bin"
  | "claude-managed-root";

export interface RuntimeLookupPlace {
  readonly location: RuntimeLookupLocation;
  readonly names: readonly string[];
}

export interface RuntimeLookupSurface {
  /** The command name the vendor documents, without an extension. */
  readonly command: string;
  /** The published npm package, used to resolve a shim structurally. */
  readonly packageName: string;
  /** Every place the lookup asks, in the order it asks, with the names it uses. */
  readonly places: readonly RuntimeLookupPlace[];
  /** Where a user who has none of this installed should go. */
  readonly installUrl: string;
}

/**
 * The names a PATH lookup reaches, in the order Windows itself resolves them.
 *
 * Asking `where.exe` for the BARE command name is what makes all of these
 * reachable in one call, because that is when `where.exe` consults `PATHEXT`;
 * asking for an explicit `codex.exe` consults nothing and is the whole defect.
 * The extensionless entry is a POSIX sh script and is never launched -- it is
 * only evidence that an npm global install lives in that directory.
 *
 * `.ps1` is deliberately NOT here. It is not in the default `PATHEXT`, so a
 * PATH lookup cannot return it -- verified on this machine, where `where.exe
 * npm` returns `npm` and `npm.cmd` and never `npm.ps1`. npm writes all three
 * shims together, so nothing is lost by it, and claiming to have looked for a
 * name we cannot see would make the failure text lie. A `.ps1` a user names
 * explicitly in Settings is still accepted; see `classifyLaunchTargetName`.
 */
export function windowsRuntimeLookupNames(command: string): readonly string[] {
  return Object.freeze([
    `${command}.exe`,
    `${command}.cmd`,
    `${command}.bat`,
    command,
  ]);
}

export const CODEX_RUNTIME_LOOKUP_SURFACE: RuntimeLookupSurface = Object.freeze({
  command: "codex",
  packageName: "@openai/codex",
  places: Object.freeze([
    Object.freeze({
      location: "path" as const,
      names: windowsRuntimeLookupNames("codex"),
    }),
    Object.freeze({
      location: "npm-global-prefix" as const,
      names: windowsRuntimeLookupNames("codex"),
    }),
    Object.freeze({
      location: "codex-official-bin" as const,
      names: Object.freeze(["codex.exe"]),
    }),
  ]),
  installUrl: "https://developers.openai.com/codex/cli",
});

export const CLAUDE_RUNTIME_LOOKUP_SURFACE: RuntimeLookupSurface = Object.freeze({
  command: "claude",
  packageName: "@anthropic-ai/claude-code",
  places: Object.freeze([
    Object.freeze({
      location: "path" as const,
      names: windowsRuntimeLookupNames("claude"),
    }),
    Object.freeze({
      location: "npm-global-prefix" as const,
      names: windowsRuntimeLookupNames("claude"),
    }),
    Object.freeze({
      location: "claude-local-bin" as const,
      names: Object.freeze(["claude.exe"]),
    }),
    Object.freeze({
      location: "claude-managed-root" as const,
      names: Object.freeze(["claude.exe"]),
    }),
  ]),
  installUrl: "https://docs.claude.com/en/docs/claude-code/setup",
});

export const RUNTIME_LOOKUP_SURFACES: Readonly<
  Record<"codex" | "claude", RuntimeLookupSurface>
> = Object.freeze({
  codex: CODEX_RUNTIME_LOOKUP_SURFACE,
  claude: CLAUDE_RUNTIME_LOOKUP_SURFACE,
});
