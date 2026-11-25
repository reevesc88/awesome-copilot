import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { releaseNotesShowcaseCanvas } from "../extensions/release-notes-showcase/releaseNotesShowcase.mjs";
import { startCanvasServer } from "../extensions/windows-app-storage-inspector-cleanup/src/api/server.mjs";
import { StorageService } from "../extensions/windows-app-storage-inspector-cleanup/src/core/storage-service.mjs";
import { ROOT_FOLDER } from "./constants.mjs";

const SUBPROCESS_TIMEOUT_MS = 15_000;
const SQLITE_EXEC_FLAGS = process.execArgv.filter(
  (arg) => arg === "--experimental-sqlite" || arg === "--no-experimental-sqlite",
);

const LOCAL_GIT_ENV_VARS = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_SUPER_PREFIX",
  "GIT_WORK_TREE",
]);

function isLocalGitEnvVar(key) {
  const upper = key.toUpperCase();
  return LOCAL_GIT_ENV_VARS.has(upper) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(upper);
}

function sanitizedGitEnv(baseEnv = process.env, overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined && !isLocalGitEnvVar(key)) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function runFixtureGit(cwd, args, extraEnv = {}) {
  const outcome = spawnSync("git", args, {
    cwd,
    env: sanitizedGitEnv(process.env, extraEnv),
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(
    outcome.status,
    0,
    outcome.stderr || outcome.error?.message || `git ${args.join(" ")} failed`,
  );
  return outcome;
}

function makeTempDir(t, prefix = "awesome-copilot-svc-wh-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function forceWindowsPlatform(t) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  t.after(() => {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  });
}

function installInMemoryServerHook(t, basePort = 49400) {
  const originalListen = net.Server.prototype.listen;
  const serversByOrigin = new Map();
  let nextPort = basePort;

  net.Server.prototype.listen = function mockListen(...args) {
    const callback = typeof args.at(-1) === "function" ? args.at(-1) : null;
    const assignedPort = nextPort++;
    const origin = `http://127.0.0.1:${assignedPort}`;
    serversByOrigin.set(origin, this);
    this.address = () => ({ address: "127.0.0.1", family: "IPv4", port: assignedPort });
    this.close = (closeCb) => {
      serversByOrigin.delete(origin);
      if (typeof closeCb === "function") queueMicrotask(closeCb);
      return this;
    };
    if (callback) queueMicrotask(callback);
    return this;
  };

  t.after(() => {
    net.Server.prototype.listen = originalListen;
    serversByOrigin.clear();
  });

  return {
    getServer(urlOrOrigin) {
      return serversByOrigin.get(new URL(urlOrOrigin).origin) ?? null;
    },
    get activeCount() {
      return serversByOrigin.size;
    },
  };
}

async function dispatchToServer(server, method, urlPath, { headers = {}, body = null } = {}) {
  const normalizedHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    normalizedHeaders[k.toLowerCase()] = v;
  }
  const chunks = body === null ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8")];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = urlPath;
  req.headers = normalizedHeaders;

  const res = new PassThrough();
  res.statusCode = 200;
  res.headers = {};
  res.headersSent = false;
  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = value;
  };
  res.writeHead = (status, hdrs = {}) => {
    res.statusCode = status;
    res.headersSent = true;
    for (const [k, v] of Object.entries(hdrs)) {
      res.headers[k.toLowerCase()] = v;
    }
    return res;
  };

  const bodyChunks = [];
  res.on("data", (chunk) => bodyChunks.push(Buffer.from(chunk)));
  const finished = new Promise((resolve) => {
    res.on("finish", resolve);
    res.on("end", resolve);
  });

  const listener = server.listeners("request")[0];
  await listener(req, res);
  await finished;

  const rawBody = Buffer.concat(bodyChunks);
  return {
    status: res.statusCode,
    headers: res.headers,
    text: rawBody.toString("utf8"),
    buffer: rawBody,
  };
}

