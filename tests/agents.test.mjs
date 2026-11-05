import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { connectAgent } from "../desktop/agents.mjs";
import { makePdf } from "../client/features/pdf.js";
import { startServer } from "../server/server.mjs";

const home = () => fs.mkdtemp(path.join(os.tmpdir(), "editor-home-"));
const URL_ = "http://127.0.0.1:4191/mcp";
const run = { command: "/usr/bin/node", env: { ELECTRON_RUN_AS_NODE: "1" } };

test("Claude Code: the entry is added to ~/.claude.json and the rest of the file stays", async () => {
  const h = await home();
  const file = path.join(h, ".claude.json");
  await fs.writeFile(file, JSON.stringify({ numStartups: 3, mcpServers: { other: { type: "http", url: "http://x" } } }, null, 2));
  const result = await connectAgent("claude-code", { home: h, url: URL_, run });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  const after = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(after.numStartups, 3);
  assert.deepEqual(after.mcpServers.other, { type: "http", url: "http://x" });
  assert.equal(after.mcpServers.editor.type, "stdio");
  assert.equal(after.mcpServers.editor.command, "/usr/bin/node");
  assert.deepEqual(after.mcpServers.editor.env, { ELECTRON_RUN_AS_NODE: "1", EDITOR_URL: URL_ });
  // The relay it points at is a copy that lives in ~/.editor/bin.
  assert.equal(after.mcpServers.editor.args[0], path.join(h, ".editor", "bin", "mcp-stdio.mjs"));
  await fs.access(after.mcpServers.editor.args[0]);
  // The first change keeps the file as it was.
  assert.equal(JSON.parse(await fs.readFile(`${file}.editor-backup`, "utf8")).mcpServers.editor, undefined);
  // Again: nothing to change.
  assert.equal((await connectAgent("claude-code", { home: h, url: URL_, run })).changed, false);
});

test("Claude Code: a file that is not JSON is left alone and said so", async () => {
  const h = await home();
  const file = path.join(h, ".claude.json");
  await fs.writeFile(file, "{ not json");
  const result = await connectAgent("claude-code", { home: h, url: URL_, run });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-config-file");
  assert.equal(await fs.readFile(file, "utf8"), "{ not json");
});

test("Claude Code: a missing file is made", async () => {
  const h = await home();
  const result = await connectAgent("claude-code", { home: h, url: URL_, run });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(h, ".claude.json"), "utf8")).mcpServers.editor.type, "stdio");
});

test("Cursor: the entry is added to ~/.cursor/mcp.json and the rest of the file stays", async () => {
  const h = await home();
  const file = path.join(h, ".cursor", "mcp.json");
  const original = { $schema: "https://example.com/cursor.schema.json", mcpServers: { other: { type: "http", url: "http://x" } } };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(original, null, 2));
  const result = await connectAgent("cursor", { home: h, url: URL_, run });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  const after = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(after.$schema, original.$schema);
  assert.deepEqual(after.mcpServers.other, original.mcpServers.other);
  assert.equal(after.mcpServers.editor.type, "stdio");
  assert.equal(after.mcpServers.editor.command, "/usr/bin/node");
  assert.deepEqual(after.mcpServers.editor.args, [path.join(h, ".editor", "bin", "mcp-stdio.mjs")]);
  assert.deepEqual(after.mcpServers.editor.env, { ELECTRON_RUN_AS_NODE: "1", EDITOR_URL: URL_ });
  await fs.access(after.mcpServers.editor.args[0]);
  assert.deepEqual(JSON.parse(await fs.readFile(`${file}.editor-backup`, "utf8")), original);
});

test("Cursor: a missing configuration is created without a backup", async () => {
  const h = await home();
  const file = path.join(h, ".cursor", "mcp.json");
  const result = await connectAgent("cursor", { home: h, url: URL_, run });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).mcpServers.editor.type, "stdio");
  await assert.rejects(fs.access(`${file}.editor-backup`), { code: "ENOENT" });
});

test("Cursor: connecting twice with the same values is idempotent", async () => {
  const h = await home();
  const options = { home: h, url: URL_, run };
  assert.equal((await connectAgent("cursor", options)).changed, true);
  assert.equal((await connectAgent("cursor", options)).changed, false);
});

test("Cursor: an existing editor entry is updated while other servers stay", async () => {
  const h = await home();
  const file = path.join(h, ".cursor", "mcp.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    mcpServers: {
      editor: { type: "stdio", command: "old-node", args: ["old-relay"], env: { EDITOR_URL: "http://old/mcp" } },
      other: { type: "http", url: "http://x" },
    },
  }, null, 2));
  const result = await connectAgent("cursor", { home: h, url: URL_, run });
  assert.equal(result.changed, true);
  const after = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(after.mcpServers.editor.command, "/usr/bin/node");
  assert.deepEqual(after.mcpServers.editor.args, [path.join(h, ".editor", "bin", "mcp-stdio.mjs")]);
  assert.deepEqual(after.mcpServers.editor.env, { ELECTRON_RUN_AS_NODE: "1", EDITOR_URL: URL_ });
  assert.deepEqual(after.mcpServers.other, { type: "http", url: "http://x" });
});

