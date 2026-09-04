import { resolve } from "node:path";

import {
  type ResumableAgentRuntimeAdapter,
  RuntimeAdapterError,
  type RuntimeResume,
  type RuntimeStart,
} from "../../agent-runtime/index.ts";

export function createPackagedBootstrapRuntimeAdapter(options: {
  readonly bootstrapProjectDirectory: string;
  readonly delegate: ResumableAgentRuntimeAdapter;
}): ResumableAgentRuntimeAdapter {
  const bootstrapProjectDirectory = resolve(options.bootstrapProjectDirectory);
  const isBootstrapProject = (projectDirectory: string): boolean =>
    sameDirectory(projectDirectory, bootstrapProjectDirectory);
  const rejectBootstrapProject = (projectDirectory: string): void => {
    if (isBootstrapProject(projectDirectory)) {
      throw new RuntimeAdapterError("runtime-unavailable");
    }
  };

  return Object.freeze({
    async inspect(projectDirectory: string) {
      rejectBootstrapProject(projectDirectory);
      return await options.delegate.inspect(projectDirectory);
    },
    async start(request: RuntimeStart) {
      rejectBootstrapProject(request.projectDirectory);
      return await options.delegate.start(request);
    },
    async resume(request: RuntimeResume) {
      rejectBootstrapProject(request.projectDirectory);
      return await options.delegate.resume(request);
    },
  });
}

function sameDirectory(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLocaleLowerCase("en-US") ===
        resolvedRight.toLocaleLowerCase("en-US")
    : resolvedLeft === resolvedRight;
}