test("storage-inspector StorageService enforces safety acknowledgements, scan/cleanup concurrency, single-use previews, and rescan recovery", async (t) => {
  forceWindowsPlatform(t);
  const dir = makeTempDir(t, "storage-svc-");
  const profileDir = path.join(dir, "UserProfile");
  const programDataDir = path.join(dir, "ProgramData");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(programDataDir, { recursive: true });

  const prevUserProfile = process.env.USERPROFILE;
  const prevProgramData = process.env.ProgramData;
  process.env.USERPROFILE = profileDir;
  process.env.ProgramData = programDataDir;
  t.after(() => {
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevProgramData === undefined) delete process.env.ProgramData;
    else process.env.ProgramData = prevProgramData;
  });

  let scanBehavior = "success";
  let scanCalls = 0;
  let executeCleanupCalls = 0;
  const fakeScanResult = {
    generatedAt: "2026-04-01T00:00:00Z",
    roots: [{ id: "profile", label: "User profile", path: profileDir }],
    summary: { filesScanned: 2, bytesScanned: 2048 },
    trees: [],
    directories: [{ path: profileDir, bytes: 2048, files: 2 }],
    largestFiles: [],
    largestDirectories: [],
    appSummaries: [],
    analyzerManagedPaths: [],
    candidates: [
      { id: "cand-1", path: path.join(profileDir, "temp.log"), bytes: 1024, cleanupEligible: true },
    ],
    warnings: [],
  };

  const categorizerStore = {
    all: async () => [],
    list: async () => ({ builtIn: [], custom: [] }),
    add: async (input) => ({ id: "cat-1", ...input }),
    remove: async (id) => ({ id }),
  };

  const svc = new StorageService({
    categorizerStore,
    discoverAnalyzerManagedPaths: async () => [],
    scanStorage: async ({ signal, onProgress }) => {
      scanCalls += 1;
      onProgress({
        phase: "scanning",
        currentDirectory: profileDir,
        directoriesScanned: 1,
        filesScanned: 1,
        bytesScanned: 512,
        warnings: 0,
        skippedReparsePoints: 0,
      });
      if (scanBehavior === "hang") {
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const err = new Error("Cancelled");
              err.code = "ABORT_ERR";
              reject(err);
            },
            { once: true },
          );
        });
      }
      if (scanBehavior === "fail") {
        const err = new Error("Disk read error");
        err.code = "scan_io_failed";
        throw err;
      }
      return fakeScanResult;
    },
    createCleanupPreview: async ({ itemIds, source, onProgress }) => {
      onProgress({ phase: "fingerprinting", completed: 1 });
      return {
        id: "prev-1",
        selectedIds: itemIds,
        source,
        totalBytes: 1024,
        entries: [{ id: "cand-1", path: path.join(profileDir, "temp.log"), size: 1024 }],
        analyzerProtectedPaths: [],
      };
    },
    executeCleanupPreview: async ({ onProgress }) => {
      executeCleanupCalls += 1;
      onProgress({ phase: "recycling", completed: 1 });
      return {
        reclaimedBytes: 1024,
        succeeded: [{ id: "cand-1" }],
        failed: [],
        unknown: [],
      };
    },
  });

  const emittedStates = [];
  const unsubscribe = svc.subscribe((state) => emittedStates.push(state.scan.status));

  // Pre-scan guards
  assert.throws(() => svc.getResults(), { code: "scan_results_unavailable" });
  assert.throws(() => svc.cancelScan(), { code: "scan_not_running" });
  await assert.rejects(() => svc.analyzeCustomAnalyzer("npm-cache"), {
    code: "scan_results_unavailable",
  });
  await assert.rejects(() => svc.executeAnalyzerCommand("npm-cache", "npm-cache-verify", false), {
    code: "scan_results_unavailable",
  });
  await assert.rejects(() => svc.inspectStorageItem(profileDir), {
    code: "scan_results_unavailable",
  });
  await assert.rejects(() => svc.setCleanupSafety({}), { code: "cleanup_safety_input_invalid" });
  await assert.rejects(() => svc.setCleanupSafety({ directCleanupEnabled: true }), {
    code: "cleanup_safety_acknowledgement_required",
  });
  await assert.rejects(() => svc.startScan({ scopes: ["bogus"] }), { code: "scan_scope_invalid" });

  // Unavailable roots guard when USERPROFILE is empty and only profile scope requested
  process.env.USERPROFILE = "";
  await assert.rejects(() => svc.startScan({ scopes: ["profile"] }), {
    code: "scan_roots_unavailable",
  });
  process.env.USERPROFILE = profileDir;

  // Hanging scan rejects concurrent mutations, then cancels cleanly
  scanBehavior = "hang";
  await svc.startScan({ scopes: ["profile"] });
  await assert.rejects(() => svc.setCleanupSafety({ directCleanupEnabled: false }), {
    code: "cleanup_safety_scan_running",
  });
  await assert.rejects(() => svc.addCategorizer({ name: "Logs" }), { code: "scan_already_running" });
  assert.deepEqual(svc.cancelScan(), { cancelling: true });
  assert.equal((await svc.waitForScan()).scan.status, "cancelled");

  // Failed scan surfaces structured error
  scanBehavior = "fail";
  await svc.startScan({ scopes: ["profile"] });
  const failedState = await svc.waitForScan();
  assert.equal(failedState.scan.status, "failed");
  assert.equal(failedState.scan.error.code, "scan_io_failed");

  // Successful scan + safety toggle auto-rescan
  scanBehavior = "success";
  await svc.startScan({ scopes: ["profile"] });
  await svc.waitForScan();
  assert.equal(svc.getState().hasResults, true);
  assert.equal(svc.getResults().summary.filesScanned, 2);

  const callsBeforeToggle = scanCalls;
  const toggled = await svc.setCleanupSafety({
    directCleanupEnabled: true,
    acknowledged: true,
    analyzerProtectionEnabled: false,
  });
  assert.equal(toggled.rescanStarted, true);
  await svc.waitForScan();
  assert.equal(scanCalls, callsBeforeToggle + 1);

  // Preview + executeCleanup single-use consumption + rescan failure tolerance
  await assert.rejects(
    () => svc.previewCleanup({ source: "invalid", itemIds: ["cand-1"] }),
    { code: "cleanup_source_invalid" },
  );
  const preview = await svc.previewCleanup({ source: "scan", itemIds: ["cand-1"] });
  assert.equal(svc.getState().cleanup.status, "awaiting-confirmation");
  await assert.rejects(() => svc.executeCleanup(preview.id, false), {
    code: "cleanup_confirmation_required",
  });

  // Force post-cleanup rescan to throw synchronously (missing USERPROFILE) so rescanError is captured without losing cleanup result
  process.env.USERPROFILE = "";
  const execOutcome = await svc.executeCleanup(preview.id, true);
  assert.equal(executeCleanupCalls, 1);
  assert.equal(execOutcome.reclaimedBytes, 1024);
  assert.equal(execOutcome.rescanStarted, false);
  assert.equal(execOutcome.rescanError.code, "scan_roots_unavailable");

  // Preview token was single-use
  process.env.USERPROFILE = profileDir;
  await assert.rejects(() => svc.executeCleanup(preview.id, true), {
    code: "cleanup_preview_unknown",
  });
  assert.equal(executeCleanupCalls, 1);

  // Analyzer cleanup re-verifies eligibility before execution (vscode-insiders folders branch)
  let folderEligible = true;
  svc.analyzeCustomAnalyzer = async (id) => ({
    id,
    folders: [
      {
        id: "vscode-version-deadbeef01",
        path: path.join(profileDir, "deadbeef01"),
        bytes: 4096,
        cleanupEligible: folderEligible,
      },
    ],
  });
  const analyzerPreview = await svc.previewCleanup({
    source: "analyzer",
    analyzerId: "vscode-insiders",
    itemIds: ["vscode-version-deadbeef01"],
  });
  folderEligible = false; // item becomes active/ineligible before executeCleanup
  await assert.rejects(() => svc.executeCleanup(analyzerPreview.id, true), {
    code: "cleanup_candidate_changed",
  });
  assert.equal(executeCleanupCalls, 1);
  assert.equal(svc.getState().cleanup.status, "failed");
  assert.equal(svc.getState().cleanup.error.code, "cleanup_candidate_changed");

  unsubscribe();
  assert.ok(emittedStates.includes("running"));
  assert.ok(emittedStates.includes("completed"));
});

