import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { TestContext } from "node:test";

type Cleanup = () => Promise<void> | void;
type CleanupContext = Pick<TestContext, "after">;

interface CleanupState {
  readonly cleanups: Array<() => Promise<void>>;
  readonly closables: Array<() => Promise<void>>;
  readonly directories: Array<() => Promise<void>>;
}

const cleanupStates = new WeakMap<object, CleanupState>();

export function registerTestCleanup(
  context: CleanupContext,
  cleanup: Cleanup,
): () => Promise<void> {
  const registered = onceAsync(cleanup);
  stateFor(context).cleanups.push(registered);
  return registered;
}

export function registerTestClosable(
  context: CleanupContext,
  resource: Readonly<{ close: Cleanup }>,
): () => Promise<void> {
  const registered = onceAsync(() => resource.close());
  stateFor(context).closables.push(registered);
  return registered;
}

export function registerTestDirectory(
  context: CleanupContext,
  directory: string,
): void {
  stateFor(context).directories.push(
    onceAsync(() => removeTestDirectory(directory)),
  );
}

export async function createTestDirectory(
  context: CleanupContext,
  prefix: string,
): Promise<string> {
  const directory = await mkdtemp(prefix);
  registerTestDirectory(context, directory);
  return directory;
}

export async function removeTestDirectory(directory: string): Promise<void> {
  const temporaryRoot = resolve(tmpdir());
  const resolvedDirectory = resolve(directory);
  const relativeDirectory = relative(temporaryRoot, resolvedDirectory);
  if (
    relativeDirectory.length === 0 ||
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${sep}`) ||
    isAbsolute(relativeDirectory)
  ) {
    throw new Error(`refusing-to-remove-non-temporary-test-directory:${resolvedDirectory}`);
  }

  await rm(resolvedDirectory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

function stateFor(context: CleanupContext): CleanupState {
  const existing = cleanupStates.get(context);
  if (existing) return existing;

  const state: CleanupState = { cleanups: [], closables: [], directories: [] };
  cleanupStates.set(context, state);
  context.after(() => runCleanups(state));
  return state;
}

async function runCleanups(state: CleanupState): Promise<void> {
  const errors: unknown[] = [];
  await runInReverse(state.cleanups, errors);
  await runInReverse(state.closables, errors);
  await runInReverse(state.directories, errors);

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Multiple test cleanups failed.");
  }
}

async function runInReverse(
  cleanups: ReadonlyArray<() => Promise<void>>,
  errors: unknown[],
): Promise<void> {
  for (let index = cleanups.length - 1; index >= 0; index -= 1) {
    try {
      await cleanups[index]!();
    } catch (error) {
      errors.push(error);
    }
  }
}

function onceAsync(cleanup: Cleanup): () => Promise<void> {
  let result: Promise<void> | undefined;
  return () => {
    result ??= Promise.resolve().then(cleanup);
    return result;
  };
}
