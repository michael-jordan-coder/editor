import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../client/core/store.js";
import { BOX_PROPS, FLEX_PROPS, TEXT_PROPS, looksLikeHtml, pasteHtml, pick, writeHtml } from "../client/features/import-html.js";

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function parseStyle(attr = "") {
  const map = new Map();
  for (const part of attr.split(";")) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    map.set(part.slice(0, idx).trim().toLowerCase(), part.slice(idx + 1).trim());
  }
  return {
    map,
    getPropertyValue: (prop) => map.get(prop.toLowerCase()) ?? "",
  };
}

function makeElement(tag, attrs = {}, childNodes = []) {
  const tagName = tag.toUpperCase();
  const style = parseStyle(attrs.style);
  const children = childNodes.filter((n) => n.nodeType === 1);
  return {
    nodeType: 1,
    tagName,
    id: attrs.id ?? "",
    className: attrs.class ?? "",
    style,
    childNodes,
    children,
    get textContent() { return childNodes.map((n) => n.textContent ?? "").join(""); },
    getAttribute: (name) => attrs[name] ?? null,
    querySelector: (sel) => {
      const want = sel.toUpperCase();
      for (const c of children) {
        if (c.tagName === want) return c;
        const found = c.querySelector?.(want);
        if (found) return found;
      }
      return null;
    },
  };
}

