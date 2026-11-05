import test from "node:test";
import assert from "node:assert/strict";
import { componentAssignments, componentImportPlan, componentsPrompt, sourceIdentity } from "../client/features/github.js";

const artboard = (id, name, source) => ({ id, component: "Frame", parent: null, page: "components", name, source });

test("source identity includes the repository branch consistently", () => {
  assert.equal(sourceIdentity("owner/repository", "main"), "owner/repository@main");
  assert.equal(sourceIdentity("owner/repository@main", "other"), "owner/repository@main");
  assert.equal(sourceIdentity("Owner/Repository", " main "), "owner/repository@main");
});

test("import planning skips unchanged sources and updates changed sources", () => {
  const entries = [
    { path: "src/components/Button.tsx", sha: "same" },
    { path: "src/components/Input.tsx", sha: "new" },
  ];
  const plan = componentImportPlan("owner/repository", "main", entries, [
    artboard("button-id", "Button", { repo: "owner/repository@main", path: "src/components/Button.tsx", sha: "same" }),
    artboard("input-id", "Input", { repo: "owner/repository@main", path: "src/components/Input.tsx", sha: "old" }),
  ], ["Button", "Input"]);
  assert.deepEqual(plan.map(({ action, artboardId }) => ({ action, artboardId })), [
    { action: "skip", artboardId: "button-id" },
    { action: "update", artboardId: "input-id" },
  ]);
});

test("different source paths remain separate even when names match", () => {
  const plan = componentImportPlan("owner/repository", "main", [
    { path: "src/one/Button.tsx", sha: "one" },
    { path: "src/two/Button.tsx", sha: "two" },
  ], [], ["Button"]);
  assert.deepEqual(plan.map((item) => [item.source.path, item.action]), [
    ["src/one/Button.tsx", "create"],
    ["src/two/Button.tsx", "create"],
  ]);
});

test("legacy artboards are updated only when the name match is unambiguous", () => {
  const entries = [{ path: "src/components/Button.tsx", sha: "new" }];
  const unique = componentImportPlan("owner/repository", "main", entries, [artboard("legacy-id", "Button")], ["Button"]);
  assert.equal(unique[0].action, "update");
  assert.equal(unique[0].artboardId, "legacy-id");

  const ambiguous = componentImportPlan("owner/repository", "main", entries, [artboard("a", "Button"), artboard("b", "Button")], ["Button"]);
  assert.equal(ambiguous[0].action, "create");
  assert.equal(ambiguous[0].artboardId, undefined);
});

test("prompt carries each assignment's own action, ID, path, and SHA", () => {
  const prompt = componentsPrompt("owner/repository@main", "components", [
    { name: "Button", action: "update", artboardId: "button-id", source: { repo: "owner/repository@main", path: "Button.tsx", sha: "button-sha" } },
    { name: "Input", action: "create", source: { repo: "owner/repository@main", path: "Input.tsx", sha: "input-sha" } },
  ], 0);
  assert.match(prompt, /button-id/);
  assert.match(prompt, /Button\.tsx/);
  assert.match(prompt, /input-sha/);
  assert.match(prompt, /mode "replace-children"/);
  assert.match(prompt, /mode "insert-children"/);
  assert.match(prompt, /create_artboard with pageId "components"/);
  assert.match(prompt, /Capture its returned id as the targetNodeId/);
  assert.match(prompt, /write_html with that targetNodeId, mode "insert-children"/);
  assert.ok(prompt.indexOf("create_artboard with pageId") < prompt.indexOf("write_html with that targetNodeId"));
  assert.doesNotMatch(prompt, /"path":"Input\.tsx","sha":"button-sha"/);
});

test("assignments exclude skipped entries and distribute every pending item into non-empty groups", () => {
  for (const count of [1, 2, 3, 4, 5]) {
    const pending = Array.from({ length: count }, (_, index) => ({ name: `Item ${index}`, action: "create" }));
    const groups = componentAssignments([{ name: "Skipped", action: "skip" }, ...pending]);
    assert.ok(groups.length > 0);
    assert.ok(groups.length <= 3);
    assert.ok(groups.every((group) => group.length > 0));
    assert.deepEqual(groups.flat(), pending);
    assert.equal(new Set(groups.flat().map((item) => item.name)).size, count);
  }
});

test("assignments return no groups for an empty or all-skipped plan", () => {
  assert.deepEqual(componentAssignments([]), []);
  assert.deepEqual(componentAssignments([{ name: "Skipped", action: "skip" }]), []);
});
