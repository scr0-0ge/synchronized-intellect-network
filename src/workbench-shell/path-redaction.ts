/**
 * The four filesystem-path redaction rules, in their one shared home.
 *
 * Both sanitizing boundaries — `live-view.ts` (main-process Project views) and
 * `result-sanitizer.ts` (renderer-side reconstruction) — apply exactly these
 * rules to every agent-visible string. `publicationPosture` records that
 * transcripts and evidence carry no raw filesystem path, and users of a public
 * repository will paste transcripts into bug reports, so this is a load-bearing
 * privacy boundary: a rule that stops matching real paths is a worse defect
 * than one that over-matches.
 *
 * The four rules, in application order:
 *   1. `file:///` URLs.
 *   2. Windows drive paths (`C:\...`, `C:/...`).
 *   3. UNC paths (`\\server\share\...`).
 *   4. Slash-initial POSIX-shaped paths after whitespace, `(` or start.
 *
 * Rule 4 must NOT swallow the slash-initial shapes that are prose, not paths
 * (F222 rendered `// comments` as the literal token `[path]`):
 *   - `//` followed by whitespace, end of text, or only more slashes is a line
 *     comment (or a divider row), never a path — it survives.
 *   - `//word` with no further `/` before whitespace (`//TODO:`) survives too.
 *   - `/*` opens a block comment — it survives; the star-slash close marker
 *     starts with a star, so it never matched any rule to begin with.
 *   - `//host/more` keeps redacting: forward-slash UNC (`//server/share/file`)
 *     is a real path form, and a protocol-relative URL is indistinguishable
 *     from it, so both redact — the deliberate, privacy-first false positive.
 *   - Scheme URLs (`https://...`) never matched rule 4 (their slashes follow
 *     `:` or `/`, not whitespace) and continue to render as written.
 */
export function redactFilesystemPaths(value: string): string {
  return value
    .replace(/file:\/\/\/[^\s<>"]+/giu, "[path]")
    .replace(/\b[A-Za-z]:[\\/][^\s<>"|?*\u0000-\u001f]+/gu, "[path]")
    .replace(/\\\\[^\\/\s]+[\\/][^\s<>"|?*\u0000-\u001f]+/gu, "[path]")
    .replace(
      /(^|[\s(])(?:\/(?![/*])(?:[^\s/]+\/)*[^\s)]+|\/\/(?=[^\s/)]+\/[^\s)])[^\s)]+)/gu,
      "$1[path]",
    );
}
