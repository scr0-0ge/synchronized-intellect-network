export interface OfficialRuntimeTransport {
  send(line: string): Promise<void>;
  receive(): Promise<string | null>;
  stop(): Promise<void>;
}

/**
 * Per-launch facts the adapter can hand its transport factory. `extraArguments`
 * carries session-scoped CLI overrides (the Workbench MCP `-c` lines) that must
 * precede `app-server --stdio`; absent, the launch is exactly the historical
 * one. Factories written before the bridge simply ignore the argument.
 */
export interface OfficialRuntimeLaunchContext {
  readonly extraArguments?: readonly string[];
}

/** Zero-argument factories (the historical shape) stay first-class. */
export type OfficialRuntimeTransportFactory =
  | (() => Promise<OfficialRuntimeTransport>)
  | ((launch?: OfficialRuntimeLaunchContext) => Promise<OfficialRuntimeTransport>);
