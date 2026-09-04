import assert from "node:assert/strict";
import { win32 } from "node:path";
import test from "node:test";

import {
  configureWindowsAcrylicWindow,
  formatNativeWindowFrameDiagnostic,
  formatNativeWindowMaterialDiagnostic,
  readWindowsDwmObservation,
  shouldPresentWindowsAcrylic,
  type NativeWindowMaterialBoundary,
  type NativeWindowProcessRunner,
} from "../../src/workbench-shell/electron/native-window-material.ts";
import { withProcessEnvironment } from "../helpers/process-state.ts";

function nativeHandle(value: bigint): Buffer {
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(value);
  return handle;
}

test("the visual baseline survives undetermined and falls back only when unavailable", () => {
  assert.equal(shouldPresentWindowsAcrylic("applied"), true);
  assert.equal(shouldPresentWindowsAcrylic("undetermined"), true);
  assert.equal(shouldPresentWindowsAcrylic("unavailable"), false);
  assert.equal(
    formatNativeWindowMaterialDiagnostic("applied"),
    "[native-window-material] state=applied;presentation=native",
  );
  assert.equal(
    formatNativeWindowMaterialDiagnostic("undetermined"),
    "[native-window-material] state=undetermined;presentation=native",
  );
  assert.equal(
    formatNativeWindowMaterialDiagnostic("unavailable"),
    "[native-window-material] state=unavailable;presentation=fallback",
  );
});

test("native acrylic is reported only after the DWM getter proves Desktop Acrylic", async () => {
  const disabled: string[] = [];
  const grounds: string[] = [];
  const window = Object.freeze({
    getNativeWindowHandle: () => nativeHandle(0x1234n),
    setBackgroundColor(color: "#0b0e13") {
      grounds.push(color);
    },
    setBackgroundMaterial(material: "none") {
      disabled.push(material);
    },
  }) satisfies NativeWindowMaterialBoundary;

  const verified = await configureWindowsAcrylicWindow(window, async (handle) => {
    assert.equal(handle, 0x1234n);
    return Object.freeze({
      queryHresult: 0,
      systemBackdropType: 3,
      borderHresult: 0,
      captionHresult: 0,
    });
  });

  assert.deepEqual(verified, {
    state: "applied",
    borderSuppressed: true,
    borderHresult: 0,
    captionSuppressed: true,
    captionHresult: 0,
    groundApplied: false,
    systemBackdropType: 3,
  });
  assert.equal(Object.isFrozen(verified), true);
  assert.deepEqual(grounds, []);
  assert.deepEqual(disabled, []);
});

test("an unexpected successful backdrop probe never switches off working acrylic", async () => {
  const calls: string[] = [];
  const unavailable = await configureWindowsAcrylicWindow(
    {
      getNativeWindowHandle: () => nativeHandle(0x5678n),
      setBackgroundColor(color: "#0b0e13") {
        calls.push(`ground:${color}`);
      },
      setBackgroundMaterial(material: "none") {
        calls.push(`material:${material}`);
      },
    },
    async () =>
      Object.freeze({
        queryHresult: 0,
        systemBackdropType: 2,
        borderHresult: -1,
        captionHresult: -1,
      }),
  );

  assert.deepEqual(unavailable, {
    state: "undetermined",
    borderSuppressed: false,
    borderHresult: -1,
    captionSuppressed: false,
    captionHresult: -1,
    groundApplied: false,
    systemBackdropType: null,
  });
  assert.deepEqual(calls, []);
});

