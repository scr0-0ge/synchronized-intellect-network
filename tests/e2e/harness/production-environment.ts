export function productionEnvironment(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(source).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" &&
          entry[0] !== "ELECTRON_RUN_AS_NODE" &&
          !/^UAW_E2E_/u.test(entry[0]),
      ),
    ),
  );
}
