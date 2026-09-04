export interface OfficialRuntimeTransport {
  send(line: string): Promise<void>;
  receive(): Promise<string | null>;
  stop(): Promise<void>;
}

export type OfficialRuntimeTransportFactory = () => Promise<OfficialRuntimeTransport>;