test("storage-inspector startCanvasServer enforces host/token auth, body size limits, SSE streaming, and API routing offline", async (t) => {
  forceWindowsPlatform(t);
  const hook = installInMemoryServerHook(t, 49500);

  let stateListener = null;
  const fakeService = {
    subscribe(fn) {
      stateListener = fn;
      return () => {
        stateListener = null;
      };
    },
    getState: () => ({ scan: { status: "idle" } }),
    getResults: () => ({ summary: { filesScanned: 5 } }),
    listCategorizers: async () => ({ builtIn: [], custom: [] }),
    addCategorizer: async (body) => ({ categorizer: body, rescanStarted: true }),
    removeCategorizer: async (id) => ({ id, rescanStarted: true }),
    inspectStorageItem: async (p) => ({ path: p, kind: "directory" }),
    listCustomAnalyzers: () => [{ id: "npm-cache" }],
    analyzeCustomAnalyzer: async (id) => ({ id, bytes: 0 }),
    executeAnalyzerCommand: async (analyzerId, commandId) => ({ analyzerId, commandId, ok: true }),
    cancelAnalyzerCommand: () => ({ cancelled: true }),
    setCleanupSafety: async (input) => ({ safety: input, rescanStarted: false }),
    startScan: async (opts) => ({ scan: { status: "running", opts } }),
    cancelScan: () => ({ cancelling: true }),
    previewCleanup: async (input) => ({ id: "p-1", input }),
    executeCleanup: async (previewId) => ({ previewId, reclaimedBytes: 0 }),
  };

  const canvas = await startCanvasServer(
    fakeService,
    async (p) => ({ requested: p }),
    async () => ({ cancelled: true }),
  );
  t.after(() => canvas.close());

  const parsed = new URL(canvas.url);
  const canvasTok = parsed.searchParams.get("token");
  const server = hook.getServer(canvas.url);
  const hostHeaders = { host: parsed.host };
  const tokenHeaders = { host: parsed.host, "x-storage-inspector-token": canvasTok };

  // Spoofed Host -> 403; missing token -> 403
  assert.equal(
    (await dispatchToServer(server, "GET", parsed.pathname + parsed.search, { headers: { host: "evil" } }))
      .status,
    403,
  );
  assert.equal((await dispatchToServer(server, "GET", "/", { headers: hostHeaders })).status, 403);
  assert.equal(
    (await dispatchToServer(server, "GET", "/api/state", { headers: hostHeaders })).status,
    403,
  );

  // Valid HTML document + public GitHub SVG icon
  const htmlRes = await dispatchToServer(server, "GET", `/?token=${canvasTok}`, { headers: hostHeaders });
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.headers["content-security-policy"], /default-src 'self'/);

  const svgRes = await dispatchToServer(server, "GET", "/assets/github-mark-16.svg", {
    headers: hostHeaders,
  });
  assert.equal(svgRes.status, 200);
  assert.equal(svgRes.headers["content-type"], "image/svg+xml");

  // Header-authenticated API routes, invalid JSON 400, >1 MiB body 413, and 404
  const resultsRes = await dispatchToServer(server, "GET", "/api/results", { headers: tokenHeaders });
  assert.equal(resultsRes.status, 200);
  assert.equal(JSON.parse(resultsRes.text).summary.filesScanned, 5);

  const catPost = await dispatchToServer(server, "POST", "/api/categorizers", {
    headers: tokenHeaders,
    body: JSON.stringify({ name: "Custom" }),
  });
  assert.equal(catPost.status, 202);

  const badJson = await dispatchToServer(server, "POST", "/api/scan", {
    headers: tokenHeaders,
    body: "{corrupt",
  });
  assert.equal(badJson.status, 400);
  assert.equal(JSON.parse(badJson.text).code, "request_json_invalid");

  const hugeBody = await dispatchToServer(server, "POST", "/api/scan", {
    headers: tokenHeaders,
    body: Buffer.alloc(1_048_600, 0x61),
  });
  assert.equal(hugeBody.status, 413);
  assert.equal(JSON.parse(hugeBody.text).code, "request_too_large");

  const notFound = await dispatchToServer(server, "GET", "/api/unknown", { headers: tokenHeaders });
  assert.equal(notFound.status, 404);
  assert.equal(JSON.parse(notFound.text).code, "route_not_found");

  // SSE /events stream receives initial snapshot and pushed state updates
  const sseReq = Readable.from([]);
  sseReq.method = "GET";
  sseReq.url = `/events?token=${canvasTok}`;
  sseReq.headers = hostHeaders;
  const sseWrites = [];
  const sseRes = {
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    writeHead(code, hdrs) {
      this.statusCode = code;
      Object.assign(this.headers, hdrs);
    },
    write(chunk) {
      sseWrites.push(String(chunk));
    },
    end() {},
  };
  await server.listeners("request")[0](sseReq, sseRes);
  assert.equal(sseWrites.length, 1);
  stateListener?.({ scan: { status: "completed" } });
  assert.equal(sseWrites.length, 2);
  assert.match(sseWrites[1], /"completed"/);
  sseReq.emit("close");
});

