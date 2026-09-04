export type ProcessEnvironmentPatch = Readonly<
  Record<string, string | undefined>
>;

// package.json pins process isolation because these scopes restore globals only
// within the current test-file process; they are not a cross-file lock.

export async function withProcessEnvironment<T>(
  patch: ProcessEnvironmentPatch,
  run: () => Promise<T> | T,
): Promise<T> {
  const previous = new Map(
    Object.keys(patch).map((key) => [key, process.env[key]] as const),
  );

  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function withWorkingDirectory<T>(
  directory: string,
  run: () => Promise<T> | T,
): Promise<T> {
  const previous = process.cwd();
  try {
    process.chdir(directory);
    return await run();
  } finally {
    process.chdir(previous);
  }
}
