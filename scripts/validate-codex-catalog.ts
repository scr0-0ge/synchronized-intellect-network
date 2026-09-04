/**
 * The turn-free real-catalog gate for `F108`/`F110`.
 *
 * `F108` shipped a narrowed production parser that could not read the real
 * Codex catalog, and only the owner noticed — by hand, in the built product.
 * The unit suite could not see it, because the fixtures were edited in the same
 * change as the parser they guard, and fixtures do not grow new vendor fields
 * on their own. `F110` is the same failure mode with the trigger moved into the
 * vendor's hands: the repaired parser still fails closed on any unrecognised
 * `model/list` field, so the next additive vendor change breaks catalog reads
 * again with nothing red to warn us.
 *
 * The only observation that can see either defect is a real catalog read. This
 * performs exactly one, and nothing else: `inspect()` alone, no `thread/start`,
 * no `thread/resume`, no turn. Catalog reads are not inference turns and cost
 * no allowance, so this is free to run as often as it is useful.
 *
 * It deliberately does NOT decide the open `F110` contract question — whether
 * this wire should tolerate additive vendor fields. That trade is the owner's
 * or the Supervisor's, not a Worker's. This gate is useful whichever way it is
 * decided, which is exactly why it is worth having first.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CodexAdapter } from "../src/agent-runtime/codex-adapter.ts";
import type { CodexCatalogObservation } from "../src/agent-runtime/codex-adapter.ts";
import { createOfficialCodexTransport } from "../src/agent-runtime/codex/process-transport.ts";
import { RuntimeAdapterError } from "../src/agent-runtime/index.ts";

const emptyObservation: CodexCatalogObservation = Object.freeze({
  toleratedKeys: Object.freeze([]),
  rejections: Object.freeze([]),
  rejectionsOmitted: 0,
});

export type RealCatalogProbe = Readonly<{
  /**
   * What the parser observed about wire drift, whatever the outcome. `F110`'s
   * live cost was not only the closed gate — it was that nothing named the
   * field, so the owner could not tell a vendor change from a broken install.
   */
  readonly observation: CodexCatalogObservation;
}> &
  (
    | {
        readonly outcome: "catalog-ok";
        readonly modelIds: readonly string[];
      }
    | {
        /**
         * The parser rejected a response the real CLI actually produced. This is
         * the `F108`/`F110` signature and the only outcome that is our defect.
         */
        readonly outcome: "catalog-invalid";
      }
    | {
        /**
         * The runtime could not be reached or the owner is not logged in.
         * Nothing is proven about the parser either way, so this is never a pass
         * and never a failure — it is an absent observation, and it says so.
         */
        readonly outcome: "not-observed";
        readonly category: string;
      }
  );

/**
 * One real, turn-free `model/list` read against the official Codex CLI.
 */
export async function probeRealCodexCatalog(
  projectDirectory: string,
): Promise<RealCatalogProbe> {
  let observation: CodexCatalogObservation = emptyObservation;
  const adapter = new CodexAdapter(
    createOfficialCodexTransport,
    undefined,
    (observed) => {
      observation = observed;
    },
  );
  try {
    const catalog = await adapter.inspect(projectDirectory);
    if (catalog.runtime !== "codex" || catalog.models.length === 0) {
      return Object.freeze({ outcome: "catalog-invalid" as const, observation });
    }
    return Object.freeze({
      outcome: "catalog-ok" as const,
      modelIds: Object.freeze(catalog.models.map((model) => model.id)),
      observation,
    });
  } catch (error) {
    const category =
      error instanceof RuntimeAdapterError ? error.category : "unexpected";
    // `catalog-invalid` is the parser refusing a real response. Every other
    // category — a missing CLI, an expired login, a transport fault — leaves
    // the parser unobserved and must not be reported as either result.
    return category === "catalog-invalid"
      ? Object.freeze({ outcome: "catalog-invalid" as const, observation })
      : Object.freeze({
          outcome: "not-observed" as const,
          category,
          observation,
        });
  }
}

function reportObservation(observation: CodexCatalogObservation): void {
  if (observation.toleratedKeys.length > 0) {
    console.log(
      `CATALOG_DRIFT_TOLERATED keys=${observation.toleratedKeys.join(",")}`,
    );
    console.log(
      "ASSERT these vendor keys are new, admitted as additive, and dropped before the product",
    );
  }
  for (const rejection of observation.rejections) {
    console.log(
      `CATALOG_DRIFT_REJECTED model=${rejection.modelId} ` +
        `added=[${rejection.unknownKeys.join(",")}] ` +
        `removed=[${rejection.missingKeys.join(",")}] ` +
        `invalid=[${rejection.invalidValueKeys.join(",")}]`,
    );
  }
  if (observation.rejectionsOmitted > 0) {
    console.log(
      `CATALOG_DRIFT_REJECTED_OMITTED count=${observation.rejectionsOmitted}`,
    );
  }
}

async function main(): Promise<void> {
  const projectDirectory = resolve(
    fileURLToPath(new URL("..", import.meta.url)),
  );
  const probe = await probeRealCodexCatalog(projectDirectory);
  reportObservation(probe.observation);
  if (probe.outcome === "catalog-ok") {
    console.log(
      `CATALOG_OK models=${probe.modelIds.length} ids=${probe.modelIds.join(",")}`,
    );
    console.log("ASSERT turns=0 provider-inference-requests=0");
    return;
  }
  if (probe.outcome === "catalog-invalid") {
    console.log("CATALOG_FAILED category=catalog-invalid");
    console.log(
      "ASSERT the production parser rejected a response the real CLI produced",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`CATALOG_NOT_OBSERVED category=${probe.category}`);
  console.log("ASSERT nothing was proven about the parser");
  process.exitCode = 2;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
