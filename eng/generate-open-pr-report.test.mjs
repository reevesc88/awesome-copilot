import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  escapeMarkdownCell,
  formatTimestampWithAge,
  generateOpenPrReport,
  getAgeInDays,
  getCheckLabel,
  getCheckState,
  normalizePullRequest,
  parseArgs,
  renderMarkdownReport,
  renderTable,
  REPORT_DEFINITIONS,
} from "./generate-open-pr-report.mjs";

test("parseArgs parses valid CLI options and rejects malformed repo, limit, or unknown flags", () => {
  const parsed = parseArgs([
    "--repo",
    "reevesc88/awesome-copilot",
    "--output-dir",
    "/tmp/pr-reports",
    "--limit",
    "25",
  ]);
  assert.deepEqual(parsed, {
    repo: "reevesc88/awesome-copilot",
    outputDir: "/tmp/pr-reports",
    limit: 25,
  });

  assert.throws(() => parseArgs(["--unknown"]), /Unknown option: --unknown/);
  assert.throws(() => parseArgs(["--repo", "missing-slash"]), /owner\/name format/);
  assert.throws(() => parseArgs(["--repo", "owner/"]), /owner\/name format/);
  assert.throws(() => parseArgs(["--repo", "/repo"]), /owner\/name format/);
  assert.throws(() => parseArgs(["--limit", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--limit", "10abc"]), /positive integer/);
  assert.throws(() => parseArgs(["--limit", "1.5"]), /positive integer/);
  assert.throws(() => parseArgs(["--output-dir", ""]), /--output-dir is required/);
});

test("getCheckState and getCheckLabel classify rollup check states", () => {
  assert.equal(getCheckState([]), "NONE");
  assert.equal(getCheckState(null), "NONE");
  assert.equal(
    getCheckState([
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "IN_PROGRESS", conclusion: null },
    ]),
    "PENDING",
  );
  assert.equal(
    getCheckState([
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "COMPLETED", conclusion: "TIMED_OUT" },
    ]),
    "FAILURE",
  );
  assert.equal(
    getCheckState([{ status: "COMPLETED", conclusion: "UNKNOWN_STATE" }]),
    "FAILURE",
  );
  assert.equal(
    getCheckState([
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "COMPLETED", conclusion: "NEUTRAL" },
      { status: "COMPLETED", conclusion: "SKIPPED" },
    ]),
    "SUCCESS",
  );

  assert.equal(getCheckLabel({ checkState: "SUCCESS" }), "Yes");
  assert.equal(getCheckLabel({ checkState: "PENDING" }), "Pending");
  assert.equal(getCheckLabel({ checkState: "NONE" }), "No checks");
  assert.equal(getCheckLabel({ checkState: "FAILURE" }), "No");
});

test("normalizePullRequest, age helpers, and renderers escape cells and format empty/non-empty tables", () => {
  const nowMs = Date.parse("2026-03-10T12:00:00Z");
  assert.equal(getAgeInDays("2026-03-08T12:00:00Z", nowMs), 2);
  assert.equal(getAgeInDays("2026-03-12T12:00:00Z", nowMs), 0);
  assert.equal(formatTimestampWithAge("2026-03-08T12:00:00Z", nowMs), "2026-03-08 (2d ago)");
  assert.equal(escapeMarkdownCell("feat | fix"), "feat \\| fix");

  const normalized = normalizePullRequest(
    {
      number: 42,
      title: "Fix table | pipes",
      author: null,
      baseRefName: "main",
      changedFiles: 3,
      createdAt: "2026-03-05T00:00:00Z",
      updatedAt: "2026-03-09T00:00:00Z",
      url: "https://github.com/example/repo/pull/42",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    },
    nowMs,
  );
  assert.equal(normalized.author, "ghost");
  assert.equal(normalized.checksPass, true);
  assert.equal(normalized.createdAgeDays, 5);
  assert.equal(normalized.updatedAgeDays, 1);

  assert.match(renderTable([], nowMs), /\| None \| - \| - \| - \| - \| - \|/);
  const md = renderMarkdownReport(
    "example/repo",
    "2026-03-10T12:00:00.000Z",
    [{ heading: REPORT_DEFINITIONS[0].heading, items: [normalized] }],
    nowMs,
  );
  assert.match(md, /Fix table \\\| pipes \(#42\) \| ghost \| Yes \| 2026-03-05 \(5d ago\)/);
});

test("generateOpenPrReport writes markdown and bucketed JSON files offline", (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-open-pr-"));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  const fixedNow = new Date("2026-04-01T00:00:00Z");
  const samplePrs = [
    {
      number: 1,
      title: "Main PR",
      author: { login: "alice" },
      baseRefName: "main",
      changedFiles: 2,
      createdAt: "2026-03-30T00:00:00Z",
      updatedAt: "2026-03-31T00:00:00Z",
      url: "https://github.com/example/repo/pull/1",
      statusCheckRollup: [],
    },
    {
      number: 2,
      title: "Staged small passing",
      author: { login: "bob" },
      baseRefName: "staged",
      changedFiles: 9,
      createdAt: "2026-03-29T00:00:00Z",
      updatedAt: "2026-03-31T00:00:00Z",
      url: "https://github.com/example/repo/pull/2",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    },
    {
      number: 3,
      title: "Staged small failing",
      author: { login: "carol" },
      baseRefName: "staged",
      changedFiles: 4,
      createdAt: "2026-03-29T00:00:00Z",
      updatedAt: "2026-03-31T00:00:00Z",
      url: "https://github.com/example/repo/pull/3",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
    },
    {
      number: 4,
      title: "Staged medium boundary",
      author: { login: "dave" },
      baseRefName: "staged",
      changedFiles: 10,
      createdAt: "2026-03-28T00:00:00Z",
      updatedAt: "2026-03-31T00:00:00Z",
      url: "https://github.com/example/repo/pull/4",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    },
    {
      number: 5,
      title: "Staged large",
      author: { login: "erin" },
      baseRefName: "staged",
      changedFiles: 51,
      createdAt: "2026-03-20T00:00:00Z",
      updatedAt: "2026-03-31T00:00:00Z",
      url: "https://github.com/example/repo/pull/5",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    },
  ];

  generateOpenPrReport({
    argv: ["--repo", "reevesc88/awesome-copilot", "--output-dir", outputDir, "--limit", "50"],
    checkCommand: () => {},
    fetchPullRequests: () => samplePrs,
    now: () => fixedNow,
  });

  const readIds = (fileName) =>
    JSON.parse(fs.readFileSync(path.join(outputDir, fileName), "utf8")).map((p) => p.id);

  assert.deepEqual(readIds("prs-targeting-main.json"), [1]);
  assert.deepEqual(readIds("prs-staged-passing-under-10-files.json"), [2]);
  assert.deepEqual(readIds("prs-staged-10-to-50-files.json"), [4]);
  assert.deepEqual(readIds("prs-staged-over-50-files.json"), [5]);
  assert.equal(fs.existsSync(path.join(outputDir, "open-pr-report.md")), true);
});
