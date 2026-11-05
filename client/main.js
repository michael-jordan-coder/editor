// Starts the editor: loads the file, makes the one store, and mounts each view on its part of the page. This is the
// only file that imports every layer.
import { createStore } from "./core/store.js";
import { mountCanvas } from "./canvas/canvas.js";
import { mountCommands } from "./tools/commands.js";
import { mountLayers } from "./panels/layers.js";
import { mountInspector } from "./panels/inspector/index.js";
import "./kinds/vector.js";
import { PANEL_ICONS } from "./ui/icons/panel.js";
import { mountSidebars } from "./panels/sidebars.js";
import { mountShare } from "./panels/share.js";
import { mountPages } from "./panels/pages.js";
import { mountComments } from "./panels/comments.js";
import { mountSync } from "./collab/sync.js";
import { mountAgentCursor } from "./collab/agent-cursor.js";
import { mountAgent } from "./panels/agent.js";
import { createMcpHandlers } from "./collab/agent-calls.js";
import { mountTheme } from "./panels/theme.js";
import { toast } from "./ui/toast.js";
import { tokenHost } from "./core/tokens.js";
import { COMPONENTS, componentArtboards, componentAssignments, componentImportPlan, componentsPage, componentsPrompt, importRepoTokens } from "./features/github.js";

// The file lives on the server (server/server.mjs): /file/:id is the owner's, /f/:id a visitor's, read-only.
const FILE_ID = location.pathname.match(/^\/file\/([\w-]+)/)?.[1];
const SHARED_ID = location.pathname.match(/^\/f\/([\w-]+)/)?.[1];
const ID_OF_FILE = FILE_ID ?? SHARED_ID;
const SAVE_AFTER_MS = 500; // a save is sent this long after the last edit

// ---------- Opening the file ----------
/** Replaces the page with a message and a way back, and stops. */
function giveUp(message) {
  const page = Object.assign(document.createElement("p"), { style: "padding: 24px; font: 14px system-ui" });
  page.append(`${message} `, Object.assign(document.createElement("a"), { href: "/files", textContent: "Back to files" }));
  document.body.replaceChildren(page);
  throw new Error(message);
}

async function openFile() {
  const response = await fetch(SHARED_ID ? `/api/shared/${SHARED_ID}` : `/api/files/${FILE_ID}`).catch(() => giveUp("The editor's server is not running."));
  if (!response.ok) giveUp((await response.json().catch(() => ({}))).error ?? `Could not open the file (${response.status}).`);
  return response.json();
}

const file = await openFile();
document.title = file.name ?? "Untitled";

// Letters that go into every id this page makes, so two people adding things at once never collide.
const clientTag = [...crypto.getRandomValues(new Uint8Array(4))].map((n) => String.fromCharCode(97 + (n % 26))).join("");
const store = createStore(file.nodes, { clientTag, readOnly: Boolean(SHARED_ID), pages: file.pages, tokens: file.tokens, threads: file.threads });

// ---------- Saving ----------
let sync = null; // live sync (collab/sync.js); while it is working the server gets the edits from it, not from saves
let saveTimer;

const content = () => ({ nodes: store.all(), pages: store.pages(), tokens: store.tokens(), threads: store.threads() });
const put = (patch) => fetch(`/api/files/${FILE_ID}`, { method: "PUT", body: JSON.stringify(patch) })
  .then((response) => response.ok || Promise.reject(new Error(`Save failed (${response.status})`)));

// An image goes to the server and the element holds its URL, so a save never carries the pixels.
async function upload(image) {
  const response = await fetch(`/api/files/${FILE_ID}/assets`, { method: "POST", headers: { "content-type": image.type }, body: image });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `Upload failed (${response.status})`);
  return (await response.json()).url;
}

async function save() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (sync?.mode() === "live") return;
  try {
    await put(content());
    document.title = document.title.replace(/^⚠ /, "");
  } catch (error) {
    console.error(error);
    if (!document.title.startsWith("⚠ ")) document.title = `⚠ ${document.title}`; // the title says it was not saved
  }
}

if (!SHARED_ID) {
  store.subscribe((reason) => {
    if (reason !== "document" && reason !== "threads") return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_AFTER_MS);
  });
  // An edit made in the last moments still reaches the server when the window closes.
  addEventListener("pagehide", () => {
    if (saveTimer && sync?.mode() !== "live") navigator.sendBeacon(`/api/files/${FILE_ID}`, new Blob([JSON.stringify(content())], { type: "application/json" }));
  });
}

// ---------- Tokens ----------
// The color fields and the color picker read and make tokens through this, not through the store.
tokenHost.tokens = () => store.tokens();
tokenHost.createFromColor = (value) => {
  let id;
  store.transact("Create token", () => {
    id = store.createToken("color");
    store.updateToken(id, { value });
  });
  return store.tokens().find((token) => token.id === id) ?? null;
};

// ---------- The views ----------
const editor = document.getElementById("editor");
const canvasEl = editor.querySelector(".canvas");
const leftPanel = editor.querySelector(".side.left");

const view = mountCanvas(canvasEl, store);
const commands = mountCommands({ toolbar: editor.querySelector(".toolbar"), menu: document.getElementById("editor-menu"), canvas: canvasEl, store, view, upload });
mountLayers(editor.querySelector(".layers"), store);
mountInspector(editor.querySelector(".inspector"), store);

// The frame around the editor: icons in place, and the zoom in the top bar.
for (const slot of editor.querySelectorAll("[data-icon]:empty")) slot.innerHTML = PANEL_ICONS[slot.dataset.icon] ?? "";
const zoomValue = editor.querySelector(".zoom-value");
store.subscribe((reason) => reason === "ui" && (zoomValue.textContent = `${Math.round(store.ui.zoom * 100)}%`));
editor.querySelector(".zoom-menu").addEventListener("click", () => view.zoomToFit());
mountSidebars(editor, store);
mountPages(leftPanel, store);

