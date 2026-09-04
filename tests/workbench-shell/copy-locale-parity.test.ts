import assert from "node:assert/strict";
import test from "node:test";

import {
  chromeCopy,
  copyLocaleDictionaries as chromeCopyDictionaries,
} from "../../src/workbench-shell/renderer/copy/chrome-copy.ts";
import {
  commonCopy,
  copyLocaleDictionaries as commonCopyDictionaries,
} from "../../src/workbench-shell/renderer/copy/common-copy.ts";
import {
  copyLocaleDictionaries as composerCopyDictionaries,
  draftPreservedCountCopy,
  endpointControlNameCopy,
} from "../../src/workbench-shell/renderer/copy/composer-copy.ts";
import {
  copyLocaleDictionaries as dialogsCopyDictionaries,
  dialogsCopy,
} from "../../src/workbench-shell/renderer/copy/dialogs-copy.ts";
import { copyLocaleDictionaries as dynamicCopyDictionaries } from "../../src/workbench-shell/renderer/copy/dynamic-copy.ts";
import { copyLocaleDictionaries as inspectorCopyDictionaries } from "../../src/workbench-shell/renderer/copy/inspector-copy.ts";
import { copyLocaleDictionaries as historyRecoveryCopyDictionaries } from "../../src/workbench-shell/renderer/copy/history-recovery-copy.ts";
import { copyLocaleDictionaries as projectHistoryCopyDictionaries } from "../../src/workbench-shell/renderer/copy/project-history-copy.ts";
import {
  copyLocaleDictionaries as shellCopyDictionaries,
  shellCopy,
} from "../../src/workbench-shell/renderer/copy/shell-copy.ts";
import { copyLocaleDictionaries as sessionStatusCopyDictionaries } from "../../src/workbench-shell/renderer/copy/session-status-copy.ts";
import {
  copyLocaleDictionaries as settingsCopyDictionaries,
  settingsCopy,
} from "../../src/workbench-shell/renderer/copy/settings-copy.ts";
import { copyLocaleDictionaries as sessionMetadataCopyDictionaries } from "../../src/workbench-shell/renderer/copy/session-metadata-copy.ts";
import { copyLocaleDictionaries as removalCopyDictionaries } from "../../src/workbench-shell/renderer/copy/removal-copy.ts";
import {
  copyLocaleDictionaries as runtimeProfileCopyDictionaries,
  runtimeProfileCopy,
} from "../../src/workbench-shell/renderer/copy/runtime-profile-copy.ts";
import { copyLocaleDictionaries as railCopyDictionaries } from "../../src/workbench-shell/renderer/copy/rail-copy.ts";
import { copyLocaleDictionaries as turnNotificationCopyDictionaries } from "../../src/workbench-shell/renderer/copy/turn-notification-copy.ts";
import { copyLocaleDictionaries as stageCopyDictionaries } from "../../src/workbench-shell/renderer/copy/stage-copy.ts";
import {
  copyLocaleDictionaries as transcriptCopyDictionaries,
  transcriptSearchCountCopy,
} from "../../src/workbench-shell/renderer/copy/transcript-copy.ts";
import { setLocale } from "../../src/workbench-shell/renderer/locale.ts";

type LocaleDictionaries = Readonly<{
  en: unknown;
  "zh-CN": unknown;
}>;

function dictionaryKeyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [];
  return Object.keys(value)
    .sort()
    .flatMap((key) => {
      const path = prefix.length === 0 ? key : `${prefix}.${key}`;
      return [
        path,
        ...dictionaryKeyPaths((value as Record<string, unknown>)[key], path),
      ];
    });
}

const domains: Readonly<Record<string, LocaleDictionaries>> = Object.freeze({
  chrome: chromeCopyDictionaries,
  common: commonCopyDictionaries,
  composer: composerCopyDictionaries,
  dialogs: dialogsCopyDictionaries,
  dynamic: dynamicCopyDictionaries,
  inspector: inspectorCopyDictionaries,
  "history-recovery": historyRecoveryCopyDictionaries,
  "project-history": projectHistoryCopyDictionaries,
  shell: shellCopyDictionaries,
  removal: removalCopyDictionaries,
  "runtime-profile": runtimeProfileCopyDictionaries,
  rail: railCopyDictionaries,
  "session-metadata": sessionMetadataCopyDictionaries,
  "session-status": sessionStatusCopyDictionaries,
  settings: settingsCopyDictionaries,
  "turn-notification": turnNotificationCopyDictionaries,
  stage: stageCopyDictionaries,
  transcript: transcriptCopyDictionaries,
});

