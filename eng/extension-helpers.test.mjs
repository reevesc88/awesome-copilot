import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  demoSeed,
  handleApi,
  isCrossSiteRequest,
  loadDoc,
  mutate,
  normalize,
  recapMarkdown,
  statusOf,
  validId,
} from "../extensions/daily-focus-board/board-core.mjs";
import {
  buildIssueBody,
  validateSubmission,
} from "../extensions/tiny-tool-town-submitter/lib/analyzer.mjs";
import {
  buildDescriptionPrompt,
  generateDescriptionOptions,
  parseDescriptionOptions,
} from "../extensions/tiny-tool-town-submitter/lib/copy-generator.mjs";

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
