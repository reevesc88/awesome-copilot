import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  sampleReceipt,
  validateReceipt,
} from "../skills/bug-receipt/scripts/validate-receipt.mjs";
import {
  MapValidationError,
  canonicalJson,
  inspectMapContract,
  validateMapContract,
} from "../skills/build-evidence-map/scripts/contract.mjs";
import {
  inspectOfflineMap,
  validateMapFile,
} from "../skills/build-evidence-map/scripts/validate.mjs";
import {
  dateToYMD,
  parseDateRange,
} from "../skills/pr-dashboard/scripts/lib/utils.mjs";
import { ROOT_FOLDER } from "./constants.mjs";

const SUBPROCESS_TIMEOUT_MS = 10_000;

function makeTempDir(t, prefix = "awesome-copilot-skill-validators-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeValidEvidenceMap() {
  return {
    title: "Checkout Latency Regression",
    question: "Did the v2 serializer cause p99 latency spikes?",
    verdict: "Supported by trace evidence with one open cache question.",
    updatedAt: "2026-03-15",
    nodes: [
      { id: "pos-1", type: "position", label: "Verdict", text: "v2 serializer increased latency." },
      { id: "claim-1", type: "claim", label: "CPU time doubled", text: "JSON cloning doubled CPU." },
      {
        id: "ev-1",
        type: "evidence",
        label: "Benchmark trace",
        text: "Flamegraph shows 2.1x time in serializeOrder.",
        sourceId: "src-1",
      },
      { id: "unk-1", type: "unknown", label: "Cold cache impact", text: "Cold start unmeasured." },
    ],
    edges: [
      { from: "ev-1", to: "claim-1", relation: "supports", note: "Direct flamegraph measurement." },
      { from: "claim-1", to: "pos-1", relation: "supports", note: "Explains latency jump." },
      { from: "unk-1", to: "pos-1", relation: "qualifies", note: "Cold cache contribution pending." },
    ],
    sources: [
      {
        id: "src-1",
        title: "Perf Flamegraph Report",
        publisher: "Platform Perf Team",
        date: "2024-02-29",
        retrievedAt: "2026-03-10",
        url: "https://example.com/reports/perf-2026",
        locator: "§ 2.1",
        excerpt: "Order serialization spent 48.2 ms at p99 versus 22.7 ms prior to release.",
        verification: {
          status: "verified",
          method: "normalized-excerpt-match",
          checkedAt: "2026-03-10T14:25:00Z",
          contentSha256: "a".repeat(64),
          excerptSha256: "b".repeat(64),
          locatorStatus: "matched",
          finalUrl: "https://example.com/reports/perf-2026",
        },
      },
    ],
  };
}

