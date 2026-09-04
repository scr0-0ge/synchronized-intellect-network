import type { ElectronApplication, Locator, Page } from "playwright";

export interface RectSnapshot {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface LayoutSnapshot {
  readonly rail: RectSnapshot | null;
  readonly stage: RectSnapshot | null;
}

export async function setViewport(
  application: ElectronApplication,
  width: number,
  height: number,
): Promise<void> {
  await application.evaluate(
    ({ BrowserWindow }, dimensions) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("production-window-missing");
      window.setContentSize(dimensions.width, dimensions.height);
    },
    { width, height },
  );
}

export async function layoutState(page: Page): Promise<LayoutSnapshot> {
  return page.evaluate(() => {
    const rect = (selector: string): RectSnapshot | null => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) {
        return null;
      }
      const value = element.getBoundingClientRect();
      return {
        left: value.left,
        top: value.top,
        width: value.width,
        height: value.height,
      };
    };
    return { rail: rect(".rail"), stage: rect(".stage") };
  });
}

export function sameLayout(before: LayoutSnapshot, after: LayoutSnapshot): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

export async function allInsideViewport(...locators: Locator[]): Promise<boolean> {
  for (const locator of locators) {
    if (
      !(await locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left >= 0 &&
          rect.top >= 0 &&
          rect.right <= window.innerWidth &&
          rect.bottom <= window.innerHeight
        );
      }))
    ) {
      return false;
    }
  }
  return true;
}

export async function centerHits(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return hit !== null && (hit === element || element.contains(hit));
  });
}
