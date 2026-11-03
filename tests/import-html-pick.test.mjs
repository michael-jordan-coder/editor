import assert from "node:assert/strict";
import test from "node:test";
import { pick } from "../client/features/import-html.js";

test("pick keeps white-space:nowrap for buttons and labels", () => {
  const kept = pick({ whiteSpace: "nowrap", color: "rgb(0, 0, 0)" }, [
    "whiteSpace",
    "color",
  ]);
  assert.equal(kept.whiteSpace, "nowrap");
});

test("pick still drops the white-space default (normal)", () => {
  const kept = pick({ whiteSpace: "normal" }, ["whiteSpace"]);
  assert.equal(kept.whiteSpace, undefined);
});

test("pick still drops flex-wrap:nowrap as a flex default via NONE + DEFAULTS path", () => {
  // flexWrap default is nowrap; FLEX_PROPS use the same pick helper.
  const kept = pick({ flexWrap: "nowrap", justifyContent: "center" }, [
    "flexWrap",
    "justifyContent",
  ]);
  assert.equal(kept.flexWrap, undefined);
  assert.equal(kept.justifyContent, "center");
});
