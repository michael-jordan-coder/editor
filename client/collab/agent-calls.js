// What an agent's MCP calls do. The tool list lives in server/mcp/tools.mjs; the server forwards each call here,
// to the page that has the file open, because that is where the document is. An edit made here goes through the
// store like any other: one undo step, saved, and seen by everyone who has the file open. What a call returns is
// plain data (pictures as { images }, a PDF as { documents }; the server turns it into MCP content).
import { jsxOf, nodePng } from "../features/export.js";
import { parseColor } from "../core/style-values.js";
import { writeHtml } from "../features/import-html.js";
import { makePdf } from "../features/pdf.js";
import { TOKEN_TYPES, cssName, slug, tokensToCss, typeInfo } from "../core/tokens.js";
import { repoFetch } from "../features/github.js";

const PICTURE_LIMIT = 1568; // pixels on the longest side of a picture handed to an agent
const MAX_FOUND = 200;
const NAME_LIMIT = 50;

const to2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const camelCase = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const isNumber = (v) => Number.isFinite(parseFloat(v));
const isEmpty = (v) => v === null || v === undefined || v === "";

/** A pattern where `*` stands for anything, matched against a whole string, ignoring case. */
function glob(pattern) {
  const literal = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${literal.join(".*")}$`, "i");
}

function toBase64(bytes) {
  const pieces = [];
  for (let i = 0; i < bytes.length; i += 0x8000) pieces.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return btoa(pieces.join(""));
}

function closeColors(a, b) {
  const [x, y] = [parseColor(a), parseColor(b)];
  if (!x || !y) return false;
  return ["r", "g", "b"].every((k) => Math.abs(x[k] - y[k]) < 0.005) && Math.abs((x.a ?? 1) - (y.a ?? 1)) < 0.005;
}

// ---------- Pictures ----------
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

async function bitmapCanvas(blob, { scale = 1, backdrop } = {}) {
  const bitmap = await createImageBitmap(blob);
  const surface = document.createElement("canvas");
  surface.width = Math.max(1, Math.round(bitmap.width * scale));
  surface.height = Math.max(1, Math.round(bitmap.height * scale));
  const pen = surface.getContext("2d");
  if (backdrop) { pen.fillStyle = backdrop; pen.fillRect(0, 0, surface.width, surface.height); }
  pen.drawImage(bitmap, 0, 0, surface.width, surface.height);
  return surface;
}

const encodeCanvas = (surface, mime, quality = 0.92) =>
  new Promise((resolve, reject) => surface.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The picture could not be made"))), mime, quality));

const blobToBase64 = async (blob) => toBase64(new Uint8Array(await blob.arrayBuffer()));

/**
 * Everything a tool needs to look at the document, gathered once per open file: finding nodes and pages,
 * measuring what is drawn, and taking pictures of it. `ctx.agent` is whoever's call is running.
 */
function openContext({ store, canvas, fileId, fileName, repo = () => null, user, announce }) {
  const ctx = {
    store, canvas, fileId, fileName, repo, user,
    agent: "Agent",
    touched: new Set(), // artboards the running call changed
    tell: (info) => announce({ name: ctx.agent, ...info }),
  };

  ctx.node = (id) => {
    const found = store.get(String(id));
    if (!found) throw new Error(`There is no node ${id}`);
    return found;
  };
  ctx.markChanged = (id) => ctx.touched.add(store.rootOf(id));

  ctx.pages = () => store.pages();
  ctx.pageLabel = (id) => ctx.pages().find((p) => p.id === id)?.label;
  ctx.pageOf = (n) => store.get(store.rootOf(n.id))?.page;
  ctx.requirePage = (id) => {
    if (id === undefined) return store.activePage();
    if (!ctx.pages().some((p) => p.id === id)) throw new Error(`There is no page ${id}`);
    return id;
  };
  ctx.artboardsOn = (page) => store.all().filter((n) => n.parent == null && n.page === page);

  const elementOf = (id) => canvas.querySelector(`[data-node-id="${CSS.escape(id)}"]`);

  // Size and place on the canvas, from what is drawn. Nothing is drawn for a page nobody is looking at.
  ctx.measure = (n) => {
    const el = elementOf(n.id);
    if (!el) return { width: null, height: null, worldX: null, worldY: null };
    const { zoom, panX, panY } = store.ui;
    const sheet = canvas.getBoundingClientRect(), box = el.getBoundingClientRect();
    return {
      width: to2(box.width / zoom), height: to2(box.height / zoom),
      worldX: to2((box.left - sheet.left - panX) / zoom), worldY: to2((box.top - sheet.top - panY) / zoom),
    };
  };
  const offsetInParent = (n) => {
    if (n.parent == null) return { x: n.x ?? 0, y: n.y ?? 0 };
    const own = elementOf(n.id), outer = elementOf(n.parent);
    if (!own || !outer) return { x: null, y: null };
    const [a, b] = [own.getBoundingClientRect(), outer.getBoundingClientRect()];
    return { x: to2((a.left - b.left) / store.ui.zoom), y: to2((a.top - b.top) / store.ui.zoom) };
  };
  ctx.describe = (n) => ({
    id: n.id, name: n.name, component: n.component, parentId: n.parent, artboardId: store.rootOf(n.id), pageId: ctx.pageOf(n),
    childIds: store.children(n.id).map((c) => c.id), hidden: Boolean(n.hidden), locked: Boolean(n.locked),
    ...(n.text != null ? { textContent: n.text } : {}), ...offsetInParent(n), ...ctx.measure(n),
  });

  // A node can only be drawn while its page is showing: show it for the length of the work, then give the page back.
  ctx.whileShown = async (n, work) => {
    const wanted = ctx.pageOf(n), before = store.activePage();
    if (!wanted || wanted === before) return work();
    store.setPage(wanted);
    try { return await work(); } finally { store.setPage(before); }
  };

  ctx.picture = (n, { scale = 1, format = "png" } = {}) => ctx.whileShown(n, async () => {
    const el = elementOf(n.id);
    if (!el) throw new Error("That node is not on the canvas");
    const longest = Math.max(el.offsetWidth, el.offsetHeight, 1);
    const used = Math.max(0.1, Math.min(scale, PICTURE_LIMIT / longest));
    const png = await nodePng(n, used);
    const mime = Object.hasOwn(MIME, format) ? MIME[format] : MIME.png;
    const blob = mime === MIME.png ? png : await encodeCanvas(await bitmapCanvas(png, { backdrop: "#ffffff" }), mime);
    return { data: await blobToBase64(blob), mimeType: mime, width: el.offsetWidth, height: el.offsetHeight, scale: used };
  });

  return ctx;
}

// ---------- Looking things up ----------
function styleValueMatches(store, value, wanted) {
  const text = String(value);
  const tokenRef = /^(?:var\()?(--[\w-]+)\)?$/.exec(wanted.trim());
  if (tokenRef) return text.includes(`var(${tokenRef[1]})`);
  // A literal value also finds whatever uses a token that holds it.
  const used = /var\((--[\w-]+)\)/.exec(text)?.[1];
  const held = used ? store.tokens().find((t) => cssName(t) === used)?.value : undefined;
  if (held !== undefined && (held === wanted || closeColors(held, wanted))) return true;
  if (wanted.includes("*")) return glob(wanted).test(text);
  return text.toLowerCase() === wanted.toLowerCase() || closeColors(text, wanted);
}

/** What a node matches of a search, or null when it does not satisfy all of it. */
function matchSearch(store, n, { filters = [], textValue }) {
  const hits = [];
  for (const { styleName, styleValue } of filters) {
    const nameTest = styleName ? glob(camelCase(styleName)) : null;
    const hit = Object.entries(n.style).find(([key, value]) => (!nameTest || nameTest.test(key)) && (styleValue === undefined || styleValueMatches(store, value, styleValue)));
    if (!hit) return null;
    hits.push({ styleName: hit[0], styleValue: String(hit[1]) });
  }
  if (textValue !== undefined) {
    if (n.text == null || !glob(textValue).test(n.text)) return null;
    hits.push({ textValue: n.text });
  }
  return hits.length ? hits : null;
}

// ---------- Reading ----------
function readingTools(ctx) {
  const { store } = ctx;
  const fontsInUse = () => [...new Set(store.all().map((n) => n.style?.fontFamily).filter(Boolean).map((f) => f.split(",")[0].replace(/["']/g, "").trim()))];

  return {
    get_basic_info({ pageId }) {
      const page = ctx.requirePage(pageId);
      const artboards = ctx.artboardsOn(page);
      return {
        file: { id: ctx.fileId, name: ctx.fileName() },
        repo: ctx.repo(),
        pages: ctx.pages().map((p) => ({ id: p.id, name: p.label, type: "page", isActive: p.id === store.activePage() })),
        page: { id: page, name: ctx.pageLabel(page) },
        nodeCount: artboards.reduce((total, n) => total + store.subtree(n.id).length, 0),
        artboards: artboards.map((n) => ({
          id: n.id, name: n.name,
          width: parseFloat(n.style.width) || ctx.measure(n).width, height: parseFloat(n.style.height) || ctx.measure(n).height,
          worldX: n.x ?? 0, worldY: n.y ?? 0,
        })),
        fonts: fontsInUse(),
        tokens: store.tokens().map((t) => ({ name: cssName(t), type: t.type, value: t.value })),
      };
    },
    get_selection: () => ({ selection: store.selectedNodes().map(ctx.describe) }),
    get_node_info: ({ nodeId }) => ctx.describe(ctx.node(nodeId)),
    get_children: ({ nodeId }) => ({ children: store.children(ctx.node(nodeId).id).map((c) => ({ ...ctx.describe(c), childCount: store.children(c.id).length })) }),

    get_tree_summary({ nodeId, depth = 3 }) {
      const levels = Math.min(10, Math.max(1, Number(depth) || 3));
      const lines = [];
      const outline = (n, level) => {
        const { width, height } = ctx.measure(n);
        const kids = store.children(n.id);
        const cut = level + 1 >= levels && kids.length;
        lines.push(`${"  ".repeat(level)}${n.component} "${n.name}" (${n.id}) ${width ?? "?"}x${height ?? "?"}${cut ? ` [${kids.length} children]` : ""}`);
        if (!cut) kids.forEach((k) => outline(k, level + 1));
      };
      outline(ctx.node(nodeId), 0);
      return lines.join("\n");
    },

    find_nodes({ nodeId, pageId, filters, textValue }) {
      if (!filters?.length && textValue === undefined) throw new Error("Pass filters, textValue, or both");
      const pool = nodeId ? store.subtree(ctx.node(nodeId).id)
        : pageId ? store.all().filter((n) => ctx.pageOf(n) === ctx.requirePage(pageId))
        : store.all();
      const found = [];
      for (const n of pool) {
        const matched = matchSearch(store, n, { filters, textValue });
        if (matched) found.push({ id: n.id, name: n.name, component: n.component, pageId: ctx.pageOf(n), matched });
      }
      return { count: found.length, results: found.slice(0, MAX_FOUND), ...(found.length > MAX_FOUND ? { truncated: true } : {}) };
    },

    get_computed_styles({ nodeIds }) {
      const styles = {};
      for (const id of nodeIds) {
        const n = ctx.node(id), { width, height } = ctx.measure(n);
        styles[n.id] = { ...n.style, ...(width != null ? { width: `${width}px`, height: `${height}px` } : {}) };
      }
      return styles;
    },

    get_jsx: ({ nodeId, format, includeNodeIds, includeRootPositioning }) =>
      jsxOf(store, ctx.node(nodeId), { format, includeNodeIds: includeNodeIds ?? true, includeRootPositioning: includeRootPositioning ?? false }),

    async get_screenshot({ nodeId, scale = 1 }) {
      const shot = await ctx.picture(ctx.node(nodeId), { scale });
      return { images: [{ data: shot.data, mimeType: shot.mimeType }], text: { nodeId, width: shot.width, height: shot.height, scale: to2(shot.scale) } };
    },

    async get_fill_image({ nodeId }) {
      const n = ctx.node(nodeId);
      const url = /url\(["']?([^"')]+)["']?\)/.exec(n.style.backgroundImage ?? n.style.background ?? "")?.[1];
      if (!url) return { text: "This node has no image fill." };
      if (/\.svg(\?|$)/i.test(url)) return { text: "This image is an SVG: read it with get_jsx." };
      const response = await fetch(url);
      if (!response.ok) throw new Error(`The image could not be read (${response.status})`);
      const source = await response.blob();
      const { width, height } = await createImageBitmap(source);
      const scale = Math.min(1, PICTURE_LIMIT / Math.max(width, height));
      const small = await encodeCanvas(await bitmapCanvas(source, { scale, backdrop: "#ffffff" }), MIME.jpg, 0.85);
      return { images: [{ data: await blobToBase64(small), mimeType: MIME.jpg }], text: { url, width, height } };
    },

    async get_font_family_info({ familyNames }) {
      const pen = document.createElement("canvas").getContext("2d");
      const widthOf = (font) => { pen.font = font; return pen.measureText("mmmmmmmmmmlli0Oo").width; };
      // A web font is only fetched once something uses it, so ask for it before measuring.
      await Promise.all(familyNames.map((family) => document.fonts.load(`16px "${family}"`).catch(() => {})));
      const fonts = familyNames.map((family) => {
        // Text set in an installed font is a different width than in either fallback.
        const generic = /^(system-ui|ui-monospace|serif|sans-serif|monospace)$/i.test(family);
        const available = generic || widthOf(`72px "${family}", monospace`) !== widthOf("72px monospace") || widthOf(`72px "${family}", serif`) !== widthOf("72px serif");
        return { family, available, ...(available ? {} : { note: "Not installed on this machine, so text set in it falls back to another font." }) };
      });
      return { fonts };
    },
  };
}

// ---------- Editing ----------
// Style keys an agent sends may be kebab-case; an empty value removes the style.
function styleChanges(ctx, n, styles) {
  const changes = {};
  for (const [key, value] of Object.entries(styles)) {
    const name = camelCase(key);
    // An artboard's place on the canvas is x/y, not left/top.
    if (n.parent == null && (name === "left" || name === "top")) {
      if (!isEmpty(value) && isNumber(value)) ctx.store.update(n.id, { [name === "left" ? "x" : "y"]: parseFloat(value) });
      continue;
    }
    // This editor keeps a fill color in `background`, unless the fill is a picture.
    const field = name === "backgroundColor" && !n.style.backgroundImage ? "background" : name;
    changes[field] = isEmpty(value) ? undefined : value;
  }
  return changes;
}

const textOfHtml = (html) => {
  const withBreaks = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p[^>]*>/gi, "\n\n");
  return new DOMParser().parseFromString(`<body>${withBreaks}</body>`, "text/html").body.textContent;
};

function requireFrame(parent) {
  if (parent && parent.component !== "Frame") throw new Error(`${parent.name} cannot have children`);
}

function placeBeside(ctx, n, move) {
  const { store } = ctx;
  const sibling = ctx.node(move.before ?? move.after);
  if (sibling.id === n.id) throw new Error("A node cannot be placed beside itself");
  const others = store.children(sibling.parent).filter((c) => c.id !== n.id);
  return { parent: sibling.parent, index: others.findIndex((c) => c.id === sibling.id) + (move.after !== undefined ? 1 : 0) };
}

function placeUnder(ctx, n, move) {
  const parent = move.parentId === "root" ? null : ctx.node(move.parentId).id;
  const room = ctx.store.children(parent).filter((c) => c.id !== n.id).length;
  return { parent, index: move.index === undefined ? room : Math.max(0, Math.min(room, move.index)) };
}

function editingTools(ctx) {
  const { store } = ctx;
  const abbreviate = (name) => String(name).slice(0, NAME_LIMIT);

  return {
    async write_html({ html, targetNodeId, mode, source }) {
      const ids = await writeHtml(store, html, { targetId: String(targetNodeId), mode, source });
      ids.forEach(ctx.markChanged);
      return { createdNodeIds: ids, nodeCount: ids.reduce((total, id) => total + store.subtree(id).length, 0) };
    },

    update_styles({ updates }) {
      store.transact("Update styles", () => {
        for (const { nodeIds, styles } of updates) {
          for (const id of nodeIds) {
            const n = ctx.node(id);
            const changes = styleChanges(ctx, n, styles);
            if (Object.keys(changes).length) store.updateStyle(n.id, changes);
            ctx.markChanged(n.id);
          }
        }
      });
      return { updated: updates.flatMap((u) => u.nodeIds), ignoredStyles: [] };
    },

    set_text_content({ updates }) {
      store.transact("Set text", () => {
        for (const { nodeId, html } of updates) {
          const n = ctx.node(nodeId);
          if (n.text == null) throw new Error(`${n.name} (${n.id}) is not a Text node`);
          store.update(n.id, { text: textOfHtml(html) });
          ctx.markChanged(n.id);
        }
      });
      return { updated: updates.map((u) => u.nodeId) };
    },

    rename_nodes({ updates }) {
      store.transact("Rename layers", () => {
        for (const { nodeId, name } of updates) {
          const n = ctx.node(nodeId);
          store.update(n.id, { name: abbreviate(name) });
          ctx.markChanged(n.id);
        }
      });
      return { renamed: updates.map((u) => u.nodeId) };
    },

    delete_nodes({ nodeIds }) {
      const doomed = nodeIds.map((id) => ctx.node(id));
      store.transact("Delete nodes", () => store.remove(doomed.map((n) => n.id)));
      return { deleted: nodeIds };
    },

    duplicate_nodes({ nodes }) {
      const duplicated = [];
      store.transact("Duplicate nodes", () => {
        for (const { id, parentId } of nodes) {
          const source = ctx.node(id);
          const [copyId] = store.duplicate([source.id]);
          // Both subtrees come out in the same order, so they pair up node for node.
          const [originals, copies] = [store.subtree(source.id), store.subtree(copyId)];
          if (parentId !== undefined && parentId !== source.parent) {
            const parent = parentId === "root" ? null : ctx.node(parentId);
            requireFrame(parent);
            store.move(copyId, { parent: parent?.id ?? null });
          }
          ctx.markChanged(copyId);
          duplicated.push({ sourceId: source.id, newId: copyId, descendantIdMap: Object.fromEntries(originals.map((o, i) => [o.id, copies[i].id])) });
        }
      });
      return { duplicated };
    },

    move_nodes({ moves }) {
      const moved = [], affected = new Set();
      store.transact("Move nodes", () => {
        for (const move of moves) {
          const n = ctx.node(move.nodeId);
          const oldParent = n.parent;
          const beside = move.before !== undefined || move.after !== undefined;
          const { parent, index } = beside ? placeBeside(ctx, n, move) : placeUnder(ctx, n, move);
          requireFrame(parent === null ? null : store.get(parent));
          if (parent === n.id || store.ancestors(parent ?? "").includes(n.id)) throw new Error("A node cannot be moved under itself");
          const page = ctx.pageOf(n);
          store.move(n.id, { parent, index });
          if (parent == null) store.update(n.id, { page });
          moved.push({ nodeId: n.id, parentId: parent ?? "root", index });
          affected.add(oldParent ?? "root").add(parent ?? "root");
          ctx.markChanged(n.id);
        }
      });
      const childIdsOf = (id) => (id === "root" ? ctx.artboardsOn(store.activePage()) : store.children(id)).map((c) => c.id);
      return { moves: moved, affectedParents: [...affected].map((id) => ({ id, childIds: childIdsOf(id) })) };
    },

    create_artboard({ name, styles, pageId }) {
      const page = ctx.requirePage(pageId);
      const { left, top, ...style } = styles;
      if (!isNumber(style.width) || !isNumber(style.height)) throw new Error("width and height are needed, in pixels");
      // Without a place given, it goes 80px right of the last artboard.
      const edge = ctx.artboardsOn(page).reduce((far, n) => Math.max(far, (n.x ?? 0) + (parseFloat(n.style.width) || 0)), 0);
      let id;
      store.transact("Create artboard", () => {
        id = store.insert({
          component: "Frame", name: abbreviate(name), page,
          x: left !== undefined ? parseFloat(left) : edge ? edge + 80 : 0, y: top !== undefined ? parseFloat(top) : 0,
          style: { display: "flex", flexDirection: "column", background: "#ffffff", ...style },
        });
      });
      ctx.touched.add(id);
      return { id, name, pageId: page };
    },

    create_page({ name }) {
      let id;
      store.transact("Add page", () => {
        id = store.addPage({ activate: false });
        if (name?.trim()) store.renamePage(id, name);
      });
      return { pageId: id, name: ctx.pageLabel(id) };
    },

    update_pages({ updates }) {
      store.transact("Rename pages", () => {
        for (const { pageId, name } of updates) {
          ctx.requirePage(pageId);
          if (name) store.renamePage(pageId, name);
        }
      });
      return { pages: ctx.pages().map((p) => ({ id: p.id, name: p.label })) };
    },

    finish_working_on_nodes({ nodeIds }) {
      ctx.tell({ working: false, nodeIds: nodeIds ?? [] });
      return "Released.";
    },
  };
}

// ---------- The connected repo ----------
const MAX_REPO_PATHS = 300;
const MAX_REPO_TEXT = 40 * 1024;
function repoTools(ctx) {
  let tree = null; // { repo, files }: the file list is fetched once per repo
  const requireRepo = () => {
    const repo = ctx.repo();
    if (!repo) throw new Error("No repo is connected to this file. Connect one in the Theme tab.");
    return repo;
  };
  return {
    async list_repo_files({ path = "" } = {}) {
      const repo = requireRepo();
      if (tree?.repo !== repo) tree = { repo, files: (await repoFetch(repo)).files };
      const folder = String(path).replace(/^\/+|\/+$/g, "");
      const files = tree.files.filter((f) => !folder || f.startsWith(`${folder}/`));
      return { repo, path: folder, files: files.slice(0, MAX_REPO_PATHS), truncated: files.length > MAX_REPO_PATHS };
    },
    async read_repo_file({ path }) {
      const { text, truncated } = await repoFetch(requireRepo(), String(path));
      return { path, text: text.slice(0, MAX_REPO_TEXT), truncated: truncated || text.length > MAX_REPO_TEXT };
    },
  };
}

// ---------- Tokens ----------
function tokenTools(ctx) {
  const { store } = ctx;
  const byName = (name) => store.tokens().find((t) => cssName(t) === name);
  // "--color-brand-dark" is the color token named "brand dark".
  const displayName = (cssNameGiven, type) => {
    const prefix = `--${typeInfo(type).prefix}-`;
    if (!cssNameGiven.startsWith(prefix) || cssNameGiven.length === prefix.length) throw new Error(`A ${type} token's name starts with ${prefix}`);
    return cssNameGiven.slice(prefix.length).replace(/-+/g, " ");
  };
  const valueText = (type, value) => (type === "opacity" && typeof value === "string" && value.trim().endsWith("%") ? String(parseFloat(value) / 100) : String(value));
  const nameOf = (id) => cssName(store.tokens().find((t) => t.id === id));
  const failure = (name, error) => ({ name, result: "error", message: error.message });

  return {
    get_tokens({ format = "json", types, namePattern }) {
      const wanted = namePattern ? glob(namePattern) : null;
      const tokens = store.tokens().filter((t) => (!types || types.includes(t.type)) && (!wanted || wanted.test(cssName(t))));
      if (format === "json") return { tokens: tokens.map((t) => ({ name: cssName(t), type: t.type, value: t.value })) };
      return tokensToCss(tokens, format === "tailwind" ? "tailwind" : "css");
    },

    create_tokens({ tokens }) {
      const results = [];
      store.transact("Create tokens", () => {
        for (const { type, name, value } of tokens) {
          try {
            if (!TOKEN_TYPES.some((known) => known.type === type)) throw new Error(`Unknown token type ${type}`);
            const label = displayName(name, type);
            if (byName(name)) throw new Error(`${name} already exists`);
            const id = store.createToken(type);
            store.updateToken(id, { name: label, value: valueText(type, value) });
            results.push({ name: nameOf(id), result: "created" });
          } catch (error) { results.push(failure(name, error)); }
        }
      });
      return results;
    },

    set_tokens({ tokens }) {
      const results = [];
      store.transact("Update tokens", () => {
        for (const change of tokens) {
          const token = byName(change.name);
          if (!token) { results.push(failure(change.name, new Error(`There is no token ${change.name}`))); continue; }
          try {
            if (change.delete) {
              store.deleteTokens(token.id);
              results.push({ name: change.name, result: "deleted" });
              continue;
            }
            if (change.newName) store.updateToken(token.id, { name: displayName(change.newName, token.type) });
            if (change.value !== undefined) store.updateToken(token.id, { value: valueText(token.type, change.value) });
            results.push({ name: change.name, result: "updated", ...(change.newName ? { newName: nameOf(token.id) } : {}) });
          } catch (error) { results.push(failure(change.name, error)); }
        }
      });
      return results;
    },
  };
}

