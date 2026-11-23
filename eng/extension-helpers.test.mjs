import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  demoSeed,
  ensureStateFile,
  handleApi,
  isCrossSiteRequest,
  loadDoc,
  looksLikeBoard,
  mutate,
  normalize,
  recapMarkdown,
  resolveStateFile,
  statusOf,
  validId,
} from "../extensions/daily-focus-board/board-core.mjs";
import { spawnSync } from "node:child_process";
import {
  buildIssueBody,
  fileSummary,
  inspectRepository,
  resolveRepoRoot,
  validateSubmission,
} from "../extensions/tiny-tool-town-submitter/lib/analyzer.mjs";
import {
  buildDescriptionPrompt,
  generateDescriptionOptions,
  parseDescriptionOptions,
} from "../extensions/tiny-tool-town-submitter/lib/copy-generator.mjs";
import { renderHtml as renderSubmitterHtml } from "../extensions/tiny-tool-town-submitter/lib/renderer.mjs";

function makeTempDir(t, prefix = "awesome-copilot-ext-helpers-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("daily-focus-board board-core guards IDs, cross-site headers, concurrent mutations, and Markdown recaps", async (t) => {
  // Prototype keys, reserved sentinels, and invalid characters are rejected
  assert.equal(validId("deep-work_1"), true);
  for (const badId of ["", "day", "brain", "toString", "constructor", "__proto__", "-bad", "a".repeat(65)]) {
    assert.equal(validId(badId), false, `expected validId(${badId}) to be false`);
  }

  // Cross-site request guard
  assert.equal(
    isCrossSiteRequest({ headers: { host: "127.0.0.1:4123", origin: "http://127.0.0.1:4123" } }),
    false,
  );
  assert.equal(isCrossSiteRequest({ headers: { host: "127.0.0.1:4123", origin: "null" } }), true);
  assert.equal(
    isCrossSiteRequest({ headers: { host: "127.0.0.1:4123", origin: "https://evil.example" } }),
    true,
  );
  assert.equal(
    isCrossSiteRequest({ headers: { host: "127.0.0.1:4123", "sec-fetch-site": "cross-site" } }),
    true,
  );
  assert.equal(
    isCrossSiteRequest({ headers: { host: "127.0.0.1:4123", "sec-fetch-site": "same-origin" } }),
    false,
  );

  const dir = makeTempDir(t);
  const stateFile = path.join(dir, "board.json");

  // Missing state file initializes cleanly; corrupt JSON refuses to overwrite
  const fresh = await loadDoc(stateFile);
  assert.equal(fresh.kind, "daily-focus-board");
  assert.equal(Object.getPrototypeOf(fresh.progress.t), null);

  const corruptFile = path.join(dir, "corrupt.json");
  fs.writeFileSync(corruptFile, "{not-valid-json", "utf8");
  await assert.rejects(() => loadDoc(corruptFile), /not valid JSON/);

  // Seed board and exercise concurrent serialized mutations + handleApi ops
  fs.writeFileSync(stateFile, JSON.stringify(normalize(demoSeed())), "utf8");

  const [m1, m2] = await Promise.all([
    handleApi(stateFile, "count", { id: "steps", inc: 4000 }),
    handleApi(stateFile, "count", { id: "steps", inc: 6000 }),
  ]);
  assert.equal(m1.ok, true);
  assert.equal(m2.ok, true);

  // Boolean, blank-string, array, and object count inputs are rejected and leave counter unchanged
  for (const badInput of [false, true, "   ", [], [7], {}]) {
    const badVal = await handleApi(stateFile, "count", { id: "steps", value: badInput });
    assert.equal(badVal.ok, false);
    const badInc = await handleApi(stateFile, "count", { id: "steps", inc: badInput });
    assert.equal(badInc.ok, false);
    assert.equal((await loadDoc(stateFile)).progress.counters.steps, 10000);
  }

  // Valid numeric controls including 0 and numeric strings remain accepted
  assert.equal((await handleApi(stateFile, "count", { id: "steps", value: 0 })).ok, true);
  assert.equal((await loadDoc(stateFile)).progress.counters.steps, 0);
  assert.equal((await handleApi(stateFile, "count", { id: "steps", inc: "7" })).ok, true);
  assert.equal((await loadDoc(stateFile)).progress.counters.steps, 7);
  assert.equal((await handleApi(stateFile, "count", { id: "steps", value: "10000" })).ok, true);
  assert.equal((await loadDoc(stateFile)).progress.counters.steps, 10000);

  // Progress notes auto-advance todo -> doing; carry, focus, momentum, brain, rm, add-task
  await handleApi(stateFile, "progress", { id: "deep", txt: "Drafted architecture outline" });
  let current = await loadDoc(stateFile);
  assert.equal(statusOf(current, current.tasks.find((x) => x.id === "deep")), "doing");
  assert.equal(statusOf(current, current.tasks.find((x) => x.id === "steps")), "done");

  await handleApi(stateFile, "status", { id: "deep", status: "done" });
  await handleApi(stateFile, "carry", { id: "read", value: true });
  await handleApi(stateFile, "focus", { id: "deep" });
  await handleApi(stateFile, "focus", { id: "deep" }); // toggles off
  await handleApi(stateFile, "day", { txt: "Shipped parser fix" });
  await handleApi(stateFile, "brain", { txt: "Investigate caching later" });
  await handleApi(stateFile, "rm", { value: true });

  const added = await handleApi(stateFile, "add-task", { title: "Write Offline Tests!" });
  assert.equal(added.ok, true);
  assert.equal(added.id, "write-offline-tests");
  const dup = await handleApi(stateFile, "add-task", { id: "write-offline-tests", title: "Dup" });
  assert.equal(dup.ok, false);

  assert.equal((await handleApi(stateFile, "unknown", {})).error, "unknown_op");

  current = await loadDoc(stateFile);
  const recap = recapMarkdown({ ...current, name: "Cal", dateKey: "2026-03-15" });
  assert.match(recap, /# Focus board — Cal · 2026-03-15/);
  assert.match(recap, /\*\*2\/3 done\*\* for today, 1 still open\./);
  assert.match(recap, /Walk 10,000 steps — _done_ \(10000\/10000 steps\)/);
  assert.match(recap, /Read a chapter — _→ tomorrow_/);
  assert.match(recap, /## Momentum\n- Shipped parser fix/);
  assert.match(recap, /## Parked thoughts\n- Investigate caching later/);

  // Delete note, momentum, and brain entries
  assert.equal((await handleApi(stateFile, "note-del", { id: "deep", idx: 0 })).ok, true);
  assert.equal((await handleApi(stateFile, "day-del", { idx: 0 })).ok, true);
  assert.equal((await handleApi(stateFile, "brain-del", { idx: 0 })).ok, true);
  assert.equal((await mutate(stateFile, () => ({ error: "synthetic_err" }))).ok, false);
});

test("tiny-tool-town-submitter validates submissions, formats issue bodies, and enforces copy word-count invariants", async () => {
  const validMeta = {
    name: "Pixel Ruler",
    tagline: "Measure screen distances in one shortcut.",
    description: "Lightweight open-source pixel ruler for designers and frontend developers.",
    githubUrl: "https://github.com/octo/pixel-ruler",
    websiteUrl: "https://pixel-ruler.example.com",
    thumbnailUrl: "https://pixel-ruler.example.com/shot.png",
    author: "Octo Dev",
    authorGitHub: "@octo",
    language: "TypeScript",
    license: "MIT",
    tags: "design, frontend, utility",
    theme: "terminal",
    confirmations: {
      freeOpenSource: true,
      notEnterpriseSaas: true,
      publicAndWorks: true,
    },
  };

  assert.deepEqual(validateSubmission(validMeta, { repoSlug: "octo/pixel-ruler" }), []);
  const body = buildIssueBody(validMeta);
  assert.match(body, /### Tool Name\n\nPixel Ruler/);
  assert.match(body, /octo/);

  // Invalid fields, mismatched slug, unsupported theme, missing confirmations, private/archived flags
  const invalidErrors = validateSubmission(
    {
      ...validMeta,
      name: "   ",
      tagline: "x".repeat(101),
      githubUrl: "https://github.com/other/repo",
      websiteUrl: "not-a-url",
      thumbnailUrl: "::bad",
      theme: "cyberpunk-invalid",
      confirmations: {},
    },
    { repoSlug: "octo/pixel-ruler", isPrivate: true, isArchived: true },
  );
  assert.ok(invalidErrors.some((e) => e.includes("Tool name is required")));
  assert.ok(invalidErrors.some((e) => e.includes("100 characters or fewer")));
  assert.ok(invalidErrors.some((e) => e.includes("must match the inspected repository")));
  assert.ok(invalidErrors.some((e) => e.includes("Website or demo URL must be valid")));
  assert.ok(invalidErrors.some((e) => e.includes("Thumbnail URL must be valid")));
  assert.ok(invalidErrors.some((e) => e.includes("supported page theme")));
  assert.ok(invalidErrors.some((e) => e.includes("private")));
  assert.ok(invalidErrors.some((e) => e.includes("archived")));

  // Copy generator prompt + response parsing
  const prompt = buildDescriptionPrompt(validMeta);
  assert.match(prompt, /Source JSON:/);
  assert.match(prompt, /"name":"Pixel Ruler"/);

  const makeWords = (count) => Array.from({ length: count }, (_, i) => `word${i + 1}`).join(" ");
  const validCopyJson = `Here is the JSON:\n${JSON.stringify({
    short: makeWords(15),
    medium: makeWords(40),
    detailed: makeWords(65),
  })}`;
  const parsedOptions = parseDescriptionOptions(validCopyJson);
  assert.deepEqual(
    parsedOptions.map((o) => [o.id, o.wordCount]),
    [
      ["short", 15],
      ["medium", 40],
      ["detailed", 65],
    ],
  );

  // Reject non-JSON, out-of-range word counts, and non-increasing lengths
  assert.throws(() => parseDescriptionOptions("no braces here"), /did not return a JSON object/);
  assert.throws(() => parseDescriptionOptions("{broken}"), /invalid JSON/);
  assert.throws(
    () =>
      parseDescriptionOptions(
        JSON.stringify({ short: makeWords(3), medium: makeWords(40), detailed: makeWords(65) }),
      ),
    /short option was 3 words/,
  );
  assert.throws(
    () =>
      parseDescriptionOptions(
        JSON.stringify({ short: makeWords(40), medium: makeWords(35), detailed: makeWords(65) }),
      ),
    /increasing lengths/,
  );

  await assert.rejects(() => generateDescriptionOptions(null, validMeta), /session is unavailable/);
  const sessionResult = await generateDescriptionOptions(
    {
      sendAndWait: async () => ({ data: { content: validCopyJson } }),
    },
    validMeta,
  );
  assert.equal(sessionResult.length, 3);
});

test("tiny-tool-town-submitter inspectRepository, resolveRepoRoot, fileSummary, and renderer handle local git repos offline", async (t) => {
  const nonGitDir = makeTempDir(t, "ttt-nongit-");
  await assert.rejects(() => resolveRepoRoot(nonGitDir), /No Git repository was found/);
  assert.equal(await fileSummary(path.join(nonGitDir, "missing.txt")), null);

  const html = renderSubmitterHtml("nonce-abc");
  assert.match(html, /<style nonce="nonce-abc">/);
  assert.match(html, /Tiny Tool Town Submitter/);

  // Create synthetic git repository with angle-bracket titled image, badges, Rust sources, and Apache-2.0 license
  const repoDir = makeTempDir(t, "ttt-repo-");
  const subDir = path.join(repoDir, "crates", "cli");
  fs.mkdirSync(subDir, { recursive: true });
  fs.mkdirSync(path.join(repoDir, "node_modules", "ignored"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "node_modules", "ignored", "index.js"), "// ignored\n", "utf8");
  fs.writeFileSync(path.join(subDir, "main.rs"), "fn main() {}\n", "utf8");
  fs.writeFileSync(path.join(subDir, "lib.rs"), "pub fn run() {}\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "Cargo.toml"), '[package]\nname = "demo"\n', "utf8");
  fs.writeFileSync(path.join(repoDir, "LICENSE"), "Apache License, Version 2.0 (Apache-2.0)\n", "utf8");
  fs.writeFileSync(
    path.join(repoDir, "README.md"),
    [
      "# Rust Widget",
      "",
      "![Build](https://img.shields.io/badge/build-passing-brightgreen.svg)",
      "",
      "![Widget UI screenshot](<./docs/preview.png> \"Main screenshot\")",
      "",
      "Rust Widget is a fast terminal inspector for binary headers and archive layouts.",
      "",
      "Try the [live demo](https://widget.example.dev/) in your browser.",
      "",
      "## Quick Start",
      "",
      "Run `cargo install rust-widget`.",
      "",
      "## Examples",
      "",
      "Run `rust-widget file.bin`.",
    ].join("\n"),
    "utf8",
  );

  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "Ada Lovelace"],
    ["config", "user.email", "ada@example.com"],
    ["config", "commit.gpgSign", "false"],
    ["config", "tag.gpgSign", "false"],
    ["remote", "add", "origin", "git@github.com:ada/rust-widget.git"],
  ]) {
    const res = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", timeout: 10_000 });
    assert.equal(res.status, 0, res.stderr);
  }

  assert.equal(await resolveRepoRoot(subDir), fs.realpathSync(repoDir));
  const summary = await fileSummary(path.join(repoDir, "Cargo.toml"));
  assert.ok(summary && summary.bytes > 0);

  // Stub gh CLI on PATH so inspectRepository runs 100% offline
  const fakeBin = makeTempDir(t, "ttt-bin-");
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    `#!/bin/sh
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  printf '%s' '{"name":"rust-widget","description":"","homepageUrl":"","isArchived":false,"isPrivate":false,"primaryLanguage":null,"repositoryTopics":[{"name":"CLI Tools"}],"owner":{"login":"ada"},"url":"https://github.com/ada/rust-widget","defaultBranchRef":{"name":"trunk"}}'
elif [ "$1" = "api" ]; then
  printf 'Ada Lovelace\\n'
fi
`,
    { mode: 0o755 },
  );

  const origPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${origPath}`;
  t.after(() => {
    process.env.PATH = origPath;
  });

  const inspected = await inspectRepository(subDir);
  assert.equal(inspected.facts.repoSlug, "ada/rust-widget");
  assert.equal(inspected.facts.hasReadme, true);
  assert.equal(inspected.facts.hasInstallDocs, true);
  assert.equal(inspected.facts.hasUsageDocs, true);
  assert.equal(inspected.facts.hasThumbnail, true);
  assert.equal(inspected.facts.thumbnailAlt, "Widget UI screenshot");
  assert.equal(inspected.facts.hasBuildSignal, true);
  assert.equal(
    inspected.metadata.thumbnailUrl,
    "https://raw.githubusercontent.com/ada/rust-widget/trunk/docs/preview.png",
  );
  assert.equal(inspected.metadata.websiteUrl, "https://widget.example.dev");
  assert.equal(inspected.metadata.language, "Rust");
  assert.equal(inspected.metadata.license, "Apache-2.0");
  assert.equal(inspected.metadata.author, "Ada Lovelace");
  assert.match(inspected.metadata.tags, /cli-tools, rust, open-source/);

  // Bare repo without README/LICENSE surfaces blocking & recommended readiness items
  const bareRepo = makeTempDir(t, "ttt-bare-");
  spawnSync("git", ["init", "-q"], { cwd: bareRepo, encoding: "utf8", timeout: 10_000 });
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    `#!/bin/sh
exit 1
`,
    { mode: 0o755 },
  );
  const bareInspected = await inspectRepository(bareRepo);
  const recIds = new Set(bareInspected.recommendations.map((r) => r.id));
  assert.equal(recIds.has("add-readme"), true);
  assert.equal(recIds.has("add-license"), true);
  assert.equal(recIds.has("add-thumbnail"), true);
  assert.equal(recIds.has("verify-public-repo"), true);
});

test("daily-focus-board state file guards and work-hub pure preference/age helpers handle edge cases", async (t) => {
  const dir = makeTempDir(t, "dfb-state-");

  // Directory input resolves to date-scoped focus-board-YYYY-MM-DD.json inside dir
  const resolvedInDir = await resolveStateFile(dir);
  assert.match(path.basename(resolvedInDir), /^focus-board-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(path.dirname(resolvedInDir), dir);

  assert.equal(looksLikeBoard(null), false);
  assert.equal(looksLikeBoard([]), false);
  assert.equal(looksLikeBoard({ unrelated: true }), false);
  assert.equal(looksLikeBoard({ kind: "daily-focus-board" }), true);
  assert.equal(looksLikeBoard({ tasks: [], progress: {} }), true);

  // ensureStateFile seeds missing file, adopts valid board, and refuses non-JSON or unrelated JSON
  const seededPath = await ensureStateFile(path.join(dir, "sub", "board.json"));
  assert.equal(fs.existsSync(seededPath), true);
  assert.equal(await ensureStateFile(seededPath), seededPath);

  const nonJsonFile = path.join(dir, "notes.txt");
  fs.writeFileSync(nonJsonFile, "plain text", "utf8");
  await assert.rejects(() => ensureStateFile(nonJsonFile), /refusing to use existing non-JSON file/);

  const unrelatedJson = path.join(dir, "package.json");
  fs.writeFileSync(unrelatedJson, JSON.stringify({ name: "unrelated" }), "utf8");
  await assert.rejects(() => ensureStateFile(unrelatedJson), /not a daily-focus-board/);

  // work-hub pure helpers (node:sqlite requires Node 22.5+; skip gracefully on older runtimes)
  let workHub;
  try {
    workHub = await import("../extensions/work-hub/data.mjs");
  } catch (err) {
    if (err?.code === "ERR_UNKNOWN_BUILTIN_MODULE") return;
    throw err;
  }
  assert.equal(workHub.daysSince(null), null);
  assert.equal(workHub.daysSince("not-a-date"), null);
  assert.equal(workHub.daysSince(new Date(Date.now() + 60_000).toISOString()), 0);

  assert.equal(workHub.ageLabel(null), "unknown");
  assert.equal(workHub.ageLabel(0), "today");
  assert.equal(workHub.ageLabel(1), "1 day");
  assert.equal(workHub.ageLabel(12), "12 days");
  assert.equal(workHub.ageLabel(90), "3 mo");
  assert.equal(workHub.ageLabel(800), "2 yr");

  assert.deepEqual(workHub.normalizePreferences({ mood: "invalid", minutes: 999, busyness: "nope", focusIntent: "bad" }), {
    mood: "focused",
    busyness: "normal",
    minutes: 30,
    focusIntent: "balanced",
  });
  assert.deepEqual(workHub.normalizePreferences({ mood: "urgent", minutes: "60", busyness: "busy", focusIntent: "prs" }), {
    mood: "urgent",
    busyness: "busy",
    minutes: 60,
    focusIntent: "prs",
  });

  // Validate getItemDetail and runItemAction input guards + stubbed gh CLI calls
  await assert.rejects(() => workHub.getItemDetail({ repo: "bad", type: "pr", number: 1 }), /required/);
  await assert.rejects(() => workHub.runItemAction({ repo: "octo/demo", type: "issue", number: 1, action: "merge" }), /pull requests/);
  await assert.rejects(() => workHub.runItemAction({ repo: "octo/demo", type: "pr", number: 1, action: "assign-me" }), /issues/);
  await assert.rejects(() => workHub.runItemAction({ repo: "octo/demo", type: "pr", number: 1, action: "comment", body: "   " }), /comment body is required/);
  await assert.rejects(() => workHub.runItemAction({ repo: "octo/demo", type: "pr", number: 1, action: "nope" }), /Unknown action/);

  const whBin = makeTempDir(t, "wh-bin-");
  fs.writeFileSync(
    path.join(whBin, "gh"),
    `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s' '{"number":9,"title":"Add feature","body":"Details","state":"OPEN","author":{"login":"octocat"},"url":"https://github.com/octo/demo/pull/9","isDraft":false,"reviewDecision":"APPROVED","labels":[{"name":"enhancement"}],"assignees":[{"login":"octocat"}],"additions":12,"deletions":3,"changedFiles":2,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","headRefName":"feat","baseRefName":"main","statusCheckRollup":[{"conclusion":"FAILURE"},{"conclusion":"SUCCESS"}],"createdAt":"2026-03-01T00:00:00Z","updatedAt":"2026-03-02T00:00:00Z","comments":[{"author":{"login":"reviewer"},"body":"LGTM","createdAt":"2026-03-02T00:00:00Z"}]}'
elif [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  printf '%s' '{"number":4,"title":"Bug report","body":"Steps","state":"OPEN","author":{"login":"reporter"},"url":"https://github.com/octo/demo/issues/4","labels":["bug"],"assignees":[],"createdAt":"2026-03-01T00:00:00Z","updatedAt":"2026-03-02T00:00:00Z","comments":[]}'
else
  printf 'Action completed\\n'
fi
`,
    { mode: 0o755 },
  );
  const prevPath = process.env.PATH;
  process.env.PATH = `${whBin}${path.delimiter}${prevPath}`;
  t.after(() => {
    process.env.PATH = prevPath;
  });

  const prDetail = await workHub.getItemDetail({ repo: "octo/demo", type: "pr", number: 9 });
  assert.equal(prDetail.checksTotal, 2);
  assert.equal(prDetail.checksFailing, 1);
  assert.equal(prDetail.comments.length, 1);

  const issueDetail = await workHub.getItemDetail({ repo: "octo/demo", type: "issue", number: 4 });
  assert.equal(issueDetail.title, "Bug report");
  assert.deepEqual(issueDetail.labels, ["bug"]);

  const actionRes = await workHub.runItemAction({
    repo: "octo/demo",
    type: "pr",
    number: 9,
    action: "copilot-review",
  });
  assert.equal(actionRes.ok, true);
});