test("every renderer copy domain keeps identical en and zh-CN dictionary keys", () => {
  for (const [domain, dictionaries] of Object.entries(domains)) {
    assert.deepEqual(
      dictionaryKeyPaths(dictionaries["zh-CN"]),
      dictionaryKeyPaths(dictionaries.en),
      `${domain} copy keys drifted between en and zh-CN`,
    );
  }
});

test("English copy stays byte-exact and zh-CN selection is immediate", () => {
  setLocale("en");
  assert.deepEqual(
    [
      commonCopy.createProject,
      chromeCopy.credentialsNote,
      endpointControlNameCopy(undefined),
      draftPreservedCountCopy(12),
      dialogsCopy.confirmRemovalKicker,
      shellCopy.loadingBody,
      runtimeProfileCopy.fixedExecutionModeLabel,
      settingsCopy.readCatalogs,
      transcriptSearchCountCopy(2, 5),
      settingsCopy.persistenceErrorSentence,
    ],
    [
      "Create Project…",
      "Workbench never handles credentials",
      "Endpoint: Choose endpoint",
      "Draft preserved · 12 characters",
      "Confirm removal",
      "Preparing the selected Project and its durable Agent Sessions.",
      "Single agent",
      "Read catalogs",
      "2 of 5 turns",
      "The current appearance remains active in this window, but this change is not durable. Try another appearance change to retry.",
    ],
  );

  try {
    setLocale("zh-CN");
    assert.deepEqual(
      [
        commonCopy.createProject,
        endpointControlNameCopy(undefined),
        runtimeProfileCopy.fixedExecutionModeLabel,
        settingsCopy.title,
        transcriptSearchCountCopy(2, 5),
      ],
      [
        "创建项目…",
        "端点：选择端点",
        "单智能体",
        "设置",
        "显示 2 / 5 个回合",
      ],
    );
  } finally {
    setLocale("en");
  }
});

/*
 * The product name is the one string a person reads before anything else, and
 * until this test it was the least guarded string in the tree: `appTitle` and
 * `loadingKicker` were asserted nowhere, in either locale, so the 2026-09-03
 * rename could have been half-reverted by a later edit without a single test
 * going red. The Chinese rendering is guarded for the same reason and by the
 * same values a native reader sees.
 *
 * This does NOT pin the domain vocabulary. `failureKicker` is deliberately
 * still "Workbench shell" / "Workbench 界面": CONTEXT.md keeps Workbench as the
 * domain noun and the brand is a label on top of it, so the two live side by
 * side on adjacent screens on purpose.
 */
test("the product name a person reads is Synchronized Intellect Network, in both locales", () => {
  setLocale("en");
  assert.deepEqual(
    [shellCopy.appTitle, shellCopy.loadingKicker, shellCopy.failureKicker],
    ["Synchronized Intellect Network", "Synchronized Intellect Network", "Workbench shell"],
  );

  try {
    setLocale("zh-CN");
    assert.deepEqual(
      [shellCopy.appTitle, shellCopy.loadingKicker, shellCopy.failureKicker],
      ["同步智能网络", "同步智能网络", "Workbench 界面"],
    );
  } finally {
    setLocale("en");
  }
});

test("no renderer copy string, in either locale, still carries the old product name", () => {
  const retired = ["Unified Agent Workbench", "统一智能体工作台"];
  const offenders: string[] = [];

  function walk(domain: string, locale: string, value: unknown, path: string): void {
    if (typeof value === "string") {
      for (const name of retired) {
        if (value.includes(name)) offenders.push(`${domain}.${locale}.${path}: ${value}`);
      }
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(domain, locale, child, path.length === 0 ? key : `${path}.${key}`);
    }
  }

  for (const [domain, dictionaries] of Object.entries(domains)) {
    walk(domain, "en", dictionaries.en, "");
    walk(domain, "zh-CN", dictionaries["zh-CN"], "");
  }

  assert.deepEqual(offenders, [], "a copy string still names the retired product");
});