// ---------- Comments ----------
const isoTime = (ms) => new Date(ms).toISOString();

function commentTools(ctx) {
  const { store } = ctx;
  const userId = (id) => (id === "current-user" ? ctx.user.id : id);
  const thread = (id) => {
    const found = store.threads().find((t) => t.id === id);
    if (!found) throw new Error(`There is no comment thread ${id}`);
    return found;
  };
  const brief = (t, previewLength = 240) => {
    const [first] = t.messages, last = t.messages.at(-1);
    return {
      commentThreadId: t.id, pageId: t.page, status: t.resolved ? "resolved" : "open", position: { x: t.x, y: t.y },
      authorUserId: first.author.id, authorName: first.author.name, preview: first.text.slice(0, previewLength),
      messageCount: t.messages.length, createdAt: isoTime(first.at), updatedAt: isoTime(last.at),
    };
  };

  return {
    list_comment_threads({ status = "open", pageId, currentPageOnly, search, threadAuthorUserId, participantUserId, limit = 50, offset = 0, previewLength = 240 }) {
      const page = pageId ?? (currentPageOnly ? store.activePage() : undefined);
      const needle = search?.toLowerCase();
      const found = store.threads().filter((t) =>
        (status === "all" || (status === "resolved") === Boolean(t.resolved))
        && (page === undefined || t.page === page)
        && (!threadAuthorUserId || t.messages[0].author.id === userId(threadAuthorUserId))
        && (!participantUserId || t.messages.some((m) => m.author.id === userId(participantUserId)))
        && (!needle || t.messages.some((m) => `${m.author.name} ${m.text}`.toLowerCase().includes(needle))));
      const start = Math.max(0, offset);
      return { total: found.length, threads: found.slice(start, start + Math.min(200, Math.max(1, limit))).map((t) => brief(t, previewLength)) };
    },

    get_comment_thread({ commentThreadId }) {
      const t = thread(commentThreadId);
      const messages = t.messages.map((m) => ({
        id: m.id, authorUserId: m.author.id, authorName: m.author.name, text: m.text, createdAt: isoTime(m.at), mentions: m.mentions ?? [],
        attachments: (m.attachments ?? []).map((a) => ({ name: a.name, url: new URL(a.url, location.origin).href })),
      }));
      return { ...brief(t, 1000), messages };
    },

    set_comment_thread_status({ commentThreadId, status }) {
      if (!store.setThreadStatus(commentThreadId, status)) throw new Error(`There is no comment thread ${commentThreadId}, or this file is read-only`);
      return { commentThreadId, status };
    },

    list_comment_thread_authors({ pageId }) {
      const people = new Map();
      for (const t of store.threads()) {
        if (pageId !== undefined && t.page !== pageId) continue;
        t.messages.forEach((m, i) => {
          const person = people.get(m.author.id) ?? { userId: m.author.id, name: m.author.name, threadsStarted: 0, messages: 0, lastActivityAt: 0 };
          person.threadsStarted += i === 0 ? 1 : 0;
          person.messages++;
          person.lastActivityAt = Math.max(person.lastActivityAt, m.at);
          people.set(m.author.id, person);
        });
      }
      return { authors: [...people.values()].map((p) => ({ ...p, lastActivityAt: isoTime(p.lastActivityAt) })) };
    },
  };
}

