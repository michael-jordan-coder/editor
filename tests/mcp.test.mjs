import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../server/server.mjs";
import { TOOLS } from "../server/mcp/tools.mjs";
import { createStore } from "../client/core/store.js";

globalThis.document = {
  querySelector: () => null,
  createElement: () => {
    let fillStyle = "";
    return { getContext: () => ({ get fillStyle() { return fillStyle; }, set fillStyle(value) { fillStyle = value; } }) };
  },
};
const { createMcpHandlers } = await import("../client/collab/agent-calls.js");

const open = async (options) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "editor-mcp-"));
  const { server, url } = await startServer({ port: 0, dataDir, ...options });
  return { server, url, dataDir };
};
const agent = async (url, { name = "claude-code", headers } = {}) => {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("mcp", url), { requestInit: { headers } }));
  return client;
};
const textOf = (result) => result.content.find((c) => c.type === "text")?.text;
const json = (result) => JSON.parse(textOf(result));
const make = async (url, patch = {}) => (await (await fetch(new URL("/api/files", url), { method: "POST", body: JSON.stringify(patch) })).json()).id;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A page that answers an agent's calls: what the editor's own page does, with the tools stood in for.
function fakePage(url, id, answer) {
  const ws = new WebSocket(`${url.replace("http", "ws")}sync/${id}`);
  const seen = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    seen.push(message);
    if (message.t === "call") {
      Promise.resolve().then(() => answer(message.method, message.args, message)).then((value) => ws.send(JSON.stringify({ t: "result", id: message.id, value })), (error) => ws.send(JSON.stringify({ t: "result", id: message.id, error: error.message })));
    }
  });
  return { ws, seen, ready: new Promise((r) => ws.on("open", r)), touch: () => ws.send(JSON.stringify({ t: "presence", page: "page-1", x: 0, y: 0, selection: [] })), close: () => ws.close() };
}

test("an agent finds the tools, and the instructions to use them", async () => {
  const { server, url } = await open();
  const client = await agent(url);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of ["get_basic_info", "get_selection", "get_node_info", "get_tree_summary", "find_nodes", "get_jsx", "get_screenshot", "write_html", "update_styles", "set_text_content", "create_artboard", "duplicate_nodes", "move_nodes", "get_tokens", "create_tokens", "list_repo_files", "read_repo_file", "list_comment_threads", "finish_working_on_nodes", "list_resources", "open_file"]) assert.ok(names.includes(name), name);
    assert.equal(names.length, TOOLS.length);
    const writeHtml = tools.find((tool) => tool.name === "write_html");
    const createArtboard = tools.find((tool) => tool.name === "create_artboard");
    assert.ok(writeHtml.inputSchema.properties.source);
    assert.ok(writeHtml.inputSchema.properties.targetNodeId);
    assert.ok(createArtboard.inputSchema.properties.pageId);
    for (const tool of tools) { assert.equal(tool.inputSchema.type, "object"); assert.ok(tool.description.length > 20, tool.name); }
    assert.match(client.getInstructions(), /get_basic_info/);
    assert.match(textOf(await client.callTool({ name: "get_guide", arguments: { topic: "editor-mcp-instructions" } })), /finish_working_on_nodes/);
    assert.equal((await client.callTool({ name: "get_guide", arguments: { topic: "nope" } })).isError, true);
  } finally { await client.close(); server.close(); }
});

test("the write_html MCP handler rejects an invalid replacement without changing source metadata", async () => {
  const store = createStore([]);
  let artboard, child;
  store.transact("create", () => {
    artboard = store.insert({ component: "Frame", name: "Button", parent: null, page: "page-1", style: {}, source: { repo: "o/n@main", path: "Button.tsx", sha: "old" } });
    child = store.insert({ component: "Text", name: "Child", text: "old", parent: artboard, page: "page-1", style: {} });
  });
  const call = createMcpHandlers({
    store,
    canvas: { querySelector: () => null },
    fileId: "file-1",
    fileName: () => "Test",
    announce: () => {},
  });

  await assert.rejects(
    call("write_html", {
      html: "<button>New</button>",
      targetNodeId: child,
      mode: "replace-children",
      source: { repo: "o/n@main", path: "Button.tsx", sha: "new" },
    }),
    /root Frame artboard/,
  );
  assert.equal(store.get(artboard).source.sha, "old");
  assert.equal(store.get(child).text, "old");
});

test("files: list, make, copy, rename, all without a page", async () => {
  const { server, url } = await open();
  const client = await agent(url);
  try {
    const first = json(await client.callTool({ name: "create_file", arguments: { name: "From an agent" } }));
    assert.equal(first.name, "From an agent");
    assert.match(first.url, new RegExp(`/file/${first.id}$`));
    const copy = json(await client.callTool({ name: "create_file", arguments: { cloneFileId: first.id } }));
    assert.notEqual(copy.id, first.id);
    assert.equal(json(await client.callTool({ name: "rename_resource", arguments: { resourceId: copy.id, name: "Copy" } })).name, "Copy");
    const listed = json(await client.callTool({ name: "list_resources", arguments: {} })).items;
    assert.deepEqual(listed.map((f) => f.name).sort(), ["Copy", "From an agent"]);
    assert.equal((await client.callTool({ name: "rename_resource", arguments: { resourceId: "nothing", name: "x" } })).isError, true);
    assert.match(textOf(await client.callTool({ name: "get_node_info", arguments: {} })), /needs nodeId/);
  } finally { await client.close(); server.close(); }
});

