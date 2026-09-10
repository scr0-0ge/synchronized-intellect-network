import assert from "node:assert/strict";
import test from "node:test";

import { copyLocaleDictionaries } from "../../src/workbench-shell/renderer/copy/session-metadata-copy.ts";

test("recovery-required archive copy requires an unknown-outcome acknowledgement without offering Delete", () => {
  const english = copyLocaleDictionaries.en.sessionMetadataCopy;
  const chinese = copyLocaleDictionaries["zh-CN"].sessionMetadataCopy;

  for (const copy of [english.recoveryArchiveTitle, english.blockUnknownFeedback]) {
    assert.match(copy, /confirm/iu);
    assert.match(copy, /final turn outcome.*unknown/iu);
    assert.match(copy, /Recovery required/u);
    assert.doesNotMatch(copy, /Delete/u);
  }
  for (const copy of [chinese.recoveryArchiveTitle, chinese.blockUnknownFeedback]) {
    assert.match(copy, /确认/u);
    assert.match(copy, /最终结果.*未知/u);
    assert.match(copy, /需要恢复/u);
    assert.doesNotMatch(copy, /删除/u);
  }
});
