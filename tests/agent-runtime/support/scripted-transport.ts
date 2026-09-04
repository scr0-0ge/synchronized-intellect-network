import { readFile } from "node:fs/promises";

import type { OfficialRuntimeTransport } from "../../../src/agent-runtime/codex/transport.ts";

export class ScriptedTransport implements OfficialRuntimeTransport {
  private readonly lines: string[];
  private readonly stopFailure: string | undefined;
  private readonly outboundJsonl: string[] = [];
  private stopCalls = 0;

  constructor(lines: readonly string[], stopFailure?: string) {
    this.lines = [...lines];
    this.stopFailure = stopFailure;
  }

  static async fromFixture(fixtureUrl: URL, stopFailure?: string): Promise<ScriptedTransport> {
    const contents = await readFile(fixtureUrl, "utf8");
    return new ScriptedTransport(contents.split(/\r?\n/u).filter(Boolean), stopFailure);
  }

  async send(line: string): Promise<void> {
    this.outboundJsonl.push(line);
  }

  recordedOutboundJsonl(): readonly string[] {
    return [...this.outboundJsonl];
  }

  recordedStopCalls(): number {
    return this.stopCalls;
  }

  async receive(): Promise<string | null> {
    return this.lines.shift() ?? null;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.stopFailure) throw new Error(this.stopFailure);
  }
}
