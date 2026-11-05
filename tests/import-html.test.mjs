import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../client/core/store.js";
import { replaceChildren } from "../client/features/import-html.js";

const frame = (extra = {}) => ({ component: "Frame", name: "Frame", parent: null, page: "page-1", style: {}, ...extra });
const text = (name, value, extra = {}) => ({ component: "Text", name, text: value, style: {}, ...extra });
const tree = (node, children = []) => ({ node, children });

test("replaceChildren removes old children and preserves the root artboard", () => {
  const store = createStore([]);
  let artboard, other;
  store.transact("create", () => {
    artboard = store.insert(frame({ name: "Button", x: 40, y: 80, style: { width: "960px", height: "400px", padding: "32px" }, source: { repo: "o/n", path: "Button.tsx", sha: "old" } }));
    store.insert(text("Old", "old"), { parent: artboard });
    other = store.insert(frame({ name: "Other", x: 1200, y: 0 }));
    store.insert(text("Keep", "keep"), { parent: other });
  });
  const before = structuredClone(store.get(artboard));
  const otherBefore = structuredClone(store.get(other));
  const made = replaceChildren(store, artboard, [tree(text("New", "new"))]);

  assert.equal(made.length, 1);
  assert.deepEqual(store.get(artboard), before);
  assert.deepEqual(store.children(artboard).map((n) => n.text), ["new"]);
  assert.deepEqual(store.get(other), otherBefore);
  assert.deepEqual(store.children(other).map((n) => n.text), ["keep"]);
});

test("replaceChildren rejects non-artboards and leaves the document unchanged", () => {
  const store = createStore([]);
  let child;
  store.transact("create", () => {
    const artboard = store.insert(frame());
    child = store.insert(text("Child", "child"), { parent: artboard });
  });
  const before = structuredClone(store.all());
  assert.throws(() => replaceChildren(store, child, [tree(text("New", "new"))]), /root Frame artboard/);
  assert.deepEqual(store.all(), before);
  assert.throws(() => replaceChildren(store, "missing", [tree(text("New", "new"))]), /There is no node missing/);
  assert.deepEqual(store.all(), before);
});

test("replaceChildren supports undo and redo", () => {
  const store = createStore([]);
  let artboard;
  store.transact("create", () => {
    artboard = store.insert(frame({ name: "Button" }));
    store.insert(text("Old", "old"), { parent: artboard });
  });
  const before = structuredClone(store.all());
  replaceChildren(store, artboard, [tree(text("New", "new"))]);
  const after = structuredClone(store.all());

  store.undo();
  assert.deepEqual(store.all(), before);
  store.redo();
  assert.deepEqual(store.all(), after);
});

test("source metadata is updated only after a successful replacement", () => {
  const store = createStore([]);
  let artboard;
  store.transact("create", () => {
    artboard = store.insert(frame({ source: { repo: "o/n@main", path: "Button.tsx", sha: "old" } }));
  });
  replaceChildren(store, artboard, [tree(text("New", "new"))], { repo: "o/n@main", path: "Button.tsx", sha: "new" });
  assert.deepEqual(store.get(artboard).source, { repo: "o/n@main", path: "Button.tsx", sha: "new" });
  assert.throws(() => replaceChildren(store, artboard, [], { repo: "o/n@main", path: "Button.tsx", sha: "failed" }), /Nothing in that HTML/);
  assert.equal(store.get(artboard).source.sha, "new");
});

test("an empty replacement is rejected before mutation", () => {
  const store = createStore([]);
  let artboard;
  store.transact("create", () => {
    artboard = store.insert(frame());
    store.insert(text("Old", "old"), { parent: artboard });
  });
  const before = structuredClone(store.all());
  assert.throws(() => replaceChildren(store, artboard, []), /Nothing in that HTML/);
  assert.deepEqual(store.all(), before);
});
