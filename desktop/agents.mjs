// Lets an agent (Claude Code, Codex) find the editor: one entry named "editor" in the agent's own MCP config, pointing
// at a copy of the stdio relay (server/mcp/relay.mjs).
//
// Only that entry is touched. Everything else in the file stays as it was, a file that cannot be read is left alone
// and the reason is returned, and the first change to a file keeps a copy of it beside it as <file>.editor-backup.
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

export const NAME = "editor";

export const AGENTS = {
  "claude-code": { label: "Claude Code", file: (home) => join(home, ".claude.json"), format: "json" },
  codex: { label: "Codex", file: (home) => join(home, ".codex", "config.toml"), format: "toml" },
  cursor: { label: "Cursor", file: (home) => join(home, ".cursor", "mcp.json"), format: "json" },
};

// An edit answers with one of: { text } (the new file), { unchanged: true }, or { invalid } (why the file is not touched).
const hasEnv = (server) => Object.keys(server.env ?? {}).length > 0;

// ---------- JSON: Claude Code's ~/.claude.json ----------
function editJson(current, server) {
  let config;
  try {
    config = current?.trim() ? JSON.parse(current) : {};
  } catch (error) {
    return { invalid: `Not valid JSON: ${error.message}` };
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return { invalid: "Expected a JSON object at the top level" };
  const others = config.mcpServers ?? {};
  if (typeof others !== "object" || Array.isArray(others)) return { invalid: 'Expected "mcpServers" to be an object' };

  const entry = { type: "stdio", command: server.command, args: server.args, ...(hasEnv(server) ? { env: server.env } : {}) };
  if (isDeepStrictEqual(others[NAME], entry)) return { unchanged: true };
  return { text: `${JSON.stringify({ ...config, mcpServers: { ...others, [NAME]: entry } }, null, 2)}\n` };
}

// ---------- TOML: Codex's ~/.codex/config.toml ----------
const tomlString = (value) => JSON.stringify(value);

function tomlTables(server) {
  return [
    `[mcp_servers.${NAME}]`,
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(", ")}]`,
    ...(hasEnv(server) ? ["", `[mcp_servers.${NAME}.env]`, ...Object.entries(server.env).map(([key, value]) => `${key} = ${tomlString(value)}`)] : []),
  ].join("\n");
}

// Cuts the editor's table and its sub-tables out of the file by lines and appends the current ones, so no other
// byte of the file changes (there is no TOML parser here, on purpose).
function editToml(current, server) {
  const text = current ?? "";
  const tableHeader = /^\s*\[/;
  const ours = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*"?${NAME}"?\\s*(\\.[^\\]]*)?\\]\\s*$`);
  const outside = [], inside = [];
  let within = false;
  for (const line of text.split("\n")) {
    if (tableHeader.test(line)) within = ours.test(line);
    (within ? inside : outside).push(line);
  }

  const wanted = tomlTables(server);
  if (inside.length && inside.join("\n").trim() === wanted.trim()) return { unchanged: true };
  // Dotted keys (mcp_servers.editor = ...) cannot be told apart from ours without a parser, so leave the file alone.
  if (/^\s*mcp_servers\.editor\s*=/m.test(text)) return { invalid: "mcp_servers.editor is written as a dotted key; remove it first" };
  const kept = outside.join("\n").replace(/\n+$/, "");
  return { text: `${kept ? `${kept}\n\n` : ""}${wanted}\n` };
}

const EDITORS = { json: editJson, toml: editToml };

// ---------- Files ----------
/** Writes through a temporary file so a crash never leaves half a config, keeping the file's permissions. */
async function replaceFile(path, text) {
  const mode = await stat(path).then((s) => s.mode & 0o777, () => 0o600);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.editor-tmp`;
  await writeFile(temporary, text, { mode });
  await rename(temporary, path);
}

/** The file's text, or null when there is no such file. */
async function readIfThere(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Copies the relay to ~/.editor/bin, so an agent's config never points into an app that moves or updates. */
export async function installRelay({ home = homedir(), source = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "mcp", "relay.mjs") } = {}) {
  const target = join(home, ".editor", "bin", "mcp-stdio.mjs"); // the name stays, for agents that are already connected
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await readFile(source));
  return target;
}

/**
 * Connects one agent. `url` is where the editor's /mcp is, and `run` is how to start a script with the app's own
 * Node (in Electron, the app itself with ELECTRON_RUN_AS_NODE). Answers { ok, path, changed, backup? } or
 * { ok: false, reason, message }.
 */
export async function connectAgent(agent, { home = homedir(), url, run = { command: process.execPath, env: {} }, relaySource } = {}) {
  const spec = AGENTS[agent];
  if (!spec) return { ok: false, reason: "unknown-agent", message: `Unknown agent ${agent}` };
  const path = spec.file(home);
  try {
    const relay = await installRelay({ home, ...(relaySource ? { source: relaySource } : {}) });
    const server = { command: run.command, args: [relay], env: { ...run.env, EDITOR_URL: url } };
    const current = await readIfThere(path);
    const edit = EDITORS[spec.format](current, server);
    if (edit.invalid) return { ok: false, reason: "invalid-config-file", path, message: edit.invalid };
    if (edit.unchanged) return { ok: true, path, changed: false };

    const backup = `${path}.editor-backup`;
    const existed = current !== null;
    if (existed && !(await stat(backup).catch(() => null))) await copyFile(path, backup);
    await replaceFile(path, edit.text);
    return { ok: true, path, changed: true, ...(existed ? { backup } : {}) };
  } catch (error) {
    return { ok: false, reason: "error", path, message: error.message };
  }
}
