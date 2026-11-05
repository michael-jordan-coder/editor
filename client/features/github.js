// The GitHub repo a file is connected to: reading it through the server (/api/github, server/github.mjs), its CSS
// variables as the file's tokens, and the request that asks an agent for its Components page.
import { applyTokens } from "../core/tokens.js";
import { extractDeclarations, mapToTheme, pickTokenFiles } from "../core/repo-tokens.js";

/** The repo's file list (no `path`), or one of its text files. Throws with the server's reason. */
export async function repoFetch(repo, path) {
  const query = `repo=${encodeURIComponent(repo)}${path !== undefined ? `&path=${encodeURIComponent(path)}` : ""}`;
  const response = await fetch(`/api/github?${query}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `The server answered ${response.status}`);
  return data;
}

/**
 * The repo's theme into the file's tokens, as one undo step that adds and updates but removes nothing.
 * Answers { files, entries, repo, branch, added, updated, dropped }.
 */
export async function importRepoTokens(store, repo) {
  const tree = await repoFetch(repo);
  const { files } = tree;
  const picked = pickTokenFiles(files);
  const declarations = [];
  for (const path of picked) declarations.push(...extractDeclarations((await repoFetch(repo, path)).text));
  const { tokens, dropped } = mapToTheme(declarations);
  const { add, update } = applyTokens(store, tokens, { label: `Import tokens from ${repo}`, replace: false });
  return { files: picked, entries: tree.entries ?? [], repo: tree.repo, branch: tree.branch, added: add.length, updated: update.length, dropped };
}

// The components worth a reference, the primitives first; the agents split them between them.
export const COMPONENTS = ["Button", "Input", "Badge", "Card", "Checkbox", "Switch", "Select", "Tabs", "Alert", "Avatar", "Dialog", "Table"];

/** The page the components go on: the one named "Components", made if it is not there. Answers its id. */
export function componentsPage(store) {
  const found = store.pages().find((p) => p.label === "Components");
  if (found) return found.id;
  let id;
  store.transact("Add page", () => {
    id = store.addPage({ activate: false });
    store.renamePage(id, "Components");
  });
  return id;
}

const componentNameFromPath = (path) => {
  const parts = path.split("/");
  const stem = parts.at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  return stem.toLowerCase() === "index" ? parts.at(-2) ?? stem : stem;
};

/** The current source identity used for generated component artboards. */
export const sourceIdentity = (repo, branch = "HEAD") => {
  const raw = String(repo).trim();
  const separator = raw.indexOf("@");
  const name = (separator < 0 ? raw : raw.slice(0, separator)).toLowerCase();
  const requestedBranch = separator < 0 ? "" : raw.slice(separator + 1);
  return `${name}@${(requestedBranch || branch || "HEAD").trim()}`;
};

/** Artboards on the Components page, including source metadata when a prior import recorded it. */
export const componentArtboards = (store, pageId) =>
  store.all().filter((node) => node.component === "Frame" && node.parent == null && node.page === pageId);

/**
* Makes one plan item per known component source. Names are used only to select likely component files and to
* provide a legacy fallback; repository identity and path are the actual identity.
*/
export function componentImportPlan(repo, branch, entries, artboards, names = COMPONENTS) {
  const identity = sourceIdentity(repo, branch);
  const wanted = new Map(names.map((name) => [name.toLowerCase(), name]));
  const plan = [];
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || typeof entry.sha !== "string" || !entry.sha) continue;
    const name = wanted.get(componentNameFromPath(entry.path).toLowerCase());
    if (!name) continue;
    const source = { repo: identity, path: entry.path, sha: entry.sha };
    const matches = artboards.filter((node) => node.source?.repo === identity && node.source?.path === entry.path);
    const existing = matches[0];
    if (existing && existing.source.sha === entry.sha) {
      plan.push({ name, source, action: "skip", artboardId: existing.id });
      continue;
    }
    if (existing) {
      plan.push({ name, source, action: "update", artboardId: existing.id });
      continue;
    }
    const legacy = artboards.filter((node) => !node.source && node.name === name);
    plan.push({
      name, source, action: legacy.length === 1 ? "update" : "create",
      ...(legacy.length === 1 ? { artboardId: legacy[0].id, legacy: true } : {}),
    });
  }
  return plan;
}

/** Removes unchanged items and assigns each remaining item to exactly one agent. */
export function componentAssignments(plan, agentCount = 3) {
  const pending = plan.filter((item) => item.action !== "skip");
  const count = Math.min(3, Math.max(0, agentCount), pending.length);
  if (!count) return [];
  const size = Math.floor(pending.length / count);
  const remainder = pending.length % count;
  let offset = 0;
  return Array.from({ length: count }, (_, index) => {
    const group = pending.slice(offset, offset + size + (index < remainder ? 1 : 0));
    offset += group.length;
    return group;
  });
}

/** What one agent is asked for: its explicit share of the repository's component import plan. */
export const componentsPrompt = (repo, pageId, assignments, x) => {
  const items = assignments.map((item) => `- ${item.name}: ${item.action} source ${item.source.path} (SHA ${item.source.sha})${item.artboardId ? `, artboard ID ${item.artboardId}` : ""}`).join("\n");
  const operations = assignments.map((item, index) => {
    const source = JSON.stringify(item.source);
    if (item.action === "update") return `${index + 1}. Update ${item.name} using artboard ID ${item.artboardId}: read ${item.source.path}, then write the generated HTML with mode "replace-children" and source ${source}. Never create another artboard.`;
    return `${index + 1}. Create ${item.name}: read ${item.source.path}, then call create_artboard with pageId "${pageId}", name "${item.name}", and the specified styles. Capture its returned id as the targetNodeId. Only after the HTML is generated, call write_html with that targetNodeId, mode "insert-children", and source ${source}; this writes metadata only after insertion succeeds.`;
  }).join("\n");
 return `This file is connected to the GitHub repo ${repo}. Other agents are building different components at the same time. Your assignments are:
${items}
Build only these assignments on the page with ID ${pageId} ("Components"); never touch other pages or other agents' artboards.
1. get_basic_info once.
2. For each assignment, follow exactly one of these operations:
${operations}
3. Skip and report an assignment if its file is over 40 KB or cannot be read; never substitute another source file.
4. For newly created artboards, use styles width 960px, height 400px, left ${x}px, top by its place in this list (0px, 600px, 1200px, ...), background var(--color-background) if the file has that token else #ffffff, padding 32px, flex column, gap 24px. The HTML should have one row per variant and per size/state (default, disabled), plain inline styles, and a 12px caption above each. Where the code uses a Tailwind class or variable matching a file token (bg-primary → var(--color-primary), rounded-md → var(--radius-md), text-sm → var(--text-sm)), use the token; literal values only where there is none. Real labels, no logic, no scripts.
5. After each successful assignment, update the artboard to height "fit-content" and finish_working_on_nodes. Say which components you made and which you skipped.`;
};
