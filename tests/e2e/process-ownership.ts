export type ObservedProcessStart = Readonly<{
  name: "claude.exe" | "codex.exe" | "electron.exe";
  pid: number;
  parentPid: number;
  role?: "catalog" | "preflight" | "runtime" | "unclassified";
}>;

export type ProcessOwnership = Readonly<{
  ownedPids: ReadonlySet<number>;
  foreignPids: ReadonlySet<number>;
}>;

export function classifyObservedProcesses(
  events: readonly ObservedProcessStart[],
  applicationPid: number,
): ProcessOwnership {
  const ownedElectronPids = new Set([applicationPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const event of events) {
      if (
        event.name === "electron.exe" &&
        ownedElectronPids.has(event.parentPid) &&
        !ownedElectronPids.has(event.pid)
      ) {
        ownedElectronPids.add(event.pid);
        changed = true;
      }
    }
  }
  const ownedPids = new Set(ownedElectronPids);
  for (const event of events) {
    if (
      event.name !== "electron.exe" &&
      ownedElectronPids.has(event.parentPid)
    ) {
      ownedPids.add(event.pid);
    }
  }
  return Object.freeze({
    ownedPids,
    foreignPids: new Set(
      events
        .filter((event) => !ownedPids.has(event.pid))
        .map((event) => event.pid),
    ),
  });
}