test("a failed or timed-out probe reports undetermined without switching off working acrylic", async () => {
  const timeout = Object.assign(new Error("probe timed out"), {
    code: "ETIMEDOUT",
    killed: true,
    signal: "SIGTERM",
  });
  const cases = [
    {
      inspect: async () =>
        Object.freeze({
          queryHresult: -1,
          systemBackdropType: 3,
          borderHresult: 0,
          captionHresult: 0,
        }),
      suppression: {
        borderSuppressed: true,
        borderHresult: 0,
        captionSuppressed: true,
        captionHresult: 0,
      },
    },
    {
      inspect: async () => {
        throw new Error("PRIVATE_NATIVE_FAILURE");
      },
      suppression: {
        borderSuppressed: false,
        borderHresult: null,
        captionSuppressed: false,
        captionHresult: null,
      },
    },
    {
      inspect: async () => {
        throw timeout;
      },
      suppression: {
        borderSuppressed: false,
        borderHresult: null,
        captionSuppressed: false,
        captionHresult: null,
      },
    },
  ] as const;

  for (const { inspect, suppression } of cases) {
    const calls: string[] = [];
    const result = await configureWindowsAcrylicWindow(
      {
        getNativeWindowHandle: () => nativeHandle(0x5678n),
        setBackgroundColor(color: "#0b0e13") {
          calls.push(`ground:${color}`);
        },
        setBackgroundMaterial(material: "none") {
          calls.push(`material:${material}`);
        },
      },
      inspect,
    );
    assert.deepEqual(result, {
      state: "undetermined",
      ...suppression,
      groundApplied: false,
      systemBackdropType: null,
    });
    assert.deepEqual(calls, []);
  }

  let inspected = false;
  const invalidHandleCalls: string[] = [];
  const invalidHandleResult = await configureWindowsAcrylicWindow(
    {
      getNativeWindowHandle: () => Buffer.alloc(3),
      setBackgroundColor(color: "#0b0e13") {
        invalidHandleCalls.push(`ground:${color}`);
      },
      setBackgroundMaterial(material: "none") {
        invalidHandleCalls.push(`material:${material}`);
      },
    },
    async () => {
      inspected = true;
      throw new Error("must not run");
    },
  );
  assert.equal(inspected, false);
  assert.deepEqual(invalidHandleResult, {
    state: "undetermined",
    borderSuppressed: false,
    borderHresult: null,
    captionSuppressed: false,
    captionHresult: null,
    groundApplied: false,
    systemBackdropType: null,
  });
  assert.deepEqual(invalidHandleCalls, []);

  let throwingGetterInspected = false;
  const throwingGetterCalls: string[] = [];
  const throwingGetterResult = await configureWindowsAcrylicWindow(
    {
      getNativeWindowHandle() {
        throw new Error("PRIVATE_HANDLE_FAILURE");
      },
      setBackgroundColor(color: "#0b0e13") {
        throwingGetterCalls.push(`ground:${color}`);
      },
      setBackgroundMaterial(material: "none") {
        throwingGetterCalls.push(`material:${material}`);
      },
    },
    async () => {
      throwingGetterInspected = true;
      throw new Error("must not run");
    },
  );
  assert.equal(throwingGetterInspected, false);
  assert.deepEqual(throwingGetterResult, {
    state: "undetermined",
    borderSuppressed: false,
    borderHresult: null,
    captionSuppressed: false,
    captionHresult: null,
    groundApplied: false,
    systemBackdropType: null,
  });
  assert.equal(Object.isFrozen(throwingGetterResult), true);
  assert.deepEqual(throwingGetterCalls, []);
});