// ---------- Export ----------
function exportTools(ctx) {
  return {
    async export({ nodes, pageId }) {
      if (pageId !== undefined) ctx.requirePage(pageId);
      const images = [], text = [];
      for (const item of nodes) {
        const request = typeof item === "string" ? { nodeId: item } : item;
        const n = ctx.node(request.nodeId ?? request.id);
        const shot = await ctx.picture(n, { scale: request.scale ?? 1, format: request.format ?? "png" });
        images.push({ data: shot.data, mimeType: shot.mimeType });
        text.push({ nodeId: n.id, name: n.name, format: shot.mimeType.split("/")[1], width: shot.width, height: shot.height, scale: to2(shot.scale) });
      }
      return { images, text };
    },

    async export_combined_pdf({ nodeIds }) {
      // Sheets go top to bottom, then left to right.
      const corner = (n) => {
        const { worldX, worldY } = ctx.measure(n);
        return n.parent == null ? { x: n.x ?? 0, y: n.y ?? 0 } : { x: worldX ?? 0, y: worldY ?? 0 };
      };
      const ordered = nodeIds.map((id) => ctx.node(id)).sort((a, b) => corner(a).y - corner(b).y || corner(a).x - corner(b).x);
      const sheets = [];
      for (const n of ordered) {
        const shot = await ctx.picture(n, { scale: 2, format: "jpg" });
        const jpeg = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
        const { width, height } = await createImageBitmap(new Blob([jpeg], { type: MIME.jpg }));
        sheets.push({ width: shot.width, height: shot.height, jpeg, pixelWidth: width, pixelHeight: height });
      }
      const pdf = makePdf(sheets);
      return {
        documents: [{ uri: `editor://export/${slug(ctx.fileName())}.pdf`, mimeType: "application/pdf", data: toBase64(pdf) }],
        text: { pages: ordered.map((n) => ({ nodeId: n.id, name: n.name })), bytes: pdf.length },
      };
    },
  };
}

/** The calls an agent can make on the open file. `call(method, args, agent)` runs one; `agent` names who is asking. */
export function createMcpHandlers(setup) {
  const ctx = openContext(setup);
  const tools = { ...readingTools(ctx), ...editingTools(ctx), ...tokenTools(ctx), ...repoTools(ctx), ...commentTools(ctx), ...exportTools(ctx) };

  // One call at a time, so agents working together (the panel's and any over MCP) never mix up changes or announcements.
  let queue = Promise.resolve();

  return function call(method, args = {}, agent = "Agent") {
    const turn = async () => {
      const tool = tools[method];
      if (!tool) throw new Error(`The editor does not do ${method}`);
      if (args.fileId && args.fileId !== ctx.fileId) throw new Error(`This page has ${ctx.fileId} open, not ${args.fileId}`);
      ctx.agent = agent;
      ctx.touched.clear();
      const answer = await tool(args);
      if (ctx.touched.size) ctx.tell({ working: true, nodeIds: [...ctx.touched] });
      return answer;
    };
    const result = queue.then(turn, turn);
    queue = result.catch(() => {});
    return result;
  };
}
