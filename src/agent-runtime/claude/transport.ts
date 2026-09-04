import type { SessionProfile } from "../index.ts";

export interface ClaudeCatalogTransport {
  send(line: string): Promise<void>;
  receive(): Promise<string | null>;
  stop(): Promise<void>;
}

export type ClaudeCatalogTransportFactory = (
  projectDirectory: string,
) => Promise<ClaudeCatalogTransport>;

export type ClaudePermissionMode = "bypassPermissions" | "manual";

export interface ClaudeToolPermissionRequest {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly toolUseId: string;
  readonly agentId?: string;
  readonly blockedPath?: string;
  readonly decisionReason?: string;
  readonly title?: string;
  readonly displayName?: string;
  readonly description?: string;
}

export type ClaudeToolPermissionDecision =
  | Readonly<{ behavior: "allow" }>
  | Readonly<{ behavior: "deny"; message: string }>;

export type ClaudeToolPermissionHandler = (
  request: ClaudeToolPermissionRequest,
) => Promise<ClaudeToolPermissionDecision>;

export interface ClaudeSessionTransportRequest {
  readonly projectDirectory: string;
  readonly profile: SessionProfile;
  readonly permissionMode: ClaudePermissionMode;
  /** Provider identity retained only inside the Claude Adapter/transport. */
  readonly resumeSessionIdentity?: string;
}

export type ClaudeSessionTransportFactory = (
  request: ClaudeSessionTransportRequest,
) => Promise<ClaudeCatalogTransport>;