test("the production DWM reader uses one hidden fixed PowerShell program and parses only its exact record", async () => {
  const calls: Array<
    Readonly<{
      executable: string;
      arguments_: readonly string[];
      options: Readonly<{
        cwd: string;
        encoding: "utf8";
        env: NodeJS.ProcessEnv;
        maxBuffer: number;
        timeout: number;
        windowsHide: true;
      }>;
    }>
  > = [];
  const runner: NativeWindowProcessRunner = async (
    executable,
    arguments_,
    options,
  ) => {
    calls.push({ executable, arguments_, options });
    return "DWM|0|3|0|0\r\n";
  };

  const privateSentinel = "UAW_WORKER140_PRIVATE_SENTINEL";
  await withProcessEnvironment(
    { [privateSentinel]: "must-not-reach-native-helper" },
    async () => {
      assert.deepEqual(await readWindowsDwmObservation(0x9876n, runner), {
        queryHresult: 0,
        systemBackdropType: 3,
        borderHresult: 0,
        captionHresult: 0,
      });
    },
  );
  assert.equal(calls.length, 1);
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  assert.ok(systemRoot, "Windows must expose its system root");
  const expectedExecutable = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  assert.equal(win32.isAbsolute(calls[0]?.executable ?? ""), true);
  assert.equal(
    win32.normalize(calls[0]?.executable ?? "").toLowerCase(),
    win32.normalize(expectedExecutable).toLowerCase(),
  );
  assert.deepEqual(calls[0]?.arguments_.slice(0, 3), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
  ]);
  assert.equal(calls[0]?.arguments_[3], "-EncodedCommand");
  assert.match(calls[0]?.arguments_[4] ?? "", /^[A-Za-z0-9+/]+=*$/u);
  assert.equal(
    win32.normalize(calls[0]?.options.cwd ?? "").toLowerCase(),
    win32.join(win32.normalize(systemRoot), "System32").toLowerCase(),
  );
  assert.equal(calls[0]?.options.windowsHide, true);
  assert.equal(calls[0]?.options.encoding, "utf8");
  assert.equal(calls[0]?.options.timeout, 5_000);
  assert.equal(calls[0]?.options.env[privateSentinel], undefined);
  assert.equal(calls[0]?.options.env.Path, undefined);
  assert.equal(calls[0]?.options.env.PATH, undefined);
  assert.equal(calls[0]?.options.env.UAW_NATIVE_WINDOW_HANDLE, "39030");
  const allowedEnvironmentNames = new Set([
    "SystemRoot",
    "TEMP",
    "TMP",
    "UAW_NATIVE_WINDOW_HANDLE",
    "WINDIR",
  ]);
  assert.equal(
    Object.keys(calls[0]?.options.env ?? {}).every((name) =>
      allowedEnvironmentNames.has(name),
    ),
    true,
  );

  // The record is an exact shape, not a prefix match. The five-field form is
  // the only accepted one: a sixth field is refused, and so is the four-field
  // record this reader accepted before the caption suppression existed — a
  // helper that silently dropped SuppressCaption must fail closed rather than
  // let the product report a frame it never suppressed (rule 1 / F26).
  for (const record of [
    "DWM|0|3|0|0|extra",
    "DWM|0|3|0",
    "DWM|0|3",
    "DWM|0|3|0|",
    "DWM|0|3|0|0x0",
  ]) {
    const malformed: NativeWindowProcessRunner = async () => record;
    await assert.rejects(
      readWindowsDwmObservation(0x9876n, malformed),
      /native-window-observation-invalid/u,
      record,
    );
  }
});

test("a frame suppression that fails is named in the launch log with its HRESULT", () => {
  assert.equal(
    formatNativeWindowFrameDiagnostic(null),
    "[native-window-frame] probe=skipped;border=not-attempted;caption=not-attempted",
  );
  assert.equal(
    formatNativeWindowFrameDiagnostic({
      state: "applied",
      borderSuppressed: true,
      borderHresult: 0,
      captionSuppressed: true,
      captionHresult: 0,
      groundApplied: false,
      systemBackdropType: 3,
    }),
    "[native-window-frame] probe=ran;border=ok(hresult=0x00000000);caption=ok(hresult=0x00000000)",
  );
  // E_INVALIDARG on the caption is the shape F204 would have shown had anyone
  // been printing it. FAILED must appear in the line, not a silent boolean.
  assert.equal(
    formatNativeWindowFrameDiagnostic({
      state: "applied",
      borderSuppressed: true,
      borderHresult: 0,
      captionSuppressed: false,
      captionHresult: -2_147_024_809,
      groundApplied: false,
      systemBackdropType: 3,
    }),
    "[native-window-frame] probe=ran;border=ok(hresult=0x00000000);caption=FAILED(hresult=0x80070057)",
  );
  assert.equal(
    formatNativeWindowFrameDiagnostic({
      state: "undetermined",
      borderSuppressed: false,
      borderHresult: null,
      captionSuppressed: false,
      captionHresult: null,
      groundApplied: false,
      systemBackdropType: null,
    }),
    "[native-window-frame] probe=ran;border=not-attempted;caption=not-attempted",
  );
});