function parseBodyChildren(html) {
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const inner = bodyMatch ? bodyMatch[1] : html;
  const nodes = [];
  const tagRe = /<([a-z][a-z0-9]*)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let last = 0, m;
  while ((m = tagRe.exec(inner))) {
    if (m.index > last) {
      const text = inner.slice(last, m.index);
      if (text) nodes.push({ nodeType: 3, textContent: text });
    }
    const attrs = {};
    for (const a of m[2].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = a[2] ?? a[3] ?? "";
    const kids = /<[a-z]/i.test(m[3]) ? parseBodyChildren(`<body>${m[3]}</body>`) : m[3] ? [{ nodeType: 3, textContent: m[3] }] : [];
    nodes.push(makeElement(m[1], attrs, kids));
    last = tagRe.lastIndex;
  }
  if (last < inner.length) {
    const rest = inner.slice(last);
    if (rest) nodes.push({ nodeType: 3, textContent: rest });
  }
  return nodes;
}

function computedFor(el) {
  const inline = /^(SPAN|A|BUTTON|LABEL)$/i.test(el.tagName);
  const base = {
    display: el.tagName === "BUTTON" ? "inline-block" : inline ? "inline" : "block",
    position: "static",
    backgroundColor: "rgba(0, 0, 0, 0)",
    backgroundImage: "none",
    borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px",
    borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
    borderTopColor: "rgb(0, 0, 0)", borderRightColor: "rgb(0, 0, 0)", borderBottomColor: "rgb(0, 0, 0)", borderLeftColor: "rgb(0, 0, 0)",
    margin: "0px",
    padding: "0px",
    whiteSpace: "normal",
    flexDirection: "row",
    flexWrap: "nowrap",
    justifyContent: "normal",
    alignItems: "normal",
    rowGap: "normal",
    columnGap: "normal",
    opacity: "1",
    flexShrink: "1",
    flexBasis: "auto",
    minWidth: "0px",
    minHeight: "0px",
    maxWidth: "none",
    maxHeight: "none",
    textDecorationLine: "none",
    textTransform: "none",
    transform: "none",
    textAlign: "start",
    overflow: "visible",
    backgroundRepeat: "repeat",
    backgroundPosition: "0% 0%",
    backgroundSize: "auto auto",
  };
  for (const [k, v] of el.style.map.entries()) {
    base[camel(k)] = v;
    if (k === "background") base.backgroundColor = v;
  }
  return base;
}

function withFakeDom(fn) {
  const prev = globalThis.document;
  globalThis.document = {
    body: { append() {} },
    createElement(tag) {
      assert.equal(tag, "iframe");
      const frame = {
        style: {},
        setAttribute() {},
        remove() {},
        set srcdoc(doc) {
          const kids = parseBodyChildren(doc);
          const body = makeElement("body", {}, kids);
          const htmlEl = makeElement("html", {}, [body]);
          frame.contentDocument = { title: "", body, documentElement: htmlEl, fonts: { ready: Promise.resolve() } };
          frame.contentWindow = { getComputedStyle: (el) => computedFor(el) };
          queueMicrotask(() => frame.onload?.());
        },
      };
      return frame;
    },
  };
  return Promise.resolve().then(fn).finally(() => {
    if (prev === undefined) delete globalThis.document;
    else globalThis.document = prev;
  });
}

test("pick: keeps white-space: nowrap, drops white-space: normal and flex-wrap: nowrap defaults", () => {
  assert.deepEqual(pick({ whiteSpace: "nowrap", color: "rgb(17, 17, 17)" }, TEXT_PROPS), {
    whiteSpace: "nowrap",
    color: "rgb(17, 17, 17)",
  });
  assert.deepEqual(pick({ whiteSpace: "normal", textTransform: "none", textDecorationLine: "none", textAlign: "start" }, TEXT_PROPS), {});
  assert.deepEqual(pick({ flexWrap: "nowrap", justifyContent: "normal", alignItems: "stretch", rowGap: "0px" }, FLEX_PROPS), {});
  assert.deepEqual(pick({ flexWrap: "wrap", columnGap: "12px" }, FLEX_PROPS), { flexWrap: "wrap", columnGap: "12px" });
  assert.deepEqual(pick({
    padding: "0px", margin: "0px", opacity: "1", overflow: "visible", backgroundImage: "none",
    backgroundSize: "auto auto", backgroundPosition: "0% 0%", backgroundRepeat: "repeat",
    minWidth: "0px", minHeight: "0px", maxWidth: "none", maxHeight: "none",
    flexShrink: "1", flexBasis: "auto", alignSelf: "auto", transform: "none",
  }, BOX_PROPS), {});
});

test("writeHtml and pasteHtml: importing a button with white-space: nowrap preserves style.whiteSpace", async () => {
  await withFakeDom(async () => {
    const store = createStore([]);
    let frameId;
    store.transact("init", () => {
      frameId = store.insert({ component: "Frame", name: "Root", x: 0, y: 0, style: { width: "800px", height: "600px" } });
    });

    const [btnId] = await writeHtml(store, '<button style="white-space: nowrap">Click me</button>', { targetId: frameId });
    const btn = store.get(btnId);
    assert.equal(btn.text, "Click me");
    assert.equal(btn.style.whiteSpace, "nowrap");

    const [plainId] = await writeHtml(store, "<button>Plain</button>", { targetId: frameId });
    assert.equal(store.get(plainId).style.whiteSpace, undefined);

    const [navId] = await writeHtml(store, '<nav style="display: flex"><a style="padding: 8px; white-space: nowrap">Pricing</a><a style="padding: 8px; white-space: nowrap">Docs</a></nav>', { targetId: frameId });
    const nav = store.get(navId);
    assert.equal(nav.style.display, "flex");
    assert.equal(nav.style.flexWrap, undefined);
    const links = store.children(navId);
    assert.deepEqual(links.map((l) => [l.text, l.style.whiteSpace]), [["Pricing", "nowrap"], ["Docs", "nowrap"]]);

    let zoomed = false;
    const pastedRoot = await pasteHtml(store, { zoomToSelection: () => { zoomed = true; } }, '<button style="white-space: nowrap">Click me</button>');
    assert.ok(pastedRoot);
    assert.equal(zoomed, true);
    const [pastedBtn] = store.children(pastedRoot);
    assert.equal(pastedBtn.text, "Click me");
    assert.equal(pastedBtn.style.whiteSpace, "nowrap");
  });
  assert.equal(looksLikeHtml('<button style="white-space: nowrap">Click me</button>'), true);
});