test("bug-receipt validator enforces schema, version, and status proof invariants and CLI exit codes", (t) => {
  assert.deepEqual(validateReceipt(sampleReceipt), { valid: true, issues: [] });
  assert.equal(validateReceipt(null).valid, false);
  assert.equal(validateReceipt([]).issues[0].path, "$");

  // Version 1 allows omitting evidenceSource; Version 2 requires it
  const v1Receipt = structuredClone(sampleReceipt);
  v1Receipt.version = 1;
  delete v1Receipt.evidenceSource;
  assert.equal(validateReceipt(v1Receipt).valid, true);

  const v2MissingSource = structuredClone(sampleReceipt);
  delete v2MissingSource.evidenceSource;
  assert.ok(validateReceipt(v2MissingSource).issues.some((i) => i.path === "evidenceSource"));

  // Verified status rejects unobserved baseline, failed checks, empty arrays, and proof gaps
  const badVerified = {
    ...structuredClone(sampleReceipt),
    extraRoot: true,
    baseline: { command: "npm test", result: "not-run", evidence: "skipped", extra: 1 },
    rootCause: { summary: "Unknown", evidence: [] },
    changes: [],
    verification: [{ command: "npm test", result: "failed", evidence: "1 fail" }],
    gaps: ["Did not run integration suite"],
  };
  const verifiedIssues = validateReceipt(badVerified).issues.map((i) => `${i.path}:${i.message}`);
  assert.ok(verifiedIssues.some((m) => m.startsWith("extraRoot:Unknown field")));
  assert.ok(verifiedIssues.some((m) => m.startsWith("baseline.extra:Unknown field")));
  assert.ok(verifiedIssues.some((m) => m.includes("Verified requires an observed baseline")));
  assert.ok(verifiedIssues.some((m) => m.includes("concrete root-cause evidence")));
  assert.ok(verifiedIssues.some((m) => m.includes("at least one changed file")));
  assert.ok(verifiedIssues.some((m) => m.includes("Every verification check must pass")));
  assert.ok(verifiedIssues.some((m) => m.includes("cannot contain proof gaps")));

  // Partial and blocked statuses require non-empty gaps
  const partialNoGap = { ...structuredClone(sampleReceipt), status: "partial", gaps: [] };
  assert.ok(validateReceipt(partialNoGap).issues.some((i) => i.message.includes("Partial status")));

  const blockedNoGap = { ...structuredClone(sampleReceipt), status: "blocked", gaps: [] };
  assert.ok(validateReceipt(blockedNoGap).issues.some((i) => i.message.includes("Blocked status")));

  // CLI: stdin (-), --json, invalid receipt exit 1, missing argument exit 2
  const cliPath = path.join(ROOT_FOLDER, "skills", "bug-receipt", "scripts", "validate-receipt.mjs");
  const missingArg = spawnSync(process.execPath, [cliPath], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(missingArg.status, 2);

  const validStdin = spawnSync(process.execPath, [cliPath, "-"], {
    input: JSON.stringify(sampleReceipt),
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(validStdin.status, 0, validStdin.stderr);
  assert.match(validStdin.stdout, /valid VERIFIED bug receipt/);

  const dir = makeTempDir(t);
  const invalidFile = path.join(dir, "bad-receipt.json");
  fs.writeFileSync(invalidFile, JSON.stringify(partialNoGap), "utf8");
  const jsonRun = spawnSync(process.execPath, [cliPath, invalidFile, "--json"], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(jsonRun.status, 1);
  assert.equal(JSON.parse(jsonRun.stdout).valid, false);
});

test("build-evidence-map contract and CLI validate dates, locators, excerpts, topology, cycles, and deterministic receipts", async (t) => {
  const validMap = makeValidEvidenceMap();
  const inspected = inspectOfflineMap(validMap);
  assert.equal(inspected.valid, true);
  assert.match(inspected.receipt, /^[a-f0-9]{64}$/);
  assert.deepEqual(inspected.metrics, {
    claims: 1,
    contradictions: 0,
    evidence: 1,
    sources: 1,
    unknowns: 1,
  });

  // Canonical JSON and receipt are invariant to object property insertion order
  const reordered = {
    sources: validMap.sources.map((s) => ({ excerpt: s.excerpt, id: s.id, ...s })),
    edges: validMap.edges,
    nodes: validMap.nodes,
    updatedAt: validMap.updatedAt,
    verdict: validMap.verdict,
    question: validMap.question,
    title: validMap.title,
  };
  assert.equal(canonicalJson(reordered), canonicalJson(validMap));
  assert.equal(inspectOfflineMap(reordered).receipt, inspected.receipt);

  // Non-object map
  assert.equal(inspectMapContract(null).findings[0].rule, "map-type");

  // Invalid calendar dates, excerpts, verification fields, cycles, disconnected nodes, and false precision
  const brokenMap = {
    title: "Broken",
    question: "Why?",
    verdict: "Invalid",
    updatedAt: "2025-02-29", // non-leap year!
    nodes: [
      { id: "p1", type: "position", label: "Pos", text: "Pos", confidence: 0.9 },
      { id: "c1", type: "claim", label: "C1", text: "Claim 1" },
      { id: "c1", type: "bad-type", label: "", text: "" },
      { id: "c2", type: "claim", label: "C2", text: "Claim 2" },
      { id: "ev-orphan", type: "evidence", label: "Orphan", text: "No source or edge" },
      { id: "ev-missing-src", type: "evidence", label: "BadSrc", text: "Missing src", sourceId: "nope" },
    ],
    edges: [
      { from: "c1", to: "c2", relation: "contradicts", note: "cycle a" },
      { from: "c2", to: "c1", relation: "contradicts", note: "cycle b" },
      { from: "c1", to: "c1", relation: "bad-rel", note: "" },
      { from: "c1", to: "c2", relation: "contradicts", note: "duplicate" },
      { from: "ghost", to: "p1", relation: "supports", note: "unknown from" },
    ],
    sources: [
      {
        id: "unused-src",
        title: "Src",
        publisher: "Pub",
        date: "2025-04-31",
        retrievedAt: "2025-03-01T25:00:00Z",
        url: "ftp://bad.example.com",
        locator: "somewhere near the middle",
        excerpt: "a".repeat(45), // >=40 chars but <6 unique symbols -> low-information-excerpt
        verification: {
          status: "unverified",
          method: "manual",
          checkedAt: "2025-03-02T10:00:00Z",
          contentSha256: "XYZ",
          excerptSha256: "123",
          locatorStatus: "unknown",
          finalUrl: "mailto:nope@example.com",
        },
      },
    ],
  };

  assert.throws(() => validateMapContract(brokenMap), (err) => {
    assert.ok(err instanceof MapValidationError);
    const rules = new Set(err.findings.map((f) => f.rule));
    for (const expectedRule of [
      "map-date",
      "false-precision",
      "duplicate-node",
      "node-type",
      "source-date",
      "retrieval-date",
      "source-url",
      "source-locator",
      "low-information-excerpt",
      "verification-status",
      "verification-method",
      "verification-digest",
      "verification-locator",
      "verification-url",
      "self-edge",
      "duplicate-edge",
      "edge-relation",
      "unknown-node",
      "unsourced-evidence",
      "unknown-source",
      "unused-evidence",
      "unused-source",
      "disconnected-node",
      "reasoning-cycle",
    ]) {
      assert.ok(rules.has(expectedRule), `expected finding rule ${expectedRule}`);
    }
    return true;
  });

  // File validation + CLI (--help, valid human output, invalid JSON file)
  const dir = makeTempDir(t);
  const badJsonPath = path.join(dir, "corrupt.doubt.json");
  fs.writeFileSync(badJsonPath, "{broken", "utf8");
  const badFileResult = await validateMapFile(badJsonPath);
  assert.equal(badFileResult.valid, false);
  assert.equal(badFileResult.findings[0].rule, "invalid-json");

  const validPath = path.join(dir, "valid.doubt.json");
  fs.writeFileSync(validPath, JSON.stringify(validMap), "utf8");
  const cliPath = path.join(ROOT_FOLDER, "skills", "build-evidence-map", "scripts", "validate.mjs");

  const helpRun = spawnSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(helpRun.status, 0);
  assert.match(helpRun.stdout, /Usage:/);

  const validCli = spawnSync(process.execPath, [cliPath, validPath], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(validCli.status, 0, validCli.stderr);
  assert.match(validCli.stdout, /^VALID [a-f0-9]{64}/);

  const invalidCli = spawnSync(process.execPath, [cliPath, badJsonPath], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(invalidCli.status, 1);
  assert.match(invalidCli.stderr, /INVALID 1 finding/);
});

test("pr-dashboard utils format dates and parse nullish, relative, calendar, and explicit date ranges", () => {
  assert.equal(dateToYMD(new Date(2026, 0, 5)), "2026-01-05");

  // Nullish / empty inputs fall back to Last 7 days without throwing TypeError
  assert.equal(parseDateRange(null).label, "Last 7 days");
  assert.equal(parseDateRange(undefined).label, "Last 7 days");
  assert.equal(parseDateRange("").label, "Last 7 days");

  assert.equal(parseDateRange("last 14 days").label, "Last 14 days");
  assert.equal(parseDateRange("last 2 weeks").label, "Last 2 weeks");
  assert.equal(parseDateRange("this week").label, "This week");
  assert.equal(parseDateRange("last week").label, "Last week");
  assert.equal(parseDateRange("this month").label, "This month");
  assert.equal(parseDateRange("last month").label, "Last month");
  assert.equal(parseDateRange("next month").label, "Next month");

  // Leap-year February month+year
  assert.deepEqual(parseDateRange("February 2024"), {
    start: "2024-02-01",
    end: "2024-02-29",
    label: "February 2024",
  });
  assert.deepEqual(parseDateRange("sept 2025"), {
    start: "2025-09-01",
    end: "2025-09-30",
    label: "Sept 2025",
  });

  // Explicit ISO range (both '-' and case-insensitive 'TO') and named month range
  assert.deepEqual(parseDateRange("2026-03-01 TO 2026-03-15"), {
    start: "2026-03-01",
    end: "2026-03-15",
    label: "2026-03-01 → 2026-03-15",
  });
  assert.deepEqual(parseDateRange("Apr 1, 2025 - Apr 5, 2025"), {
    start: "2025-04-01",
    end: "2025-04-05",
    label: "Apr 1, 2025 → Apr 5, 2025",
  });

  // Year-only and month-only
  assert.deepEqual(parseDateRange("in 2023"), {
    start: "2023-01-01",
    end: "2023-12-31",
    label: "2023",
  });
  const decOnly = parseDateRange("december");
  assert.match(decOnly.start, /^\d{4}-12-01$/);
  assert.match(decOnly.end, /^\d{4}-12-31$/);
});
