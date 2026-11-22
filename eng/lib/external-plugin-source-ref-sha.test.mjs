import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateRefShaConsistency,
  normalizeCommitSha,
} from "./external-plugin-source-ref-sha.mjs";

test("normalizeCommitSha accepts only 40-character hexadecimal strings", () => {
  const upperSha = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
  assert.equal(normalizeCommitSha(`  ${upperSha}  `), upperSha.toLowerCase());
  assert.equal(normalizeCommitSha("a".repeat(39)), undefined);
  assert.equal(normalizeCommitSha("a".repeat(41)), undefined);
  assert.equal(normalizeCommitSha("g".repeat(40)), undefined);
  assert.equal(normalizeCommitSha(12345), undefined);
  assert.equal(normalizeCommitSha(undefined), undefined);
});

test("evaluateRefShaConsistency handles uncomparable inputs and non-string ref metadata", () => {
  const shaA = "1".repeat(40);
  const shaB = "2".repeat(40);

  assert.deepEqual(
    evaluateRefShaConsistency({ ref: "v1.0.0", sha: shaA, resolvedRefCommitSha: "not-a-sha" }),
    {
      comparable: false,
      matches: true,
      normalizedSha: shaA,
      normalizedRefCommitSha: undefined,
    },
  );

  assert.deepEqual(
    evaluateRefShaConsistency({ ref: null, sha: ` ${shaA.toUpperCase()} `, resolvedRefCommitSha: shaA }),
    {
      comparable: true,
      matches: true,
      normalizedSha: shaA,
      normalizedRefCommitSha: shaA,
      ref: "",
      sha: shaA.toUpperCase(),
    },
  );

  const mismatch = evaluateRefShaConsistency({
    ref: " v2.0.0 ",
    sha: shaA,
    resolvedRefCommitSha: shaB,
  });
  assert.equal(mismatch.comparable, true);
  assert.equal(mismatch.matches, false);
  assert.equal(mismatch.ref, "v2.0.0");
});
