import { execFile } from "node:child_process";
import { win32 } from "node:path";

const maximumNativeObservationBytes = 1_024;
const desktopAcrylicBackdropType = 3;
export const designedWindowGround = "#0b0e13" as const;

export type NativeWindowMaterialState =
  | "applied"
  | "unavailable"
  | "undetermined";

export interface NativeWindowMaterialBoundary {
  getNativeWindowHandle(): Buffer;
  setBackgroundColor(color: typeof designedWindowGround): void;
  setBackgroundMaterial(material: "none"): void;
}

export type WindowsDwmObservation = Readonly<{
  queryHresult: number;
  systemBackdropType: number;
  borderHresult: number;
  captionHresult: number;
}>;

export type NativeWindowMaterialVerification = Readonly<{
  state: NativeWindowMaterialState;
  borderSuppressed: boolean;
  borderHresult: number | null;
  captionSuppressed: boolean;
  captionHresult: number | null;
  groundApplied: boolean;
  systemBackdropType: number | null;
}>;

export function shouldPresentWindowsAcrylic(
  state: NativeWindowMaterialState,
): boolean {
  return state !== "unavailable";
}

export function formatNativeWindowMaterialDiagnostic(
  state: NativeWindowMaterialState,
): string {
  return `[native-window-material] state=${state};presentation=${
    shouldPresentWindowsAcrylic(state) ? "native" : "fallback"
  }`;
}

/* The frame is a SECOND observation and is reported on its own line. The
   material diagnostic above answers "did DWM give us the backdrop"; it has
   never been able to answer "is Windows still painting the accent colour on
   this window", and a combined line could not say which half failed (rule 4).
   F204 cost a whole cycle to this: the launch log read state=applied while the
   accent caption was on screen, because the suppression HRESULTs were computed
   and then dropped on the floor. They are printed here instead. */
function formatSuppressionOutcome(
  suppressed: boolean,
  hresult: number | null,
): string {
  if (hresult === null) return "not-attempted";
  return `${suppressed ? "ok" : "FAILED"}(hresult=0x${(hresult >>> 0)
    .toString(16)
    .padStart(8, "0")})`;
}

export function formatNativeWindowFrameDiagnostic(
  verification: NativeWindowMaterialVerification | null,
): string {
  if (verification === null) {
    return "[native-window-frame] probe=skipped;border=not-attempted;caption=not-attempted";
  }
  return `[native-window-frame] probe=ran;border=${formatSuppressionOutcome(
    verification.borderSuppressed,
    verification.borderHresult,
  )};caption=${formatSuppressionOutcome(
    verification.captionSuppressed,
    verification.captionHresult,
  )}`;
}

export type NativeWindowFrameReassertion = Readonly<{
  triggers: readonly string[];
  coalescedNotifications: number;
  verification: NativeWindowMaterialVerification | null;
  failure: string | null;
}>;

/* The re-assertion line is deliberately the SAME `[native-window-frame]` prefix
   and the same `border=`/`caption=` vocabulary as the launch-time probe above,
   so one grep over `run-app.log` shows the whole life of the suppression: the
   `probe=ran` line once, then a `reassert=` line per accent recomputation. It is
   a distinct line rather than a re-print of the probe line because a reader must
   be able to tell the launch-time observation from the later ones (rule 4): a
   suppression that worked at launch and failed an hour later is a different
   fact from one that never worked. */
export function formatNativeWindowFrameReassertionDiagnostic(
  reassertion: NativeWindowFrameReassertion,
): string {
  const preamble = `[native-window-frame] reassert=${
    reassertion.failure === null ? "ran" : "FAILED"
  };trigger=${
    reassertion.triggers.length === 0 ? "none" : reassertion.triggers.join("+")
  };coalesced=${reassertion.coalescedNotifications}`;
  if (reassertion.failure !== null) {
    return `${preamble};reason=${reassertion.failure}`;
  }
  const verification = reassertion.verification;
  return `${preamble};border=${formatSuppressionOutcome(
    verification?.borderSuppressed ?? false,
    verification?.borderHresult ?? null,
  )};caption=${formatSuppressionOutcome(
    verification?.captionSuppressed ?? false,
    verification?.captionHresult ?? null,
  )}`;
}

