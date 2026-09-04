import { resolveProductionElectronComposition } from "../harness/production-electron.ts";

export const productionElectron = resolveProductionElectronComposition(
  new URL("../electron-e2e.ts", import.meta.url).href,
);

export const {
  repositoryRoot,
  electronExecutable,
  rendererUrl: expectedRendererUrl,
} = productionElectron;
