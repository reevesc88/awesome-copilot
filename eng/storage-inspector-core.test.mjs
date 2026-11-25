import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  listCustomAnalyzers,
  runCustomAnalyzer,
} from "../extensions/windows-app-storage-inspector-cleanup/src/analyzers/custom-analyzers.mjs";
import {
  createAnalyzerCommandRunner,
  getAnalyzerCommands,
} from "../extensions/windows-app-storage-inspector-cleanup/src/core/analyzer-commands.mjs";
import {
  BUILT_IN_CATEGORIZERS,
  CategorizerStore,
  findCategorizer,
} from "../extensions/windows-app-storage-inspector-cleanup/src/core/categorizers.mjs";
import {
  createCleanupPreview,
  executeCleanupPreview,
} from "../extensions/windows-app-storage-inspector-cleanup/src/core/cleanup.mjs";
import { inspectStorageItem } from "../extensions/windows-app-storage-inspector-cleanup/src/core/item-inspector.mjs";
import {
  WINDOWS_ONLY_MESSAGE,
  assertWindowsPlatform,
  createWindowsOnlyError,
  isWindowsPlatform,
} from "../extensions/windows-app-storage-inspector-cleanup/src/core/platform.mjs";
import {
  getDefaultRoots,
  scanStorage,
  toPublicScanResult,
} from "../extensions/windows-app-storage-inspector-cleanup/src/core/scanner.mjs";
import {
  containsPath,
  findTreeStackForPath,
  getParentPath,
  normalizePath,
} from "../extensions/windows-app-storage-inspector-cleanup/src/ui/tree-navigation.mjs";

function makeTempDir(t, prefix = "awesome-copilot-storage-core-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("storage-inspector tree-navigation, platform guards, and custom-analyzer registry enforce invariants", async () => {
  assert.equal(normalizePath("C:/Users/Alice/Cache///"), "c:\\users\\alice\\cache");
  assert.equal(normalizePath(null), "");

  assert.equal(containsPath("", "C:\\Users\\Alice"), true);
  assert.equal(containsPath("C:\\Users\\Alice", "c:/users/alice/appdata"), true);
  assert.equal(containsPath("C:\\Users\\Alice", "C:\\Users\\Alice2\\appdata"), false);

  assert.equal(getParentPath("C:/Users/Alice/Cache/item.bin"), "C:\\Users\\Alice\\Cache");
  assert.equal(getParentPath("C:\\top.bin"), "C:\\");
  assert.equal(getParentPath("relative-only"), "relative-only");

  const tree = {
    name: "Scanned storage",
    path: "",
    children: [
      {
        name: "Other (3 folders)",
        path: "C:\\Users\\Alice\\*",
        aggregate: true,
        children: [{ name: "Hidden", path: "C:\\Users\\Alice\\Hidden", children: [] }],
      },
      {
        name: "Profile",
        path: "C:\\Users\\Alice",
        children: [{ name: "Cache", path: "C:\\Users\\Alice\\Cache", children: [] }],
      },
    ],
  };
  assert.deepEqual(findTreeStackForPath(null, "C:\\Users\\Alice"), []);
  assert.deepEqual(findTreeStackForPath(tree, ""), []);
  assert.deepEqual(
    findTreeStackForPath(tree, "c:/users/alice/cache/sub/data.db").map((n) => n.name),
    ["Scanned storage", "Profile", "Cache"],
  );
  // Aggregate sibling node is skipped even if its prefix looks similar
  assert.deepEqual(
    findTreeStackForPath(tree, "C:\\Users\\Alice\\Hidden\\file.txt").map((n) => n.name),
    ["Scanned storage", "Profile"],
  );

  assert.equal(isWindowsPlatform("win32"), true);
  assert.equal(isWindowsPlatform("darwin"), false);
  const winErr = createWindowsOnlyError();
  assert.equal(winErr.code, "windows_only");
  assert.equal(winErr.message, WINDOWS_ONLY_MESSAGE);
  assert.doesNotThrow(() => assertWindowsPlatform("win32"));
  assert.throws(() => assertWindowsPlatform("linux"), { code: "windows_only" });

  const listed = listCustomAnalyzers();
  assert.equal(listed.length, 5);
  assert.equal("analyze" in listed[0], false);
  await assert.rejects(runCustomAnalyzer("unknown-id", {}), { code: "analyzer_unknown" });
});