test("a call goes to the page that has the file open, and what the page answers comes back", async () => {
  const { server, url } = await open();
  const id = await make(url);
  const client = await agent(url, { name: "codex-cli" });
  const page = fakePage(url, id, (method, args, message) => {
    if (method === "get_screenshot") return { images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }], text: { nodeId: args.nodeId } };
    if (method === "get_node_info") throw new Error("There is no node 99");
    return { method, args, agent: message.agent };
  });
  try {
    await page.ready;
    const answer = json(await client.callTool({ name: "get_basic_info", arguments: { pageId: "page-1" } }));
    assert.equal(answer.method, "get_basic_info");
    assert.equal(answer.args.pageId, "page-1");
    assert.equal(answer.agent, "Codex"); // the page is told who is asking, to show them at work
    const shot = await client.callTool({ name: "get_screenshot", arguments: { nodeId: "1" } });
    assert.equal(shot.content[0].type, "image");
    assert.equal(shot.content[0].mimeType, "image/png");
    assert.deepEqual(json(shot), { nodeId: "1" });
    const bad = await client.callTool({ name: "get_node_info", arguments: { nodeId: "99" } });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /no node 99/);
  } finally { page.close(); await client.close(); server.close(); }
});

test("with no page open the agent is told what to do; with two, the one the user touched last is used", async () => {
  const { server, url } = await open();
  const [a, b] = [await make(url), await make(url)];
  const client = await agent(url);
  try {
    assert.match(textOf(await client.callTool({ name: "get_basic_info", arguments: {} })), /No file is open in an editor/);
    const [pa, pb] = [fakePage(url, a, () => "A"), fakePage(url, b, () => "B")];
    await Promise.all([pa.ready, pb.ready]);
    await sleep(50); pa.touch(); await sleep(50);
    assert.equal(textOf(await client.callTool({ name: "get_basic_info", arguments: {} })), "A");
    pb.touch(); await sleep(50);
    assert.equal(textOf(await client.callTool({ name: "get_basic_info", arguments: {} })), "B");
    assert.equal(textOf(await client.callTool({ name: "get_basic_info", arguments: { fileId: a } })), "A"); // a named file wins
    assert.match(textOf(await client.callTool({ name: "get_basic_info", arguments: { fileId: "nothing" } })), /not open in an editor/);
    const listed = json(await client.callTool({ name: "list_resources", arguments: {} })).items;
    assert.deepEqual(listed.map((f) => [f.id === b, f.open, f.active]), [[true, true, true], [false, true, undefined]]);
    pa.close(); pb.close();
  } finally { await client.close(); server.close(); }
});

test("open_file tells the editors to open it, and answers when one has", async () => {
  const { server, url } = await open();
  const [a, b] = [await make(url), await make(url)];
  const client = await agent(url);
  const pages = [];
  const first = fakePage(url, a, (method, args) => ({ method, fileId: args.fileId }));
  // When told to open b, this page does what the editor does: goes to that file.
  first.ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); if (m.t === "open") pages.push(fakePage(url, m.fileId, (method, args) => ({ method, fileId: args.fileId }))); });
  try {
    await first.ready;
    const opened = json(await client.callTool({ name: "open_file", arguments: { fileId: `http://127.0.0.1:1/file/${b}` } }));
    assert.deepEqual(opened, { method: "get_basic_info", fileId: b });
    assert.match(textOf(await client.callTool({ name: "open_file", arguments: { fileId: "missing" } })), /There is no file/);
  } finally { first.close(); pages.forEach((p) => p.close()); await client.close(); server.close(); }
});

test("a browser cannot reach it, nor a page on another host; sessions are separate", async () => {
  const { server, url } = await open();
  try {
    const call = (headers) => new Promise((resolve) => {
      const request = http.request(new URL("/mcp", url), { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } }, (response) => { response.resume(); resolve(response.statusCode); });
      request.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } } }));
    });
    assert.equal(await call({ origin: "https://evil.example" }), 403);
    assert.equal(await call({ host: "evil.example.com" }), 403);
    assert.equal(await call({}), 200);
    const [one, two] = [await agent(url, { name: "claude-code" }), await agent(url, { name: "cursor" })];
    assert.notEqual(one.transport.sessionId, two.transport.sessionId);
    await Promise.all([one.listTools(), two.listTools()]);
    await one.close(); await two.close();
  } finally { server.close(); }
});

test("with sign-in on, agents need the token, and see only what is open in an editor", async () => {
  process.env.EDITOR_MCP_TOKEN = "s3cret-token-for-tests";
  const { server, url } = await open({ auth: true });
  try {
    const refused = new Client({ name: "x", version: "1" });
    await assert.rejects(refused.connect(new StreamableHTTPClientTransport(new URL("mcp", url))));
    const wrong = new Client({ name: "x", version: "1" });
    await assert.rejects(wrong.connect(new StreamableHTTPClientTransport(new URL("mcp", url), { requestInit: { headers: { authorization: "Bearer nope" } } })));
    const client = await agent(url, { headers: { authorization: "Bearer s3cret-token-for-tests" } });
    assert.deepEqual(json(await client.callTool({ name: "list_resources", arguments: {} })).items, []);
    assert.match(textOf(await client.callTool({ name: "create_file", arguments: {} })), /sign-in on/i);
    await client.close();
  } finally { delete process.env.EDITOR_MCP_TOKEN; server.close(); }
});