test("work-hub config, SQLite/RPC session inventory, repo status ladder, focus scoring, and recommendations work offline", (t) => {
  const SQLITE_SKIP_STATUS = 42;
  const probeSqlite = spawnSync(
    process.execPath,
    [
      ...SQLITE_EXEC_FLAGS,
      "-e",
      `import("node:sqlite").then(() => process.exit(0), (err) => {
        if (err && (err.code === "ERR_UNKNOWN_BUILTIN_MODULE" || err.code === "MODULE_NOT_FOUND")) {
          process.exit(${SQLITE_SKIP_STATUS});
        }
        console.error(err);
        process.exit(1);
      })`,
    ],
    { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS },
  );
  if (probeSqlite.status === SQLITE_SKIP_STATUS && !probeSqlite.error && !probeSqlite.signal) {
    t.skip("node:sqlite is not available in this Node.js runtime");
    return;
  }
  assert.equal(
    probeSqlite.error ?? null,
    null,
    `node:sqlite probe spawn error: ${probeSqlite.error?.message ?? ""}\nstderr:\n${probeSqlite.stderr ?? ""}`,
  );
  assert.equal(
    probeSqlite.signal,
    null,
    `node:sqlite probe terminated by signal ${probeSqlite.signal}\nstderr:\n${probeSqlite.stderr ?? ""}`,
  );
  assert.equal(
    probeSqlite.status,
    0,
    `node:sqlite probe failed with status ${probeSqlite.status}\nstderr:\n${probeSqlite.stderr ?? ""}\nstdout:\n${probeSqlite.stdout ?? ""}`,
  );

  const fakeHome = makeTempDir(t, "wh-home-");
  const localHooksDir = path.join(fakeHome, "empty-git-hooks");

  // Create a real local git repository under ~/Projects/alpha-app so guessLocalPath + listLocalProjects + getLocalGitState run offline
  const localRepoDir = path.join(fakeHome, "Projects", "alpha-app");
  fs.mkdirSync(localRepoDir, { recursive: true });
  fs.mkdirSync(localHooksDir, { recursive: true });
  for (const gitArgs of [
    ["init", "-q"],
    ["config", "user.name", "Test User"],
    ["config", "user.email", "test@example.com"],
    ["config", "commit.gpgSign", "false"],
    ["config", "core.hooksPath", localHooksDir],
    ["remote", "add", "origin", "git@github.com:octo/alpha-app.git"],
  ]) {
    runFixtureGit(localRepoDir, gitArgs);
  }
  fs.writeFileSync(path.join(localRepoDir, "README.md"), "# Alpha\n", "utf8");
  runFixtureGit(localRepoDir, ["add", "README.md"]);
  runFixtureGit(localRepoDir, ["commit", "-q", "-m", "init"]);
  fs.writeFileSync(path.join(localRepoDir, "README.md"), "# Alpha dirty\n", "utf8"); // dirty tracked file

  const dataModuleUrl = pathToFileURL(
    path.join(ROOT_FOLDER, "extensions", "work-hub", "data.mjs"),
  ).href;
  const rendererModuleUrl = pathToFileURL(
    path.join(ROOT_FOLDER, "extensions", "work-hub", "renderer.mjs"),
  ).href;

  const childDriver = `
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Intercept execFile("gh", ...) in-process before loading work-hub so it can never fall through to a real GitHub CLI on any OS
const realExecFile = childProcess.execFile;
const ghCalls = [];

function argsEqual(actual, expected) {
  return actual.length === expected.length && actual.every((val, idx) => val === expected[idx]);
}

function handleFakeGh(args) {
  ghCalls.push(args);
  const nowIso = new Date().toISOString();
  const oldIso = "2024-01-10T00:00:00Z";

  if (argsEqual(args, ["api", "user"])) {
    return { code: 0, stdout: JSON.stringify({ login: "james" }), stderr: "" };
  }
  if (
    args[0] === "repo" &&
    args[1] === "list" &&
    (args[2] === "octo" || args[2] === "james") &&
    argsEqual(args.slice(3), [
      "--limit",
      "100",
      "--json",
      "nameWithOwner,description,pushedAt,isArchived,isPrivate,isFork,stargazerCount",
    ])
  ) {
    const rows =
      args[2] === "octo"
        ? [{ nameWithOwner: "octo/alpha-app", description: "Alpha", pushedAt: nowIso, stargazerCount: 12 }]
        : [{ nameWithOwner: "james/notes", description: "Notes", pushedAt: oldIso, stargazerCount: 1 }];
    return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
  }
  if (argsEqual(args, ["api", "repos/octo/alpha-app"])) {
    return {
      code: 0,
      stdout: JSON.stringify({
        html_url: "https://github.com/octo/alpha-app",
        description: "Alpha service",
        default_branch: "main",
        archived: false,
        private: false,
        language: "TypeScript",
        stargazers_count: 12,
        pushed_at: nowIso,
      }),
      stderr: "",
    };
  }
  if (argsEqual(args, ["api", "repos/octo/alpha-app/releases/latest"])) {
    return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
  }
  if (argsEqual(args, ["api", "repos/octo/alpha-app/tags?per_page=1"])) {
    return {
      code: 0,
      stdout: JSON.stringify([{ name: "v0.1.0", commit: { committer: { date: oldIso } } }]),
      stderr: "",
    };
  }
  if (
    argsEqual(args, [
      "pr",
      "list",
      "--repo",
      "octo/alpha-app",
      "--state",
      "open",
      "--limit",
      "50",
      "--json",
      "number,title,author,updatedAt,createdAt,isDraft,reviewDecision,url,headRefName,baseRefName,statusCheckRollup,labels,assignees",
    ])
  ) {
    return {
      code: 0,
      stdout: JSON.stringify([
        {
          number: 14,
          title: "Fix memory leak",
          author: { login: "contributor" },
          createdAt: nowIso,
          updatedAt: nowIso,
          isDraft: false,
          reviewDecision: "REVIEW_REQUIRED",
          assignees: [{ login: "james" }],
          statusCheckRollup: [{ conclusion: "FAILURE" }],
          labels: [{ name: "bug" }],
          headRefName: "fix/leak",
          baseRefName: "main",
        },
      ]),
      stderr: "",
    };
  }
  if (
    argsEqual(args, [
      "issue",
      "list",
      "--repo",
      "octo/alpha-app",
      "--state",
      "open",
      "--limit",
      "50",
      "--json",
      "number,title,author,updatedAt,createdAt,url,labels,assignees,comments",
    ])
  ) {
    return {
      code: 0,
      stdout: JSON.stringify([
        {
          number: 22,
          title: "Add export endpoint",
          author: { login: "customer" },
          createdAt: nowIso,
          updatedAt: nowIso,
          assignees: [{ login: "james" }],
          labels: [{ name: "enhancement" }],
          comments: 4,
        },
      ]),
      stderr: "",
    };
  }
  if (argsEqual(args, ["api", "repos/octo/alpha-app/deployments?per_page=30"])) {
    return {
      code: 0,
      stdout: JSON.stringify([
        { id: 901, environment: "production", ref: "main", created_at: nowIso, production_environment: true },
      ]),
      stderr: "",
    };
  }
  if (argsEqual(args, ["api", "repos/octo/alpha-app/deployments/901/statuses?per_page=1"])) {
    return {
      code: 0,
      stdout: JSON.stringify([{ state: "failure", environment_url: "https://alpha.example.com" }]),
      stderr: "",
    };
  }
  if (
    argsEqual(args, [
      "api",
      "--method",
      "POST",
      "repos/octo/alpha-app/pulls/14/requested_reviewers",
      "-f",
      "reviewers[]=copilot-pull-request-reviewer[bot]",
    ])
  ) {
    return { code: 0, stdout: "{}", stderr: "" };
  }
  if (argsEqual(args, ["pr", "review", "14", "--repo", "octo/alpha-app", "--approve"])) {
    return { code: 0, stdout: "Approved PR #14\\n", stderr: "" };
  }
  return { code: 1, stdout: "", stderr: \`Unexpected gh args: \${JSON.stringify(args)}\` };
}

childProcess.execFile = function patchedExecFile(file, args, options, callback) {
  let opts = options;
  let cb = callback;
  if (typeof opts === "function") {
    cb = opts;
    opts = {};
  }
  const normalizedArgs = Array.isArray(args) ? args : [];
  if (file === "gh") {
    queueMicrotask(() => {
      const outcome = handleFakeGh(normalizedArgs);
      if (outcome.code === 0) {
        cb?.(null, outcome.stdout, outcome.stderr);
        return;
      }
      const err = Object.assign(new Error(outcome.stderr || \`gh exited \${outcome.code}\`), {
        code: outcome.code,
      });
      cb?.(err, outcome.stdout, outcome.stderr);
    });
    return { kill() {} };
  }
  if (file !== "git") {
    queueMicrotask(() => {
      const err = Object.assign(new Error(\`Unexpected external command: \${file}\`), { code: "ENOENT" });
      cb?.(err, "", err.message);
    });
    return { kill() {} };
  }
  return realExecFile.call(this, file, normalizedArgs, opts, cb);
};
syncBuiltinESMExports();

const workHub = await import(${JSON.stringify(dataModuleUrl)});
const { renderHtml } = await import(${JSON.stringify(rendererModuleUrl)});

// 1. Corrupt config falls back to default, then addRepos/removeRepos deduplicate and clamp weight
const copilotDir = path.join(os.homedir(), ".copilot");
const artifactDir = path.join(copilotDir, "extensions", "work-hub", "artifacts");
fs.mkdirSync(artifactDir, { recursive: true });
fs.writeFileSync(path.join(artifactDir, "config.json"), "{corrupt", "utf8");
const recovered = await workHub.readConfig();
assert.deepEqual(recovered, { repos: [], onboarded: false });

await workHub.setTrackedRepos([
  { slug: "octo/alpha-app", weight: 99 },
  "OCTO/ALPHA-APP",
  "octo/beta-lib",
]);
const afterRemove = await workHub.removeRepos("octo/beta-lib");
assert.equal(afterRemove.repos.length, 1);
assert.equal(afterRemove.repos[0].weight, 3); // clamped to 3
assert.ok(afterRemove.repos[0].path?.endsWith("alpha-app"));

// 2. Discover local git projects + gh repo list + 5-min cache
const discovered = await workHub.listAvailableRepos(true);
assert.equal(discovered.projects.length, 1);
assert.equal(discovered.projects[0].slug, "octo/alpha-app");
assert.equal(discovered.projects[0].tracked, true);
assert.deepEqual(
  discovered.repos.map((r) => ({ slug: r.slug, tracked: r.tracked })),
  [
    { slug: "octo/alpha-app", tracked: true },
    { slug: "james/notes", tracked: false },
  ],
);

// 3. Populate SQLite ~/.copilot/data.db with active, stale, orphan-worktree, and archived workspaces
const dbPath = path.join(copilotDir, "data.db");
const db = new DatabaseSync(dbPath);
db.exec(\`
  CREATE TABLE projects (id TEXT PRIMARY KEY, github_owner TEXT, github_repo TEXT, name TEXT, main_repo_path TEXT);
  CREATE TABLE worktrees (id TEXT PRIMARY KEY, path TEXT);
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    worktree_id TEXT,
    name TEXT,
    branch TEXT,
    created_at TEXT,
    updated_at TEXT,
    archived_at TEXT,
    session_id TEXT,
    workspace_type TEXT,
    source_pr_repo_full_name TEXT,
    source_issue_repo_full_name TEXT,
    created_pr_repo_full_name TEXT
  );
\`);
const nowIso = new Date().toISOString();
const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
const fortyDaysAgo = new Date(Date.now() - 40 * 86400000).toISOString();
db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?)").run("p1", "octo", "alpha-app", "alpha-app", "");
db.prepare("INSERT INTO worktrees VALUES (?, ?)").run("wt-missing", path.join(os.homedir(), "Projects", "copilot-worktrees", "alpha", "gone"));
const insWs = db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
insWs.run("ws-1", "p1", "wt-missing", "Fix leak session", "fix/leak", threeDaysAgo, threeDaysAgo, null, "sess-1", "worktree", null, null, null);
insWs.run("ws-ancient", "p1", null, "Old session", "chore/old", fortyDaysAgo, fortyDaysAgo, null, "sess-2", "local", null, null, null);
insWs.run("ws-archived", "p1", null, "Archived", "feat/done", nowIso, nowIso, nowIso, "sess-3", "local", null, null, null);
db.close();

await workHub.setFocusContext({ mood: "urgent", minutes: 60, busyness: "normal", focusIntent: "prs" });
const dashboard = await workHub.collectDashboardState(true);

assert.equal(dashboard.onboarded, true);
assert.equal(dashboard.currentLogin, "james");
assert.equal(dashboard.repos[0].status.label, "Deploy failed");
assert.equal(dashboard.repos[0].localGit.dirtyCount, 1);
assert.equal(dashboard.sessionInventory.length, 2); // archived excluded
assert.equal(dashboard.sessionInventory.find((s) => s.id === "ws-1")?.orphaned, true);
assert.equal(dashboard.sessionInventory.find((s) => s.id === "ws-ancient")?.bucket, "ancient");
assert.equal(dashboard.sessions.length, 1); // >14-day ancient session excluded from active sessions
assert.equal(dashboard.recommendations[0].kind, "pr"); // prs intent + urgent mood + failing checks boosts PR #14 to #1

// 4. Remove data.db and verify runtime RPC session fallback via setCopilotSession
fs.rmSync(dbPath, { force: true });
workHub.setCopilotSession({
  rpc: {
    sessions: {
      async list() {
        return {
          sessions: [
            { sessionId: "rpc-remote", isRemote: true, context: { repository: "octo/alpha-app" } },
            { sessionId: "rpc-local", modifiedTime: nowIso, name: "RPC Triage", context: { repository: "octo/alpha-app", branch: "feat/rpc" } },
          ],
        };
      },
    },
  },
});
const rpcDashboard = await workHub.collectDashboardState(true);
assert.equal(rpcDashboard.sessionInventory.length, 1);
assert.equal(rpcDashboard.sessionInventory[0].id, "rpc-local");

// 5. Copilot review & approve item actions + renderer output
const callsBeforeActions = ghCalls.length;
const reviewAction = await workHub.runItemAction({
  repo: "octo/alpha-app",
  type: "pr",
  number: 14,
  action: "copilot-review",
});
assert.equal(reviewAction.ok, true);
const approveAction = await workHub.runItemAction({
  repo: "octo/alpha-app",
  type: "pr",
  number: 14,
  action: "approve",
});
assert.equal(approveAction.ok, true);
assert.deepEqual(ghCalls.slice(callsBeforeActions), [
  [
    "api",
    "--method",
    "POST",
    "repos/octo/alpha-app/pulls/14/requested_reviewers",
    "-f",
    "reviewers[]=copilot-pull-request-reviewer[bot]",
  ],
  ["pr", "review", "14", "--repo", "octo/alpha-app", "--approve"],
]);
await assert.rejects(
  () =>
    workHub.runItemAction({
      repo: "octo/alpha-app",
      type: "pr",
      number: 999,
      action: "approve",
    }),
  /Unexpected gh args/,
);
assert.equal(renderHtml().includes("<title>Work Hub</title>"), true);
console.log("WORK_HUB_OK");
`;

  const childRun = spawnSync(
    process.execPath,
    [...SQLITE_EXEC_FLAGS, "--input-type=module", "-e", childDriver],
    {
      env: sanitizedGitEnv(process.env, {
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      }),
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT_MS,
    },
  );
  assert.equal(childRun.status, 0, `stderr:\n${childRun.stderr}\nstdout:\n${childRun.stdout}`);
  assert.match(childRun.stdout, /WORK_HUB_OK/);
});

