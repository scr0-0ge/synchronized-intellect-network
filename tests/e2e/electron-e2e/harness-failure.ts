const harnessFailureInstances = new WeakSet<object>();

export class HarnessFailure extends Error {
  readonly code: string;
  readonly safeMessage: string;

  constructor(code: string, safeMessage: string) {
    super(code);
    this.code = code;
    this.safeMessage = safeMessage;
    harnessFailureInstances.add(this);
  }
}

export function isHarnessFailure(error: unknown): error is HarnessFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    harnessFailureInstances.has(error)
  );
}