// ---------- Who is here ----------
// The signed-in account, or, on a server with sign-in off, a guest with a name of its own kept in this browser, so
// comments and mentions still tell people apart.
function loadGuest() {
  try {
    const kept = JSON.parse(localStorage.getItem("editor-guest"));
    if (kept?.id && kept?.name) return kept;
  } catch { /* a new guest */ }
  const made = { id: `guest-${crypto.randomUUID().slice(0, 8)}`, name: `Guest ${100 + Math.floor(Math.random() * 900)}` };
  try { localStorage.setItem("editor-guest", JSON.stringify(made)); } catch { /* not kept */ }
  return made;
}
const account = await fetch("/api/auth/me").then((response) => response.json()).catch(() => ({}));
const user = account.user ?? loadGuest();

// The people a comment can mention: those with the file open now, and those who have commented on it.
mountComments({ store, canvas: canvasEl, fileId: ID_OF_FILE, user, people: () => (sync?.peers() ?? []).map((p) => ({ id: p.userId ?? p.name, name: p.name })) });
// The Theme tab also holds the GitHub repo the file is connected to; Import brings its tokens here, then asks an agent for its components.
let agentPanel = null;
const theme = mountTheme(leftPanel, store, {
  repo: file.repo ?? null,
  setRepo: (repo) => put({ ...content(), repo }),
  importRepo: async (repo) => {
    const { added, updated, dropped, entries, repo: sourceRepo, branch } = await importRepoTokens(store, repo);
    const skipped = dropped.length ? `, ${dropped.length} skipped (${dropped.slice(0, 3).map((d) => d.name).join(", ")}${dropped.length > 3 ? "…" : ""})` : "";
    toast(`${added} tokens added, ${updated} updated${skipped}`);
    // Three agents share the components, each a column of the Components page.
    if (!agentPanel) return;
    const pageId = componentsPage(store);
    const plan = componentImportPlan(sourceRepo ?? repo, branch, entries, componentArtboards(store, pageId), COMPONENTS);
    await Promise.all(componentAssignments(plan).map((assignments, i) => {
      const names = assignments.map((item) => item.name);
      return agentPanel.ask(componentsPrompt(sourceRepo ?? repo, pageId, assignments, i * 1040), `Import components from ${repo}: ${names.join(", ")}`);
    }));
  },
});

// ---------- The file's name and the way back ----------
const fileName = editor.querySelector(".file-name");
fileName.textContent = file.name ?? "Untitled";

/** Swaps the name for a text field. Enter or leaving it renames the file; Escape keeps the old name. */
function startRename() {
  const field = Object.assign(document.createElement("input"), { className: "file-name-input", value: fileName.textContent });
  field.setAttribute("aria-label", "File name");
  fileName.hidden = true;
  fileName.after(field);
  field.focus();
  field.select();

  let finished = false;
  async function finish(commit) {
    if (finished) return;
    finished = true;
    const name = field.value.trim();
    field.remove();
    fileName.hidden = false;
    if (!commit || !name || name === fileName.textContent) return;
    try {
      await put({ name });
      fileName.textContent = name;
      document.title = name;
    } catch (error) {
      console.error(error);
      toast("Could not rename the file");
    }
  }
  field.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  });
  field.addEventListener("blur", () => finish(true));
}
if (!SHARED_ID) {
  fileName.title = "Rename";
  fileName.addEventListener("click", startRename);
}

// The logo goes back to the list of files, and so does ⇧⌘D.
const logo = editor.querySelector(".file-logo");
logo.title = "All files (⇧⌘D)";
logo.style.cursor = "pointer";
logo.addEventListener("click", () => (location.href = "/files"));
addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "d") {
    event.preventDefault();
    location.href = "/files";
  }
});

// ---------- Working together ----------
// Everyone who has this file open sees each other's edits and pointers. A name changed elsewhere shows here.
const agentCursor = mountAgentCursor(canvasEl, store);
sync = mountSync({
  identity: account.user ? null : user, store, canvas: canvasEl, fileId: ID_OF_FILE, shared: Boolean(SHARED_ID),
  // An agent over MCP (server/mcp/server.mjs) works on this page's own store, so what it does saves and syncs like anything typed.
  agentCalls: FILE_ID
    ? (announce) => createMcpHandlers({ store, canvas: canvasEl, fileId: FILE_ID, fileName: () => fileName.textContent, repo: theme.repo, user, announce: (info) => { announce(info); agentCursor.follow(info); } })
    : undefined,
  onMeta: ({ name, repo }) => {
    theme.showRepo(repo ?? null);
    if (!name) return;
    fileName.textContent = name;
    document.title = name;
  },
});

// The agent panel runs the editor's tools through the sync, the way an agent over MCP does, each agent under its own name.
if (FILE_ID) {
  agentPanel = mountAgent({
    left: leftPanel,
    run: async (method, args, agent) => {
      await agentCursor.aim(agent, args);
      return sync.call(method, args, agent);
    },
  });
}

// ---------- Sharing ----------
const shareButton = editor.querySelector(".share");
if (SHARED_ID) shareButton.hidden = true;
else mountShare(shareButton, { link: `${location.origin}/f/${FILE_ID}`, access: file.access, setAccess: (access) => put({ ...content(), access }) });

requestAnimationFrame(() => view.zoomToFit());

// For poking at the editor from the console, and for the app's menu, which runs the editor's commands.
window.editor = { store, view, run: commands.run };
