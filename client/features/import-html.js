// Paste HTML: turns a snippet or a document into nodes of the store, so the rest of the editor
// (layers, inspector, undo, export) treats it like anything drawn here.
//
// The HTML is laid out once in a hidden iframe and read back through getComputedStyle, so the
// result looks like the page at the chosen width. What comes out is the flattened result: class
// rules, media queries and pseudo states become inline styles of one width. Scripts do not run.
// The file's tokens are defined in that iframe, so var(--color-brand) lays out as its value, and an
// inline style that wrote a var() keeps it, so the node stays bound to the token.
import { tokenVariables } from "../core/tokens.js";

const SKIP = new Set(["SCRIPT", "STYLE", "META", "LINK", "TITLE", "HEAD", "NOSCRIPT", "TEMPLATE", "BR"]);
const LOOKS_LIKE_HTML = /<\s*(!doctype|html|body|div|section|main|header|footer|nav|ul|ol|p|h[1-6]|span|a|button|img|form|table|article|aside|style)\b[^>]*>/i;

export const looksLikeHtml = (text) => LOOKS_LIKE_HTML.test(text ?? "");

// A value is kept only when it differs from what an unstyled element would have.
// "nowrap" is intentionally absent: white-space:nowrap is not the CSS default
// (normal is), and agents rely on it so buttons/nav labels stay on one line.
const NONE = new Set(["", "none", "normal", "auto", "0px", "0", "rgba(0, 0, 0, 0)", "static", "visible", "start", "baseline", "stretch", "row", "repeat", "0% 0%", "auto auto"]);
const DEFAULTS = { opacity: "1", flexShrink: "1", flexBasis: "auto", flexWrap: "nowrap", minWidth: "0px", minHeight: "0px", maxWidth: "none", maxHeight: "none", textDecorationLine: "none", textTransform: "none", whiteSpace: "normal", transform: "none" };
export const pick = (cs, names) => Object.fromEntries(names.map((n) => [n, cs[n]]).filter(([n, v]) => v != null && !NONE.has(v) && v !== DEFAULTS[n]));


