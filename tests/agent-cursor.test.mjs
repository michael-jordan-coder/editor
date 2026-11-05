import test from "node:test";
import assert from "node:assert/strict";
const { mountAgentCursor } = await import("../client/collab/agent-cursor.js");

test("agent cursors keep easing, aim at layer centers, and vary their paths by name", async () => {
  const names = ["performance", "requestAnimationFrame", "CSS", "Node", "document"];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  try {
    const frames = [];
    let now = 0;
    globalThis.performance = { now: () => now };
    globalThis.requestAnimationFrame = (fn) => frames.push(fn);
    globalThis.CSS = { escape: (value) => value };
    globalThis.Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
    const makeElement = (rect = {}) => {
      const element = {
        dataset: {}, classList: { add() {}, remove() {} }, children: [],
        append(child) { this.children.push(child); child.parentElement = this; },
        querySelector(selector) { return selector === "span" ? (this.label ??= { textContent: "" }) : null; },
        querySelectorAll() { return []; },
        getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100, ...rect }; },
      };
      Object.defineProperty(element, "style", {
        configurable: true,
        get() { return this._style ??= {}; },
        set(value) { this._style = typeof value === "string" ? { cssText: value } : value; },
      });
      return element;
    };
    globalThis.document = { createElement: () => makeElement() };

    const target = makeElement({ left: 600, top: 500, width: 1000, height: 1000 });
    const canvas = makeElement();
    canvas.querySelector = () => target;
    const store = { ui: { zoom: 1, panX: 0, panY: 0 }, subscribe() {} };
    const cursor = mountAgentCursor(canvas, store);

    const adaDone = cursor.aim("Ada", { nodeId: "target" });
    const graceDone = cursor.aim("Grace", { nodeId: "target" });
    const [adaPointer, gracePointer] = canvas.children[0].children;
    const position = (pointer) => ({ x: Number.parseFloat(pointer.style.left), y: Number.parseFloat(pointer.style.top) });
    const adaStart = position(adaPointer), graceStart = position(gracePointer);
    assert.deepEqual(adaStart, graceStart, "both agents should start from the same point");

    // Sample the progress along the line before the arc's perpendicular offset affects it.
    for (let i = 0; i < 2; i++) {
      now += 50;
      for (const frame of frames.splice(0)) frame(now);
    }
    const adaQuarter = position(adaPointer);
    const dx = 1100 - adaStart.x, dy = 1000 - adaStart.y;
    const progress = ((adaQuarter.x - adaStart.x) * dx + (adaQuarter.y - adaStart.y) * dy) / (dx * dx + dy * dy);
    assert.ok(progress < 0.2, `the first quarter should retain the slow ease-in (got ${progress})`);

    // Advance both animations at the same timestamps and sample their actual mid-flight positions.
    for (let i = 0; i < 2; i++) {
      now += 50;
      for (const frame of frames.splice(0)) frame(now);
    }
    const adaMid = position(adaPointer), graceMid = position(gracePointer);
    assert.notDeepEqual(adaMid, graceMid, "agent names should produce distinct mid-flight paths");

    for (let i = 0; i < 30 && frames.length; i++) {
      now += 50;
      for (const frame of frames.splice(0)) frame(now);
    }
    await Promise.all([adaDone, graceDone]);
    assert.deepEqual(position(adaPointer), { x: 1100, y: 1000 }, "Ada should finish at the layer center");
    assert.deepEqual(position(gracePointer), { x: 1100, y: 1000 }, "Grace should finish at the layer center");
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