export type NativeWindowProcessRunner = (
  executable: string,
  arguments_: readonly string[],
  options: Readonly<{
    cwd: string;
    encoding: "utf8";
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    timeout: number;
    windowsHide: true;
  }>,
) => Promise<string>;

type WindowsDwmReader = (handle: bigint) => Promise<WindowsDwmObservation>;

const powershellProgram = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class UnifiedWorkbenchDwm
{
    private const uint SystemBackdropType = 38;
    private const uint BorderColor = 34;
    private const uint CaptionColor = 35;
    private const uint ColorNone = 0xFFFFFFFEu;

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(
        IntPtr window,
        uint attribute,
        out int value,
        uint valueSize);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(
        IntPtr window,
        uint attribute,
        ref uint value,
        uint valueSize);

    public static int ReadSystemBackdrop(IntPtr window, out int value)
    {
        return DwmGetWindowAttribute(
            window,
            SystemBackdropType,
            out value,
            (uint)Marshal.SizeOf(typeof(int)));
    }

    public static int SuppressBorder(IntPtr window)
    {
        uint value = ColorNone;
        return DwmSetWindowAttribute(
            window,
            BorderColor,
            ref value,
            (uint)Marshal.SizeOf(typeof(uint)));
    }

    // DWMWA_CAPTION_COLOR, not DWMWA_BORDER_COLOR, is what Windows 11 paints in
    // the accent colour when ColorPrevalence is on. Measured on the owner's
    // machine at 2026-08-29: SuppressBorder returns S_OK and changes not one
    // pixel, while the caption band and the two rounded top corners are the
    // accent colour; suppressing the caption makes the top band pixel-identical
    // to the body and the top corners identical to the bottom ones. See F204.
    public static int SuppressCaption(IntPtr window)
    {
        uint value = ColorNone;
        return DwmSetWindowAttribute(
            window,
            CaptionColor,
            ref value,
            (uint)Marshal.SizeOf(typeof(uint)));
    }
}
'@
$handleValue = [long]::Parse(
  $env:UAW_NATIVE_WINDOW_HANDLE,
  [Globalization.CultureInfo]::InvariantCulture
)
$window = [IntPtr]::new($handleValue)
$backdrop = 0
$queryResult = [UnifiedWorkbenchDwm]::ReadSystemBackdrop($window, [ref]$backdrop)
$borderResult = [UnifiedWorkbenchDwm]::SuppressBorder($window)
$captionResult = [UnifiedWorkbenchDwm]::SuppressCaption($window)
[Console]::Out.WriteLine(
  ('DWM|{0}|{1}|{2}|{3}' -f $queryResult, $backdrop, $borderResult, $captionResult)
)
`;

const encodedPowershellProgram = Buffer.from(
  powershellProgram,
  "utf16le",
).toString("base64");

const runNativeWindowProcess: NativeWindowProcessRunner = (
  executable,
  arguments_,
  options,
) =>
  new Promise<string>((resolveOutput, reject) => {
    execFile(
      executable,
      [...arguments_],
      options,
      (error, stdout) => (error ? reject(error) : resolveOutput(stdout)),
    );
  });

export async function readWindowsDwmObservation(
  handle: bigint,
  runProcess: NativeWindowProcessRunner = runNativeWindowProcess,
): Promise<WindowsDwmObservation> {
  const systemRoot = readWindowsSystemRoot(process.env);
  const systemDirectory = win32.join(systemRoot, "System32");
  const executable = win32.join(
    systemDirectory,
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const output = await runProcess(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodedPowershellProgram,
    ],
    Object.freeze({
      cwd: systemDirectory,
      encoding: "utf8" as const,
      env: createNativeHelperEnvironment(
        systemRoot,
        handle,
        process.env,
      ),
      maxBuffer: maximumNativeObservationBytes,
      timeout: 5_000,
      windowsHide: true as const,
    }),
  );
  const match = /^DWM\|(-?\d+)\|(-?\d+)\|(-?\d+)\|(-?\d+)\r?\n?$/u.exec(output);
  if (match === null) throw new Error("native-window-observation-invalid");
  const values = match.slice(1).map((value) => Number.parseInt(value!, 10));
  if (
    values.some(
      (value) =>
        !Number.isInteger(value) ||
        value < -2_147_483_648 ||
        value > 2_147_483_647,
    )
  ) {
    throw new Error("native-window-observation-invalid");
  }
  return Object.freeze({
    queryHresult: values[0]!,
    systemBackdropType: values[1]!,
    borderHresult: values[2]!,
    captionHresult: values[3]!,
  });
}

export async function configureWindowsAcrylicWindow(
  window: NativeWindowMaterialBoundary,
  readDwm: WindowsDwmReader = readWindowsDwmObservation,
): Promise<NativeWindowMaterialVerification> {
  try {
    const handle = readNativeWindowHandle(window.getNativeWindowHandle());
    if (handle === undefined) return nativeMaterialUndetermined();
    const observation = await readDwm(handle);
    if (observation.queryHresult !== 0) {
      return nativeMaterialUndetermined(observation);
    }
    if (observation.systemBackdropType !== desktopAcrylicBackdropType) {
      return nativeMaterialUndetermined(observation);
    }
    return Object.freeze({
      state: "applied",
      borderSuppressed: observation.borderHresult === 0,
      borderHresult: observation.borderHresult,
      captionSuppressed: observation.captionHresult === 0,
      captionHresult: observation.captionHresult,
      groundApplied: false,
      systemBackdropType: observation.systemBackdropType,
    });
  } catch {
    return nativeMaterialUndetermined();
  }
}

function readWindowsSystemRoot(environment: NodeJS.ProcessEnv): string {
  const candidates = [environment.SystemRoot, environment.WINDIR].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (candidates.length === 0) {
    throw new Error("windows-system-root-unavailable");
  }
  const normalized = candidates.map((value) => win32.normalize(value));
  if (
    normalized.some(
      (value) =>
        !win32.isAbsolute(value) ||
        !/^[A-Za-z]:\\/u.test(value) ||
        value.includes("\0"),
    ) ||
    normalized.some(
      (value) => value.toLowerCase() !== normalized[0]!.toLowerCase(),
    )
  ) {
    throw new Error("windows-system-root-invalid");
  }
  return normalized[0]!;
}

function createNativeHelperEnvironment(
  systemRoot: string,
  handle: bigint,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot,
    UAW_NATIVE_WINDOW_HANDLE: handle.toString(10),
    WINDIR: systemRoot,
  };
  for (const name of ["TEMP", "TMP"] as const) {
    const value = environment[name];
    if (
      typeof value === "string" &&
      value.length > 0 &&
      win32.isAbsolute(value) &&
      !value.includes("\0")
    ) {
      childEnvironment[name] = win32.normalize(value);
    }
  }
  return Object.freeze(childEnvironment);
}

function readNativeWindowHandle(buffer: Buffer): bigint | undefined {
  const value =
    buffer.length === 8
      ? buffer.readBigUInt64LE()
      : buffer.length === 4
        ? BigInt(buffer.readUInt32LE())
        : 0n;
  return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? value
    : undefined;
}

function nativeMaterialUndetermined(
  observation?: WindowsDwmObservation,
): NativeWindowMaterialVerification {
  return Object.freeze({
    state: "undetermined",
    borderSuppressed: observation?.borderHresult === 0,
    borderHresult: observation?.borderHresult ?? null,
    captionSuppressed: observation?.captionHresult === 0,
    captionHresult: observation?.captionHresult ?? null,
    groundApplied: false,
    systemBackdropType: null,
  });
}