test("storage-inspector CategorizerStore validates paths/inputs, persists atomically, and resolves longest-match rules", async (t) => {
  const dir = makeTempDir(t, "categorizer-store-");
  const rootDir = path.join(dir, "root");
  const outsideDir = path.join(dir, "outside");
  const appDir = path.join(rootDir, "AppData", "Local", "AcmeStudio");
  const subCacheDir = path.join(appDir, "ShaderCache");
  fs.mkdirSync(subCacheDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  const storePath = path.join(dir, "state", "categorizers.json");
  const store = new CategorizerStore({ storagePath: storePath });
  const approvedRoots = [{ id: "profile", path: rootDir }];

  // Missing backing file initializes cleanly to empty custom list
  const initial = await store.list();
  assert.equal(initial.builtIn.length, BUILT_IN_CATEGORIZERS.length);
  assert.deepEqual(initial.custom, []);

  // Input & path validation rejections
  await assert.rejects(
    store.add({ path: "", name: "Acme", category: "Cache", approvedRoots }),
    { code: "categorizer_input_invalid" },
  );
  await assert.rejects(
    store.add({ path: "relative/path", name: "Acme", category: "Cache", approvedRoots }),
    { code: "categorizer_path_invalid" },
  );
  await assert.rejects(
    store.add({ path: outsideDir, name: "Acme", category: "Cache", approvedRoots }),
    { code: "categorizer_path_not_allowed" },
  );
  await assert.rejects(
    store.add({ path: path.join(rootDir, "missing"), name: "Acme", category: "Cache", approvedRoots }),
    { code: "categorizer_path_unavailable" },
  );
  await assert.rejects(
    store.add({ path: appDir, name: "   ", category: "Cache", approvedRoots }),
    { code: "categorizer_input_invalid" },
  );
  await assert.rejects(
    store.add({ path: appDir, name: "x".repeat(121), category: "Cache", approvedRoots }),
    { code: "categorizer_input_invalid" },
  );

  if (process.platform !== "win32") {
    const symlinkPath = path.join(rootDir, "linked-dir");
    fs.symlinkSync(appDir, symlinkPath);
    await assert.rejects(
      store.add({ path: symlinkPath, name: "Link", category: "Cache", approvedRoots }),
      { code: "categorizer_path_invalid" },
    );
  }

  // Add parent + nested rules; verify longest-value match wins and duplicate path is rejected
  const parentRule = await store.add({
    path: appDir,
    name: "Acme Studio",
    category: "IDE data",
    description: "  Workspace indexes  ",
    approvedRoots,
  });
  const nestedRule = await store.add({
    path: subCacheDir,
    name: "Acme Shaders",
    category: "GPU cache",
    approvedRoots,
  });
  assert.equal(parentRule.description, "Workspace indexes");
  assert.equal(nestedRule.description, undefined);

  await assert.rejects(
    store.add({ path: appDir, name: "Duplicate", category: "Cache", approvedRoots }),
    { code: "categorizer_duplicate" },
  );

  const allRules = await store.all();
  const matchedNested = findCategorizer(path.join(subCacheDir, "pipeline.bin"), allRules);
  assert.equal(matchedNested?.name, "Acme Shaders");
  const matchedParent = findCategorizer(path.join(appDir, "settings.json"), allRules);
  assert.equal(matchedParent?.name, "Acme Studio");
  // Built-in token match works with or without trailing backslash
  const matchedBuiltIn = findCategorizer("C:/Users/Dev/.foundry/cache", allRules);
  assert.equal(matchedBuiltIn?.id, "built-in-foundry-local-model-cache");

  // Reload from disk in a fresh store instance and remove rule
  const reloadedStore = new CategorizerStore({ storagePath: storePath });
  assert.equal((await reloadedStore.list()).custom.length, 2);
  await assert.rejects(reloadedStore.remove("nonexistent-id"), { code: "categorizer_unknown" });
  const removed = await reloadedStore.remove(parentRule.id);
  assert.equal(removed.id, parentRule.id);
  assert.equal((await reloadedStore.list()).custom.length, 1);

  // Corrupt JSON and unsupported version surface categorizer_store_invalid
  const badVersionPath = path.join(dir, "bad-version.json");
  fs.writeFileSync(badVersionPath, JSON.stringify({ version: 99, rules: [] }), "utf8");
  await assert.rejects(new CategorizerStore({ storagePath: badVersionPath }).list(), {
    code: "categorizer_store_invalid",
  });

  const badJsonPath = path.join(dir, "bad-json.json");
  fs.writeFileSync(badJsonPath, "{corrupt", "utf8");
  await assert.rejects(new CategorizerStore({ storagePath: badJsonPath }).list(), {
    code: "categorizer_store_invalid",
  });
});

test("storage-inspector inspectStorageItem enforces root boundaries, summarizes extensions, and truncates large directories", async (t) => {
  const dir = makeTempDir(t, "item-inspector-");
  const rootDir = path.join(dir, "root");
  const outsideDir = path.join(dir, "outside");
  const bigFolder = path.join(rootDir, "AppData", "Local", "GitHub Copilot", "Logs");
  fs.mkdirSync(bigFolder, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  // Populate 105 files across extensions to exercise >100 truncation + 24 sample cap + tie-break sorting
  for (let i = 0; i < 60; i += 1) {
    fs.writeFileSync(path.join(bigFolder, `trace-${String(i).padStart(3, "0")}.log`), "log");
  }
  for (let i = 0; i < 25; i += 1) {
    fs.writeFileSync(path.join(bigFolder, `dump-${String(i).padStart(3, "0")}.json`), "{}");
  }
  for (let i = 0; i < 20; i += 1) {
    fs.writeFileSync(path.join(bigFolder, `README_${String(i).padStart(3, "0")}`), "raw");
  }

  const roots = [{ id: "profile", path: rootDir }];
  await assert.rejects(inspectStorageItem({ targetPath: "  ", roots }), {
    code: "inspection_path_required",
  });
  await assert.rejects(inspectStorageItem({ targetPath: outsideDir, roots }), {
    code: "inspection_path_not_allowed",
  });
  await assert.rejects(
    inspectStorageItem({ targetPath: path.join(rootDir, "missing.bin"), roots }),
    { code: "inspection_path_unavailable" },
  );
  await assert.rejects(
    inspectStorageItem({
      targetPath: bigFolder,
      roots: [
        { id: "profile", path: rootDir },
        { id: "gone", path: path.join(dir, "missing-root") },
      ],
    }),
    { code: "inspection_root_unavailable" },
  );

  if (process.platform !== "win32") {
    const symlinkInside = path.join(rootDir, "escape-link");
    fs.symlinkSync(outsideDir, symlinkInside);
    await assert.rejects(inspectStorageItem({ targetPath: symlinkInside, roots }), {
      code: "inspection_path_invalid",
    });

    // Child path traversed THROUGH a symlinked parent resolves outside canonical root
    fs.writeFileSync(path.join(outsideDir, "secret-note.txt"), "outside");
    await assert.rejects(
      inspectStorageItem({ targetPath: path.join(symlinkInside, "secret-note.txt"), roots }),
      { code: "inspection_path_not_allowed" },
    );
  }

  const inspection = await inspectStorageItem({
    targetPath: bigFolder,
    roots,
    result: {
      directories: [{ path: bigFolder, bytes: 12_345, files: 105 }],
      largestFiles: [],
    },
    categorizers: BUILT_IN_CATEGORIZERS,
  });

  assert.equal(inspection.itemType, "folder");
  assert.equal(inspection.bytes, 12_345);
  assert.equal(inspection.files, 105);
  assert.equal(inspection.app, "GitHub Copilot");
  assert.equal(inspection.categorizer?.cleanupPolicy, "automatic");
  assert.equal(inspection.directContents.entriesScanned, 100);
  assert.equal(inspection.directContents.truncated, true);
  assert.equal(inspection.directContents.samples.length, 24);
  assert.ok(inspection.directContents.fileExtensions.length >= 2);
  assert.ok(inspection.researchTerms.includes("GitHub Copilot"));
});

test("storage-inspector analyzer-commands redacts executables and enforces confirmation, concurrency, and cancellation", async () => {
  assert.deepEqual(getAnalyzerCommands("nonexistent"), []);
  const uvCmds = getAnalyzerCommands("uv-cache");
  assert.equal(uvCmds.length, 3);
  for (const cmd of uvCmds) {
    assert.equal("executable" in cmd, false);
    assert.equal("arguments" in cmd, false);
  }

  // Idle cancel returns idle; non-cancellable active command throws analyzer_command_cancellation_unavailable
  let releaseNonCancellable;
  const nonCancellableRunner = createAnalyzerCommandRunner({
    executeProcess: () =>
      new Promise((resolve) => {
        releaseNonCancellable = resolve;
      }),
  });
  assert.deepEqual(nonCancellableRunner.cancel(), { status: "idle" });

  await assert.rejects(
    nonCancellableRunner.execute("unknown-analyzer", "cmd"),
    { code: "analyzer_command_unknown" },
  );
  await assert.rejects(
    nonCancellableRunner.execute("uv-cache", "unknown-cmd"),
    { code: "analyzer_command_unknown" },
  );
  await assert.rejects(
    nonCancellableRunner.execute("uv-cache", "uv-cache-clean", false),
    { code: "analyzer_command_confirmation_required" },
  );

  const pendingExec = nonCancellableRunner.execute("uv-cache", "uv-cache-clean", true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => nonCancellableRunner.cancel(), {
    code: "analyzer_command_cancellation_unavailable",
  });
  await assert.rejects(
    nonCancellableRunner.execute("docker-images", "docker-system-df"),
    { code: "analyzer_command_running" },
  );
  releaseNonCancellable({ stdout: "", stderr: "cleaned from stderr" });
  const finished = await pendingExec;
  assert.equal(finished.status, "completed");
  assert.equal(finished.output, "cleaned from stderr");
  assert.equal(nonCancellableRunner.getActiveCommand(), undefined);

  // If cancel() itself rejects, execute() surfaces that cancelError
  let finishUnderlying;
  const failingCancelRunner = createAnalyzerCommandRunner({
    executeProcess: () => ({
      promise: new Promise((resolve) => {
        finishUnderlying = resolve;
      }),
      cancel: async () => {
        const err = new Error("taskkill denied");
        err.code = "analyzer_command_cancellation_failed";
        throw err;
      },
    }),
  });
  const doomed = failingCancelRunner.execute("docker-images", "docker-system-df");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failingCancelRunner.cancel().status, "cancelling");
  finishUnderlying({ stdout: "done", stderr: "" });
  await assert.rejects(doomed, { code: "analyzer_command_cancellation_failed" });
});

test("storage-inspector scanStorage and cleanup preview/execution validate candidates, fingerprints, protections, and interruptions offline", async (t) => {
  const dir = makeTempDir(t, "scan-and-cleanup-");
  const rootDir = path.join(dir, "profile-root");
  const protectedDocsDir = path.join(rootDir, "Documents");
  const copilotCacheDir = path.join(rootDir, "AppData", "Local", "GitHub Copilot", "Cache");
  const npmCacheDir = path.join(rootDir, "AppData", "Local", "npm-cache", "_cacache");
  const wideParentDir = path.join(rootDir, "ManyFolders");

  fs.mkdirSync(protectedDocsDir, { recursive: true });
  fs.mkdirSync(copilotCacheDir, { recursive: true });
  fs.mkdirSync(npmCacheDir, { recursive: true });
  fs.mkdirSync(wideParentDir, { recursive: true });

  // Aged automatic-policy cache file (10 days old -> eligible cleanup candidate)
  const staleCacheFile = path.join(copilotCacheDir, "old-index.bin");
  fs.writeFileSync(staleCacheFile, Buffer.alloc(2048, 0x41));
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
  fs.utimesSync(staleCacheFile, tenDaysAgo, tenDaysAgo);

  // Fresh cache file (today -> not eligible) and zero-byte cache file (not eligible)
  const freshCacheFile = path.join(copilotCacheDir, "fresh.bin");
  fs.writeFileSync(freshCacheFile, Buffer.alloc(512, 0x42));
  const emptyCacheFile = path.join(copilotCacheDir, "empty.bin");
  fs.writeFileSync(emptyCacheFile, Buffer.alloc(0));
  fs.utimesSync(emptyCacheFile, tenDaysAgo, tenDaysAgo);

  // Analyzer-managed npm cache file (protected when protectAnalyzerManagedPaths: true)
  const npmFile = path.join(npmCacheDir, "tarball.tgz");
  fs.writeFileSync(npmFile, Buffer.alloc(1024, 0x43));
  fs.utimesSync(npmFile, tenDaysAgo, tenDaysAgo);

  // Protected user document
  const docFile = path.join(protectedDocsDir, "budget.xlsx");
  fs.writeFileSync(docFile, Buffer.alloc(256, 0x44));
  fs.utimesSync(docFile, tenDaysAgo, tenDaysAgo);

  // >80 child folders to trigger MAX_TREE_CHILDREN "Other (N folders)" aggregation
  for (let i = 0; i < 83; i += 1) {
    const child = path.join(wideParentDir, `sub-${String(i).padStart(3, "0")}`);
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(child, "note.log"), "x");
  }

  if (process.platform !== "win32") {
    fs.symlinkSync(protectedDocsDir, path.join(rootDir, "docs-symlink"));
  }

  // getDefaultRoots respects USERPROFILE / ProgramData env overrides
  const prevProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = rootDir;
  t.after(() => {
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
  });
  const defaultRoots = getDefaultRoots(["profile"]);
  assert.equal(defaultRoots.length, 1);
  assert.equal(defaultRoots[0].path, path.resolve(rootDir));

  await assert.rejects(scanStorage({ roots: [] }), { code: "scan_roots_required" });

  const abortedController = new AbortController();
  abortedController.abort();
  await assert.rejects(
    scanStorage({ roots: [{ id: "profile", path: rootDir }], signal: abortedController.signal }),
    { code: "ABORT_ERR" },
  );

  const scanOutcome = await scanStorage({
    roots: [{ id: "profile", label: "Profile", path: rootDir }],
    categorizers: BUILT_IN_CATEGORIZERS,
    protectAnalyzerManagedPaths: true,
  });
  const publicView = toPublicScanResult(scanOutcome);
  assert.equal(publicView.candidates.length, 1);
  assert.equal(publicView.candidates[0].path, staleCacheFile);
  if (process.platform !== "win32") {
    assert.equal(publicView.summary.skippedReparsePoints, 1);
  }

  const rootTree = publicView.tree.children[0];
  const manyNode = rootTree.children.find((c) => c.name === "ManyFolders");
  assert.ok(manyNode);
  assert.equal(manyNode.children.length, 81); // 80 top children + 1 aggregate "Other (3 folders)"
  assert.equal(manyNode.children[80].aggregate, true);
  assert.equal(manyNode.children[80].name, "Other (3 folders)");

  // Cleanup preview validation & per-candidate rejection classification
  const knownFolderPaths = [protectedDocsDir];
  await assert.rejects(
    createCleanupPreview({ itemIds: [], candidates: [], approvedRoots: scanOutcome.roots, knownFolderPaths }),
    { code: "cleanup_selection_required" },
  );
  await assert.rejects(
    createCleanupPreview({
      itemIds: Array.from({ length: 501 }, (_, idx) => `id-${idx}`),
      candidates: [],
      approvedRoots: scanOutcome.roots,
      knownFolderPaths,
    }),
    { code: "cleanup_selection_too_large" },
  );
  await assert.rejects(
    createCleanupPreview({
      itemIds: ["missing-id"],
      candidates: scanOutcome.candidates,
      approvedRoots: scanOutcome.roots,
      knownFolderPaths,
    }),
    { code: "cleanup_candidate_unknown" },
  );
  await assert.rejects(
    createCleanupPreview({
      itemIds: [scanOutcome.candidates[0].id],
      candidates: scanOutcome.candidates,
      approvedRoots: scanOutcome.roots,
      knownFolderPaths: "not-an-array",
    }),
    { code: "cleanup_known_folders_invalid" },
  );

  // Directory cleanup candidate + rejected protected & analyzer-managed candidates
  const removableDir = path.join(copilotCacheDir, "subfolder");
  fs.mkdirSync(removableDir);
  const subFile = path.join(removableDir, "part.bin");
  fs.writeFileSync(subFile, Buffer.alloc(1024, 0x55));
  const removableDirStat = fs.statSync(removableDir);
  const docStat = fs.statSync(docFile);
  const npmStat = fs.statSync(npmFile);

  const syntheticCandidates = [
    scanOutcome.candidates[0],
    {
      id: "dir-cand",
      path: removableDir,
      entryType: "directory",
      bytes: 1024,
      modifiedAt: removableDirStat.mtime.toISOString(),
      app: "GitHub Copilot",
      category: "Cache",
    },
    {
      id: "protected-doc",
      path: docFile,
      bytes: docStat.size,
      modifiedAt: docStat.mtime.toISOString(),
      app: "Other",
      category: "Documents",
    },
    {
      id: "analyzer-npm",
      path: npmFile,
      bytes: npmStat.size,
      modifiedAt: npmStat.mtime.toISOString(),
      app: "npm",
      category: "Package manager cache",
    },
  ];

  const preview = await createCleanupPreview({
    itemIds: ["protected-doc", "analyzer-npm", "dir-cand", scanOutcome.candidates[0].id],
    candidates: syntheticCandidates,
    approvedRoots: scanOutcome.roots,
    analyzerProtectedPaths: scanOutcome.protectedPaths,
    source: "scan",
    knownFolderPaths,
  });

  assert.equal(preview.entries.length, 2);
  assert.equal(preview.totalBytes, 3072);
  assert.deepEqual(
    preview.rejected.map((r) => [r.id, r.code]),
    [
      ["protected-doc", "cleanup_path_protected"],
      ["analyzer-npm", "cleanup_path_analyzer_managed"],
    ],
  );

  // All-invalid selection throws cleanup_no_valid_candidates
  await assert.rejects(
    createCleanupPreview({
      itemIds: ["protected-doc"],
      candidates: syntheticCandidates,
      approvedRoots: scanOutcome.roots,
      analyzerProtectedPaths: scanOutcome.protectedPaths,
      knownFolderPaths,
    }),
    { code: "cleanup_no_valid_candidates" },
  );

  // Execution guards: confirmation required, expiry enforced
  await assert.rejects(
    executeCleanupPreview({ preview, confirmed: false, knownFolderPaths }),
    { code: "cleanup_confirmation_required" },
  );
  await assert.rejects(
    executeCleanupPreview({
      preview: { ...preview, expiresAt: new Date(Date.now() - 1000).toISOString() },
      confirmed: true,
      knownFolderPaths,
    }),
    { code: "cleanup_preview_expired" },
  );

  // Mutate file inside removableDir after preview -> directoryFingerprint mismatch marks it failed while staleCacheFile recycles
  fs.writeFileSync(path.join(removableDir, "added-after-preview.bin"), "mutated");

  const execOutcome = await executeCleanupPreview({
    preview,
    confirmed: true,
    knownFolderPaths,
    recycleBin: async (paths, onItem) => {
      assert.deepEqual(paths, [fs.realpathSync(staleCacheFile)]);
      const itemOutcome = { path: paths[0], success: true };
      onItem(itemOutcome, 1);
      return { results: [itemOutcome], interruption: undefined };
    },
  });
  assert.equal(execOutcome.succeeded.length, 1);
  assert.equal(execOutcome.reclaimedBytes, 2048);
  assert.equal(execOutcome.failed.length, 1);
  assert.equal(execOutcome.failed[0].code, "cleanup_candidate_changed");

  // Mid-batch Recycle Bin interruption classifies unreported items as unknown and failed items as cleanup_recycle_failed
  const secondFile = path.join(copilotCacheDir, "second.bin");
  const thirdFile = path.join(copilotCacheDir, "third.bin");
  fs.writeFileSync(secondFile, Buffer.alloc(400, 1));
  fs.writeFileSync(thirdFile, Buffer.alloc(600, 2));
  const secondStat = fs.statSync(secondFile);
  const thirdStat = fs.statSync(thirdFile);

  const secondPreview = await createCleanupPreview({
    itemIds: ["c2", "c3"],
    candidates: [
      { id: "c2", path: secondFile, bytes: 400, modifiedAt: secondStat.mtime.toISOString() },
      { id: "c3", path: thirdFile, bytes: 600, modifiedAt: thirdStat.mtime.toISOString() },
    ],
    approvedRoots: scanOutcome.roots,
    knownFolderPaths,
  });

  const interruptedOutcome = await executeCleanupPreview({
    preview: secondPreview,
    confirmed: true,
    knownFolderPaths,
    recycleBin: async (paths) => ({
      results: [{ path: paths[0], success: false, error: "locked by process" }],
      interruption: { code: "cleanup_timeout", message: "Recycle Bin operation timed out" },
    }),
  });
  assert.equal(interruptedOutcome.succeeded.length, 0);
  assert.equal(interruptedOutcome.reclaimedBytes, 0);
  assert.equal(interruptedOutcome.failed.length, 1);
  assert.equal(interruptedOutcome.failed[0].code, "cleanup_recycle_failed");
  assert.equal(interruptedOutcome.unknown.length, 1);
  assert.equal(interruptedOutcome.unknown[0].code, "cleanup_timeout");
});