const TEXT_PROPS = ["color", "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "textAlign", "textTransform", "textDecorationLine", "whiteSpace"];
const BOX_PROPS = ["padding", "margin", "borderRadius", "boxShadow", "opacity", "overflow", "backgroundImage", "backgroundSize", "backgroundPosition", "backgroundRepeat", "minWidth", "minHeight", "maxWidth", "maxHeight", "flexGrow", "flexShrink", "flexBasis", "alignSelf", "zIndex", "transform"];
const FLEX_PROPS = ["justifyContent", "alignItems", "flexWrap", "rowGap", "columnGap"];

function borders(cs) {
  const sides = ["Top", "Right", "Bottom", "Left"].map((s) => ({ s, w: cs[`border${s}Width`], st: cs[`border${s}Style`], c: cs[`border${s}Color`] }));
  const visible = sides.filter((b) => b.st !== "none" && b.st !== "hidden" && parseFloat(b.w) > 0);
  if (!visible.length) return {};
  const same = visible.length === 4 && visible.every((b) => b.w === visible[0].w && b.st === visible[0].st && b.c === visible[0].c);
  if (same) return { border: `${visible[0].w} ${visible[0].st} ${visible[0].c}` };
  return Object.fromEntries(visible.map((b) => [`border${b.s}`, `${b.w} ${b.st} ${b.c}`]));
}

const hasBackground = (cs) => cs.backgroundColor !== "rgba(0, 0, 0, 0)" || cs.backgroundImage !== "none";
const hasBox = (cs) => hasBackground(cs) || Object.keys(borders(cs)).length > 0;
const isInline = (el, win) => win.getComputedStyle(el).display.startsWith("inline") && el.tagName !== "IMG";
// Inline pieces that merge into their parent's text: no box and no margin of their own.
const isPlainInline = (el, win) => {
  const cs = win.getComputedStyle(el);
  return isInline(el, win) && !hasBox(cs) && cs.margin === "0px" && cs.padding === "0px" && !el.querySelector("img");
};
const clean = (s) => s.replace(/\s+/g, " ").trim();

// Properties the element's own style attribute wrote as var(...): those stay as written instead of the computed value.
const VAR_PROPS = { background: ["background-color", "background"], color: ["color"], borderRadius: ["border-radius"], fontFamily: ["font-family"], fontSize: ["font-size"], fontWeight: ["font-weight"], lineHeight: ["line-height"], letterSpacing: ["letter-spacing"], padding: ["padding"], gap: ["gap"], rowGap: ["row-gap", "gap"], columnGap: ["column-gap", "gap"] };
function keepVars(el, style) {
  for (const [prop, sources] of Object.entries(VAR_PROPS)) {
    const written = sources.map((s) => el.style.getPropertyValue(s)).find((v) => v.includes("var("));
    if (written && prop in style) style[prop] = written.trim();
  }
  // A border written with a var() color: the computed width and style, the written color.
  const borderColor = /var\(--[\w-]+\)/.exec(el.style.getPropertyValue("border-color") || el.style.getPropertyValue("border"))?.[0];
  if (borderColor && style.border) style.border = style.border.replace(/\s(?!.*\s).*$/, ` ${borderColor}`).replace(/^(\S+ \S+).*$/, `$1 ${borderColor}`);
  return style;
}

function layout(el, cs, win, parentCs) {
  const style = pick(cs, BOX_PROPS);
  const background = cs.backgroundColor !== "rgba(0, 0, 0, 0)" ? { background: cs.backgroundColor } : {};
  Object.assign(style, background, borders(cs));
  if (cs.position !== "static") {
    Object.assign(style, { position: cs.position }, pick(cs, ["top", "right", "bottom", "left"]));
  }
  // A flex row or grid cannot stretch its items along the row, so the used width is pinned.
  const inRow = parentCs && ((parentCs.display.includes("flex") && parentCs.flexDirection.startsWith("row")) || parentCs.display.includes("grid"));
  if (inRow && cs.position === "static") style.width = cs.width;
  // An inline-level box in block flow keeps its own width and follows the parent's text-align.
  if (parentCs && cs.display.startsWith("inline") && !parentCs.display.includes("flex") && !parentCs.display.includes("grid")) {
    style.alignSelf = { center: "center", right: "flex-end", end: "flex-end" }[parentCs.textAlign] ?? "flex-start";
  }
  return style;
}

function containerLayout(el, cs, win) {
  if (cs.display.includes("grid")) return { display: "grid", gridTemplateColumns: cs.gridTemplateColumns, gridTemplateRows: cs.gridTemplateRows, ...pick(cs, ["rowGap", "columnGap", "justifyContent", "alignItems"]) };
  if (cs.display.includes("flex")) return { display: "flex", flexDirection: cs.flexDirection, ...pick(cs, FLEX_PROPS) };
  const kids = [...el.children].filter((c) => !SKIP.has(c.tagName));
  // Block children stack; inline-level children sit side by side and wrap.
  if (kids.length && kids.every((c) => isInline(c, win))) return { display: "flex", flexDirection: "row", flexWrap: "wrap", alignItems: "center" };
  return { display: "flex", flexDirection: "column" };
}

// Converts one element into node descriptions with their children: [{ node, children }].
function convert(el, win, parentCs) {
  if (SKIP.has(el.tagName)) return [];
  const cs = win.getComputedStyle(el);
  if (cs.display === "none") return [];
  const name = el.getAttribute("layer-name") || el.id || (typeof el.className === "string" && el.className.split(/\s+/)[0]) || el.tagName.toLowerCase();

  if (el.tagName === "IMG") {
    const rect = el.getBoundingClientRect();
    const style = { ...layout(el, cs, win, parentCs), width: `${Math.round(rect.width)}px`, height: `${Math.round(rect.height)}px`, backgroundImage: `url("${el.currentSrc || el.src}")`, backgroundSize: "cover", backgroundPosition: "center" };
    return [{ node: { component: "Rectangle", name: el.alt || name, style }, children: [] }];
  }

  const kids = [...el.childNodes];
  const elementKids = kids.filter((k) => k.nodeType === 1 && !SKIP.has(k.tagName));
  const textOnly = elementKids.every((k) => isPlainInline(k, win));
  const text = clean(el.textContent ?? "");

  if (textOnly && text) {
    const type = pick(cs, TEXT_PROPS);
    const style = keepVars(el, { ...type, ...layout(el, cs, win, parentCs) });
    if (style.textDecorationLine) { style.textDecoration = style.textDecorationLine; delete style.textDecorationLine; }
    const component = hasBox(cs) ? "Rectangle" : "Text";
    if (component === "Rectangle") Object.assign(style, { display: "flex", alignItems: "center", justifyContent: cs.textAlign === "center" ? "center" : "flex-start" });
    return [{ node: { component, name: text.slice(0, 40), text, style }, children: [] }];
  }

  const children = kids.flatMap((k) => {
    if (k.nodeType === 1) return convert(k, win, cs);
    const t = k.nodeType === 3 ? clean(k.textContent) : "";
    return t ? [{ node: { component: "Text", name: t.slice(0, 40), text: t, style: pick(cs, TEXT_PROPS) }, children: [] }] : [];
  });
  if (!children.length && !hasBox(cs)) return [];
  const style = keepVars(el, { ...containerLayout(el, cs, win), ...layout(el, cs, win, parentCs) });
  return [{ node: { component: "Frame", name, style }, children }];
}

async function layOut(html, width, tokens = []) {
  const frame = document.createElement("iframe");
  // No allow-scripts: pasted scripts and handlers stay inert. allow-same-origin is only for reading styles.
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.style.cssText = `position:fixed;left:-99999px;top:0;width:${width}px;height:900px;border:0;visibility:hidden`;
  document.body.append(frame);
  const vars = Object.entries(tokenVariables(tokens)).map(([name, value]) => `${name}:${value}`).join(";");
  const theme = vars ? `<style>:root{${vars}}</style>` : "";
  const whole = /<\s*(!doctype|html|body)\b/i.test(html);
  const slot = /<head\b[^>]*>|<html\b[^>]*>|<!doctype\b[^>]*>/i; // the first of these that is there is where the theme goes
  const doc = !whole ? `<!doctype html><meta charset="utf-8">${theme}<body>${html}</body>` : slot.test(html) ? html.replace(slot, (m) => `${m}${theme}`) : theme + html;
  await new Promise((resolve) => { frame.onload = resolve; frame.srcdoc = doc; });
  await frame.contentDocument.fonts?.ready;
  return frame;
}

// Builds the frame from the pasted HTML and inserts it as one undo step. Returns its id.
export async function pasteHtml(store, view, html, { width = 1440 } = {}) {
  const frame = await layOut(html, width, store.tokens());
  try {
    const win = frame.contentWindow;
    const body = frame.contentDocument.body;
    const bodyCs = win.getComputedStyle(body);
    const rootBg = hasBackground(bodyCs) ? bodyCs : win.getComputedStyle(frame.contentDocument.documentElement);
    const children = [...body.childNodes].flatMap((k) => (k.nodeType === 1 ? convert(k, win, bodyCs) : []));
    if (!children.length) return null;

    const root = {
      component: "Frame",
      name: clean(frame.contentDocument.title) || "Pasted HTML",
      style: {
        ...containerLayout(body, bodyCs, win), width: `${width}px`, padding: bodyCs.margin,
        background: rootBg.backgroundColor !== "rgba(0, 0, 0, 0)" ? rootBg.backgroundColor : "#ffffff",
        ...pick(bodyCs, TEXT_PROPS.slice(0, 2)),
      },
    };
    const right = store.roots().reduce((edge, n) => Math.max(edge, (n.x ?? 0) + (parseFloat(n.style?.width) || 0)), 0);
    let rootId;
    store.transact("Paste HTML", () => {
      const insert = ({ node, children: kids }, parent) => {
        const id = store.insert(node, { parent });
        kids.forEach((k) => insert(k, id));
        return id;
      };
      rootId = store.insert({ ...root, x: right ? right + 80 : 0, y: 0 });
      children.forEach((c) => insert(c, rootId));
    });
    store.select(rootId);
    view.zoomToSelection();
    return rootId;
  } finally {
    frame.remove();
  }
}

/**
 * write_html for an agent: the HTML becomes nodes inside a node, or in
 * its place. Returns the IDs of the new top-level nodes.
 */
export async function writeHtml(store, html, { targetId, mode = "insert-children" }) {
  const target = store.get(targetId);
  if (!target) throw new Error(`There is no node ${targetId}`);
  if (mode === "insert-children" && target.component !== "Frame") throw new Error(`${target.name} is ${target.component === "Text" ? "text" : `a ${target.component}`} and cannot have children; insert into a frame, or use mode "replace"`);
  const frame = await layOut(html, parseFloat(target.style?.width) || 1440, store.tokens());
  try {
    const win = frame.contentWindow;
    const body = frame.contentDocument.body;
    const bodyCs = win.getComputedStyle(body);
    const trees = [...body.childNodes].flatMap((k) => (k.nodeType === 1 ? convert(k, win, bodyCs) : k.nodeType === 3 && clean(k.textContent) ? [{ node: { component: "Text", name: clean(k.textContent).slice(0, 40), text: clean(k.textContent), style: pick(bodyCs, TEXT_PROPS) }, children: [] }] : []));
    if (!trees.length) throw new Error("Nothing in that HTML could be imported");
    const made = [];
    store.transact(mode === "replace" ? "Replace with HTML" : "Write HTML", () => {
      const insert = (tree, parent, index, extra = {}) => {
        const id = store.insert({ ...tree.node, ...extra }, { parent, index });
        tree.children.forEach((c) => insert(c, id));
        return id;
      };
      if (mode === "replace") {
        const siblings = store.children(target.parent);
        const index = siblings.indexOf(target);
        const where = target.parent == null ? { x: target.x ?? 0, y: target.y ?? 0, page: target.page } : {};
        trees.forEach((tree, i) => made.push(insert(tree, target.parent, target.parent == null ? undefined : index + i, target.parent == null ? { ...where, x: where.x + i * 40, y: where.y + i * 40 } : {})));
        store.remove(target.id);
      } else {
        trees.forEach((tree) => made.push(insert(tree, target.id)));
      }
    });
    return made;
  } finally {
    frame.remove();
  }
}
