import test from "node:test";
import assert from "node:assert/strict";
import { REPO, createGithub } from "../server/github.mjs";

// A stand-in for GitHub: answers what the test says, and remembers what it was asked.
function fakeGithub(answer) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, headers: options.headers });
    const a = answer(url);
    return { ok: a.status === 200, status: a.status, headers: new Headers(a.headers ?? {}), json: async () => a.body };
  };
  return { calls, fetch };
}

async function call(github, query) {
  let status, body;
  const res = { writeHead: (s) => { status = s; return res; }, end: (text) => { body = JSON.parse(text); } };
  await github.handle({ url: `/api/github${query}` }, res);
  return { status, body };
}

test("the repo string is checked, and a bad one asks GitHub nothing", async () => {
  for (const ok of ["shadcn-ui/ui", "o/n@main", "o/n@feat/x", "a.b-c/d_e"]) assert.ok(REPO.test(ok), ok);
  for (const bad of ["", "ui", "o/n/x", "o n/x", "https://github.com/o/n"]) assert.ok(!REPO.test(bad), bad);
  const fake = fakeGithub(() => ({ status: 200, body: {} }));
  const github = createGithub({ token: () => "t", fetch: fake.fetch });
  assert.equal((await call(github, "?repo=bad")).status, 400);
  assert.equal((await call(github, "")).status, 400);
  assert.equal((await call(github, "?repo=o/n&path=../etc")).status, 400);
  assert.equal(fake.calls.length, 0);
});

test("the tree keeps blob paths and usable SHAs, with the token, and one file comes decoded", async () => {
  const fake = fakeGithub((url) => url.includes("git/trees")
    ? {
      status: 200,
      body: {
        tree: [
          { path: "src/a.css", type: "blob", sha: "sha-a" },
          { path: "src", type: "tree", sha: "tree-sha" },
          { path: "README.md", type: "blob", sha: "sha-readme" },
          { path: "no-sha.txt", type: "blob" },
          { path: "empty-sha.txt", type: "blob", sha: "" },
          { type: "blob", sha: "missing-path-sha" },
        ],
      },
    }
    : { status: 200, body: { type: "file", content: Buffer.from(":root { --radius: 8px; }").toString("base64") } });
  const github = createGithub({ token: () => "t", fetch: fake.fetch });
  const tree = await call(github, "?repo=o/n@main");
  assert.deepEqual(tree.body, {
    repo: "o/n",
    branch: "main",
    files: ["src/a.css", "README.md", "no-sha.txt", "empty-sha.txt"],
    entries: [{ path: "src/a.css", sha: "sha-a" }, { path: "README.md", sha: "sha-readme" }],
    truncated: false,
  });
  assert.match(fake.calls[0].url, /\/repos\/o\/n\/git\/trees\/main\?recursive=1$/);
  assert.equal(fake.calls[0].headers.authorization, "Bearer t");
  const file = await call(github, "?repo=o/n@main&path=src/a.css");
  assert.deepEqual(file.body, { path: "src/a.css", size: 24, text: ":root { --radius: 8px; }", truncated: false });
  assert.match(fake.calls[1].url, /contents\/src\/a\.css\?ref=main$/);
});

test("binary files, missing repos, bad tokens and the rate limit each get a clear answer", async () => {
  const nul = createGithub({ token: () => undefined, fetch: fakeGithub(() => ({ status: 200, body: { type: "file", content: Buffer.from("ab\0cd").toString("base64") } })).fetch });
  assert.equal((await call(nul, "?repo=o/n&path=x.bin")).status, 415);
  assert.equal((await call(nul, "?repo=o/n&path=logo.png")).status, 415);
  const missing = createGithub({ token: () => undefined, fetch: fakeGithub(() => ({ status: 404, body: {} })).fetch });
  const notFound = await call(missing, "?repo=o/private");
  assert.equal(notFound.status, 404);
  assert.match(notFound.body.error, /GITHUB_TOKEN/);
  const badToken = createGithub({ token: () => "x", fetch: fakeGithub(() => ({ status: 401, body: {} })).fetch });
  assert.equal((await call(badToken, "?repo=o/n")).status, 403);
  const limited = createGithub({ token: () => undefined, fetch: fakeGithub(() => ({ status: 403, headers: { "x-ratelimit-remaining": "0" }, body: {} })).fetch });
  assert.equal((await call(limited, "?repo=o/n")).status, 429);
  const down = createGithub({ token: () => undefined, fetch: async () => { throw new Error("offline"); } });
  assert.equal((await call(down, "?repo=o/n")).status, 502);
});