test("release-notes-showcase canvas normalizes release stories, classifies git tag/unreleased history, and exports HTML/text emails offline", async (t) => {
  const hook = installInMemoryServerHook(t, 49600);
  const origFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("COPILOT_GH_ACCOUNT_") || isLocalGitEnvVar(key)) {
      delete process.env[key];
    }
  }
  delete process.env.GITHUB_TOKEN;
  delete process.env.SESSION_ID;
  delete process.env.COPILOT_AGENT_SESSION_ID;
  t.after(async () => {
    globalThis.fetch = origFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value !== undefined) process.env[key] = value;
    }
    await releaseNotesShowcaseCanvas.onClose({ instanceId: "rn-1" });
  });

  // Actions before open() throw CanvasError("canvas_state_missing")
  const exportAction = releaseNotesShowcaseCanvas.actionHandlers.get("export_email");
  const snapshotAction = releaseNotesShowcaseCanvas.actionHandlers.get("get_release_snapshot");
  await assert.rejects(() => exportAction({ instanceId: "rn-missing", input: {} }), {
    code: "canvas_state_missing",
  });
  await assert.rejects(() => snapshotAction({ instanceId: "rn-missing", input: {} }), {
    code: "canvas_state_missing",
  });

  // Create a real local git repository with remote origin, two tags, and unreleased commits
  const repoDir = makeTempDir(t, "rn-git-repo-");
  const repoHooksDir = makeTempDir(t, "rn-git-hooks-");
  const runGitInit = (args, extraEnv = {}) => {
    runFixtureGit(repoDir, args, extraEnv);
  };
  runGitInit(["init", "-q"]);
  runGitInit(["config", "user.name", "Ada Lovelace"]);
  runGitInit(["config", "user.email", "ada@example.com"]);
  runGitInit(["config", "commit.gpgSign", "false"]);
  runGitInit(["config", "tag.gpgSign", "false"]);
  runGitInit(["config", "core.hooksPath", repoHooksDir]);
  runGitInit(["remote", "add", "origin", "https://github.com/octo-org/rocket-kit.git"]);

  fs.writeFileSync(path.join(repoDir, "a.txt"), "v1\n", "utf8");
  runGitInit(["add", "a.txt"]);
  runGitInit(["commit", "-q", "-m", "feat: initial launch (#1)"], {
    GIT_AUTHOR_DATE: "2026-03-01T10:00:00Z",
    GIT_COMMITTER_DATE: "2026-03-01T10:00:00Z",
  });
  runGitInit(["tag", "v1.0.0"]);

  fs.writeFileSync(path.join(repoDir, "a.txt"), "v1.1\n", "utf8");
  runGitInit(["add", "a.txt"]);
  runGitInit(["commit", "-q", "-m", "fix(core): stabilize retry loop (#2)"], {
    GIT_AUTHOR_DATE: "2026-03-10T10:00:00Z",
    GIT_COMMITTER_DATE: "2026-03-10T10:00:00Z",
  });
  runGitInit(["tag", "v1.1.0"]);

  fs.writeFileSync(path.join(repoDir, "a.txt"), "vNext\n", "utf8");
  runGitInit(["add", "a.txt"]);
  runGitInit(["commit", "-q", "-m", "feat: add streaming export (#5)"], {
    GIT_AUTHOR_DATE: "2026-03-20T10:00:00Z",
    GIT_COMMITTER_DATE: "2026-03-20T10:00:00Z",
  });
  fs.writeFileSync(path.join(repoDir, "b.txt"), "docs\n", "utf8");
  runGitInit(["add", "b.txt"]);
  runGitInit(["commit", "-q", "-m", "docs: update changelog"], {
    GIT_AUTHOR_DATE: "2026-03-21T10:00:00Z",
    GIT_COMMITTER_DATE: "2026-03-21T10:00:00Z",
  });

  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/pulls")) {
      return {
        ok: true,
        json: async () => [
          { number: 5, title: "Streaming export", merged_at: "2026-03-20T12:00:00Z" },
          { number: 6, title: "Closed unmerged", merged_at: null },
        ],
      };
    }
    if (parsed.pathname.endsWith("/issues")) {
      return {
        ok: true,
        json: async () => [
          { number: 9, title: "Export format request", closed_at: "2026-03-21T08:00:00Z" },
          { number: 5, title: "PR shadow issue", closed_at: "2026-03-20T12:00:00Z", pull_request: {} },
        ],
      };
    }
    return { ok: false, json: async () => [] };
  };

  const opened = await releaseNotesShowcaseCanvas.open({
    instanceId: "rn-1",
    session: { workingDirectory: repoDir },
    input: {
      version: "v2.0.0",
      sections: [
        {
          title: "Fast <Search>",
          kind: "feature",
          summary: "Sub-millisecond indexing",
          metric: "3x faster",
          bullets: ["Instant lookup"],
        },
      ],
      contributors: [{ name: "Ada Lovelace", githubHandle: "ada", area: "Core", summary: "Search" }],
      communityThanks: ["@grace", "  linus  ", ""],
      otherChanges: [{ label: "Docs", text: "Added migration guide" }],
    },
  });

  assert.equal(opened.title, "Rocket Kit v2.0.0");
  assert.equal(opened.status, "1 contributors highlighted");

  const snap = await snapshotAction({ instanceId: "rn-1" });
  assert.deepEqual(snap.contributors, ["Ada Lovelace"]);
  assert.equal(snap.sections[0].title, "Fast <Search>");

  const htmlOnly = await exportAction({ instanceId: "rn-1", input: { format: "html" } });
  assert.equal("text" in htmlOnly, false);
  assert.match(htmlOnly.html, /Fast &lt;Search&gt;/); // HTML-escaped
  assert.match(htmlOnly.html, /@grace/);
  assert.match(htmlOnly.html, /@linus/);
  assert.equal(htmlOnly.fileNameBase, "rocket-kit-v2-0-0-release-notes-email");

  const textOnly = await exportAction({ instanceId: "rn-1", input: { format: "text" } });
  assert.equal("html" in textOnly, false);
  assert.match(textOnly.text, /Community thanks: @grace, @linus/);

  // Exercise canvas HTTP routes: /, /actions/release-options, /actions/load-release (tag + unreleased + invalid), 404
  const server = hook.getServer(opened.url);
  assert.equal((await dispatchToServer(server, "GET", "/")).status, 200);

  const optsRes = await dispatchToServer(server, "GET", "/actions/release-options");
  const optsJson = JSON.parse(optsRes.text);
  assert.equal(optsJson.repository, "octo-org/rocket-kit");
  assert.equal(optsJson.tags.length, 2);

  assert.equal(
    (
      await dispatchToServer(server, "POST", "/actions/load-release", {
        body: JSON.stringify({ mode: "invalid" }),
      })
    ).status,
    400,
  );

  const tagLoad = await dispatchToServer(server, "POST", "/actions/load-release", {
    body: JSON.stringify({ mode: "tag", tag: "v1.1.0" }),
  });
  assert.equal(tagLoad.status, 200);
  assert.equal(JSON.parse(tagLoad.text).title, "Rocket Kit v1.1.0");
  const tagSnap = await snapshotAction({ instanceId: "rn-1" });
  assert.equal(tagSnap.sections[0].kind, "improvement"); // "fix(core): stabilize retry loop"

  const unreleasedLoad = await dispatchToServer(server, "POST", "/actions/load-release", {
    body: JSON.stringify({ mode: "unreleased" }),
  });
  assert.equal(unreleasedLoad.status, 200);
  const unreleasedBoth = await exportAction({ instanceId: "rn-1", input: { format: "both" } });
  assert.match(unreleasedBoth.text, /#5 Streaming export/);
  assert.match(unreleasedBoth.text, /Issue #9: Export format request/);
  assert.equal(unreleasedBoth.text.includes("Closed unmerged"), false);
  assert.equal(unreleasedBoth.text.includes("PR shadow issue"), false);

  assert.equal((await dispatchToServer(server, "GET", "/unknown")).status, 404);

  await releaseNotesShowcaseCanvas.onClose({ instanceId: "rn-1" });
  assert.equal(hook.activeCount, 0);
});
