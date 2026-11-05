// The GitHub repo a file is connected to, read for the page: its file list, or one text file. The token
// (GITHUB_TOKEN) stays here; a public repo needs none.
//
//   GET /api/github?repo=owner/name[@branch]            { repo, branch, files: ["src/a.css", ...], truncated }
//   GET /api/github?repo=owner/name[@branch]&path=src/x  { path, size, text, truncated }
const API = "https://api.github.com";
const MAX_FILES = 20000;
const MAX_TEXT = 200 * 1024;
const TIMEOUT_MS = 15000;
const CACHE_MS = 10 * 60 * 1000;
const CACHE_SIZE = 500;
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|7z|rar|jar|pdf|mp[34]|mov|webm|wasm)$/i;

export const REPO = /^[\w.-]+\/[\w.-]+(@[\w./-]+)?$/;

/** "owner/name@branch" apart. */
export const parseRepo = (text) => {
  const [full, branch] = text.split("@");
  const [owner, name] = full.split("/");
  return { owner, name, branch };
};

class GithubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createGithub({ token = () => process.env.GITHUB_TOKEN, fetch = globalThis.fetch } = {}) {
  const send = (res, status, data) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
  // What GitHub answered, kept for a while: agents read the same files again, and without a token GitHub allows 60 requests an hour.
  const cache = new Map();

  async function ask(repo, pathname) {
    const key = `${repo.owner}/${repo.name}/${pathname}`;
    const kept = cache.get(key);
    if (kept && Date.now() - kept.at < CACHE_MS) return kept.data;
    const data = await fetchJson(repo, pathname);
    cache.set(key, { at: Date.now(), data });
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    return data;
  }

  async function fetchJson(repo, pathname) {
    const headers = { accept: "application/vnd.github+json", "user-agent": "editor" };
    const key = token();
    if (key) headers.authorization = `Bearer ${key}`;
    let response;
    try {
      response = await fetch(`${API}/repos/${repo.owner}/${repo.name}/${pathname}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new GithubError(502, `GitHub did not answer: ${error.message}`);
    }
    if (response.ok) return response.json();
    const full = `${repo.owner}/${repo.name}`;
    // A private repo without a token is "not found" to GitHub, not "forbidden".
    if (response.status === 404) throw new GithubError(404, `${full} was not found. A private repo needs GITHUB_TOKEN in .env.local`);
    if (response.status === 401) throw new GithubError(403, "GITHUB_TOKEN is not valid");
    if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") throw new GithubError(429, "GitHub's rate limit is reached; set GITHUB_TOKEN to raise it");
    throw new GithubError(502, `GitHub answered ${response.status}`);
  }

  async function tree(repo) {
    const data = await ask(repo, `git/trees/${encodeURIComponent(repo.branch ?? "HEAD")}?recursive=1`);
    const blobs = (data.tree ?? []).filter((e) => e.type === "blob" && typeof e.path === "string");
    const files = blobs.map((e) => e.path);
    const entries = blobs.filter((e) => typeof e.sha === "string" && e.sha.length > 0).map((e) => ({ path: e.path, sha: e.sha }));
    return { repo: `${repo.owner}/${repo.name}`, branch: repo.branch ?? "HEAD", files: files.slice(0, MAX_FILES), entries: entries.slice(0, MAX_FILES), truncated: Boolean(data.truncated) || files.length > MAX_FILES };
  }

  async function file(repo, filePath) {
    if (BINARY.test(filePath)) throw new GithubError(415, `${filePath} is not a text file`);
    const ref = repo.branch ? `?ref=${encodeURIComponent(repo.branch)}` : "";
    const data = await ask(repo, `contents/${filePath.split("/").map(encodeURIComponent).join("/")}${ref}`);
    if (data.type !== "file" || typeof data.content !== "string") throw new GithubError(415, `${filePath} is not a file`);
    const bytes = Buffer.from(data.content, "base64");
    if (bytes.subarray(0, 8000).includes(0)) throw new GithubError(415, `${filePath} is not a text file`);
    return { path: filePath, size: bytes.length, text: bytes.subarray(0, MAX_TEXT).toString("utf8"), truncated: bytes.length > MAX_TEXT };
  }

  return {
    async handle(req, res) {
      const url = new URL(req.url, "http://x");
      const repo = url.searchParams.get("repo") ?? "";
      const filePath = url.searchParams.get("path");
      if (!REPO.test(repo)) return send(res, 400, { error: "repo must be owner/name or owner/name@branch" });
      if (filePath !== null && (!filePath || filePath.startsWith("/") || filePath.split("/").includes(".."))) return send(res, 400, { error: "path must be a path inside the repo" });
      try {
        return send(res, 200, filePath === null ? await tree(parseRepo(repo)) : await file(parseRepo(repo), filePath));
      } catch (error) {
        if (error instanceof GithubError) return send(res, error.status, { error: error.message });
        throw error;
      }
    },
  };
}