test("Cursor: an existing backup is not overwritten", async () => {
  const h = await home();
  const file = path.join(h, ".cursor", "mcp.json");
  const backup = `${file}.editor-backup`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ mcpServers: { editor: { type: "stdio", command: "old-node", args: [] } } }));
  const sentinel = '{"sentinel":"keep"}\n';
  await fs.writeFile(backup, sentinel);
  const result = await connectAgent("cursor", { home: h, url: URL_, run });
  assert.equal(result.changed, true);
  assert.equal(await fs.readFile(backup, "utf8"), sentinel);
});

test("Cursor: a file that is not JSON is left alone and said so", async () => {
  const h = await home();
  const file = path.join(h, ".cursor", "mcp.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "{ not json");
  const result = await connectAgent("cursor", { home: h, url: URL_, run });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-config-file");
  assert.equal(await fs.readFile(file, "utf8"), "{ not json");
});

test("Codex: the table is appended after what is there, comments included, and replaced when the app moves", async () => {
  const h = await home();
  const file = path.join(h, ".codex", "config.toml");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const before = '# my settings\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\nargs = ["mcp"]\n';
  await fs.writeFile(file, before);
  assert.equal((await connectAgent("codex", { home: h, url: URL_, run })).changed, true);
  const first = await fs.readFile(file, "utf8");
  assert.ok(first.startsWith(before.trimEnd()));
  assert.match(first, /\[mcp_servers\.editor\]\ncommand = "\/usr\/bin\/node"/);
  assert.match(first, /\[mcp_servers\.editor\.env\]\nELECTRON_RUN_AS_NODE = "1"\nEDITOR_URL = "http:\/\/127\.0\.0\.1:4191\/mcp"/);
  assert.equal((await connectAgent("codex", { home: h, url: URL_, run })).changed, false);
  // The app now answers on another port: the one table is rewritten, nothing is added twice.
  assert.equal((await connectAgent("codex", { home: h, url: "http://127.0.0.1:5000/mcp", run })).changed, true);
  const second = await fs.readFile(file, "utf8");
  assert.equal(second.match(/\[mcp_servers\.editor\]/g).length, 1);
  assert.match(second, /5000/);
  assert.doesNotMatch(second, /4191/);
  assert.ok(second.startsWith(before.trimEnd()));
});

test("Codex: a table after the editor's own is kept when the editor's is rewritten", async () => {
  const h = await home();
  const file = path.join(h, ".codex", "config.toml");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '[mcp_servers.editor]\ncommand = "old"\nargs = []\n\n[projects."/x"]\ntrust = "trusted"\n');
  await connectAgent("codex", { home: h, url: URL_, run });
  const text = await fs.readFile(file, "utf8");
  assert.match(text, /\[projects\."\/x"\]\ntrust = "trusted"/);
  assert.doesNotMatch(text, /command = "old"/);
});

test("an agent that is not known is refused", async () => {
  assert.equal((await connectAgent("nothing", { home: await home(), url: URL_, run })).reason, "unknown-agent");
});

test("the relay: stdio on one side, the server's /mcp on the other, and a plain answer when the editor is not running", async () => {
  const h = await home();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "editor-relay-"));
  const { server, url } = await startServer({ port: 0, dataDir });
  const relay = path.join(import.meta.dirname, "..", "server", "mcp", "relay.mjs");
  const talk = (target, messages) => new Promise((resolve) => {
    const child = spawn(process.execPath, [relay], { env: { ...process.env, EDITOR_URL: target } });
    const answers = [];
    let buffer = "";
    child.stdout.on("data", (d) => {
      buffer += d;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) { answers.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); }
      if (answers.length === messages.filter((m) => m.id !== undefined).length) child.stdin.end();
    });
    child.on("close", () => resolve(answers));
    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  });
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "codex", version: "1" } } };
  const sent = { jsonrpc: "2.0", method: "notifications/initialized" };
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  try {
    const answers = await talk(new URL("mcp", url).href, [init, sent, list]);
    assert.equal(answers[0].result.serverInfo.name, "editor");
    assert.ok(answers[1].result.tools.length > 30);
  } finally { server.close(); }
  // Not running: an error that says what to do, never a hang.
  const gone = await talk("http://127.0.0.1:1/mcp", [init]);
  assert.match(gone[0].error.message, /not running/i);
  void h;
});

test("a PDF has a page for each picture and a table that points at them", () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  const bytes = makePdf([{ width: 100, height: 50, jpeg }, { width: 20, height: 20, jpeg, pixelWidth: 30, pixelHeight: 30 }]);
  const text = Buffer.from(bytes).toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.match(text, /\/Count 2/);
  assert.match(text, /\/Width 30 \/Height 30/);
  const at = Number(/startxref\n(\d+)/.exec(text)[1]);
  assert.equal(text.slice(at, at + 4), "xref");
  assert.throws(() => makePdf([]));
});
