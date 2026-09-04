import { createSignal } from "solid-js";

export type WorkbenchLocale = "en" | "zh-CN";

export type LocalizedShape<T> = T extends string
  ? string
  : T extends (...arguments_: infer Arguments) => infer Result
    ? (...arguments_: Arguments) => LocalizedShape<Result>
    : T extends readonly unknown[]
      ? { readonly [Key in keyof T]: LocalizedShape<T[Key]> }
      : T extends object
        ? { readonly [Key in keyof T]: LocalizedShape<T[Key]> }
        : T;

export type CopyLocaleDictionaries<T extends object> = Readonly<{
  en: T;
  "zh-CN": LocalizedShape<T>;
}>;

const [localeSignal, writeLocaleSignal] = createSignal<WorkbenchLocale>("en");
let activeLocale: WorkbenchLocale = "en";
const localeListeners = new Set<(locale: WorkbenchLocale) => void>();

/** The renderer's current locale signal. */
export const locale = localeSignal;

/** Switches renderer copy immediately. Persistence is owned by appearance preferences. */
export function setLocale(nextLocale: WorkbenchLocale): void {
  if (activeLocale === nextLocale) {
    applyDocumentLocale(nextLocale);
    return;
  }
  activeLocale = nextLocale;
  for (const listener of localeListeners) listener(nextLocale);
  writeLocaleSignal(nextLocale);
  applyDocumentLocale(nextLocale);
}

export const switchLocale = setLocale;

export function isWorkbenchLocale(value: unknown): value is WorkbenchLocale {
  return value === "en" || value === "zh-CN";
}

export function subscribeLocale(
  listener: (locale: WorkbenchLocale) => void,
): () => void {
  localeListeners.add(listener);
  listener(activeLocale);
  return () => localeListeners.delete(listener);
}

export function defineCopyLocaleDictionaries<const English extends object>(
  english: English,
  simplifiedChinese: LocalizedShape<English>,
): CopyLocaleDictionaries<English> {
  return Object.freeze({
    en: deepFreeze(english),
    "zh-CN": deepFreeze(simplifiedChinese),
  }) as CopyLocaleDictionaries<English>;
}

/**
 * Keeps each existing copy-object import stable while resolving every property
 * read against the current locale. Solid tracks the locale signal through the
 * generated getters, so existing JSX property reads update in place.
 */
export function createLocaleCopy<English extends object>(
  dictionaries: CopyLocaleDictionaries<English>,
): English {
  const cache = new Map<string, object>();

  const valueAt = (locale: WorkbenchLocale, path: readonly string[]): unknown =>
    path.reduce<unknown>(
      (value, key) => (value as Record<string, unknown>)[key],
      dictionaries[locale],
    );

  const createNode = (path: readonly string[]): object => {
    const cacheKey = JSON.stringify(path);
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const englishNode = valueAt("en", path);
    if (Array.isArray(englishNode)) {
      const localizedArray = new Proxy([], {
        deleteProperty: () => false,
        defineProperty: () => false,
        get(_target, property, receiver) {
          localeSignal();
          const currentNode = valueAt(activeLocale, path) as readonly unknown[];
          if (typeof property === "string" && /^\d+$/u.test(property)) {
            const index = Number(property);
            const englishValue = englishNode[index];
            return typeof englishValue === "object" && englishValue !== null
              ? createNode([...path, property])
              : currentNode[index];
          }
          return Reflect.get(currentNode, property, receiver);
        },
        getOwnPropertyDescriptor(_target, property) {
          if (property === "length") {
            return Reflect.getOwnPropertyDescriptor([], "length");
          }
          localeSignal();
          const descriptor = Reflect.getOwnPropertyDescriptor(
            valueAt(activeLocale, path) as object,
            property,
          );
          return descriptor === undefined
            ? undefined
            : { ...descriptor, configurable: true };
        },
        has(_target, property) {
          localeSignal();
          return property in (valueAt(activeLocale, path) as object);
        },
        ownKeys() {
          localeSignal();
          return Reflect.ownKeys(valueAt(activeLocale, path) as object);
        },
        set: () => false,
      });
      cache.set(cacheKey, localizedArray);
      return localizedArray;
    }

    const localizedObject = {} as Record<PropertyKey, unknown>;
    cache.set(cacheKey, localizedObject);
    for (const key of Reflect.ownKeys(englishNode as object)) {
      if (typeof key !== "string") continue;
      const englishValue = (englishNode as Record<string, unknown>)[key];
      Object.defineProperty(localizedObject, key, {
        configurable: false,
        enumerable: Object.prototype.propertyIsEnumerable.call(
          englishNode,
          key,
        ),
        get: () =>
          typeof englishValue === "object" && englishValue !== null
            ? createNode([...path, key])
            : (localeSignal(),
              (valueAt(activeLocale, path) as Record<string, unknown>)[key]),
      });
    }
    return Object.freeze(localizedObject);
  };

  return createNode([]) as English;
}

export function currentLocaleCopy<English extends object>(
  dictionaries: CopyLocaleDictionaries<English>,
): LocalizedShape<English> {
  localeSignal();
  return dictionaries[activeLocale] as LocalizedShape<English>;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function applyDocumentLocale(nextLocale: WorkbenchLocale): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = nextLocale;
  }
}
