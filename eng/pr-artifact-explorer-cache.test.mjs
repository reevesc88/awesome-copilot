import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { after, test } from "node:test";
import { CacheMaintenanceCoordinator } from "../extensions/pr-artifact-explorer/cache-coordinator.mjs";

// Point COPILOT_HOME at an isolated temp directory before importing constants/cache
const ISOLATED_COPILOT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-prae-cache-"));
const PREVIOUS_COPILOT_HOME = process.env.COPILOT_HOME;
process.env.COPILOT_HOME = ISOLATED_COPILOT_HOME;

const { CACHE_ROOT, MAX_ARCHIVE_BYTES } = await import(
  "../extensions/pr-artifact-explorer/constants.mjs"
);
const {
  clearArtifactCache,
  deleteCachedArtifact,
  getCacheSummary,
  getCachedArtifact,
  getCachedEntry,
  inspectArtifact,
  readCachedEntry,
} = await import("../extensions/pr-artifact-explorer/cache.mjs");

after(() => {
  if (PREVIOUS_COPILOT_HOME === undefined) {
    delete process.env.COPILOT_HOME;
  } else {
    process.env.COPILOT_HOME = PREVIOUS_COPILOT_HOME;
  }
  fs.rmSync(ISOLATED_COPILOT_HOME, { recursive: true, force: true });
});

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function buildZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const spec of entries) {
    const rawData = Buffer.isBuffer(spec.data)
      ? spec.data
      : Buffer.from(spec.data ?? "", "utf8");
    const method = spec.method ?? 8;
    const flags = 0x0800;
    const nameBytes = Buffer.from(spec.name, "utf8");
    const compressed = method === 0 ? rawData : deflateRawSync(rawData);
    const entryCrc = crc32(rawData);
    const modDate = ((2026 - 1980) << 9) | (3 << 5) | 15;
    const modTime = (10 << 11) | (30 << 5) | 10;
    const unixMode = spec.name.endsWith("/") ? 0o040755 : 0o100644;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(modTime, 10);
    localHeader.writeUInt16LE(modDate, 12);
    localHeader.writeUInt32LE(entryCrc >>> 0, 14);
    localHeader.writeUInt32LE(compressed.length >>> 0, 18);
    localHeader.writeUInt32LE(rawData.length >>> 0, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localOffset = offset;
    localParts.push(localHeader, nameBytes, compressed);
    offset += localHeader.length + nameBytes.length + compressed.length;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(modTime, 12);
    centralHeader.writeUInt16LE(modDate, 14);
    centralHeader.writeUInt32LE(entryCrc >>> 0, 16);
    centralHeader.writeUInt32LE(compressed.length >>> 0, 20);
    centralHeader.writeUInt32LE(rawData.length >>> 0, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((unixMode << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset >>> 0, 42);
    centralParts.push(centralHeader, nameBytes);
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

function jsonResponse(payload, status = 200) {
  const raw = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => raw,
    json: async () => payload,
  };
}

function zipStreamResponse(zipBytes) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) => {
        const key = String(name).toLowerCase();
        if (key === "content-type") return "application/zip";
        if (key === "content-length") return String(zipBytes.length);
        return null;
      },
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(zipBytes);
        controller.close();
      },
    }),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("CacheMaintenanceCoordinator deduplicates concurrent operations, orders deletions after clear, and releases barriers after errors", async () => {
  const coordinator = new CacheMaintenanceCoordinator();

  // 1. Concurrent deleteArtifact calls for the same id share one execution
  const delStarted = deferred();
  const delRelease = deferred();
  let delRuns = 0;
  const firstDel = coordinator.deleteArtifact(7, async () => {
    delRuns += 1;
    delStarted.resolve();
    await delRelease.promise;
    return { deleted: "7" };
  });
  const secondDel = coordinator.deleteArtifact("7", async () => {
    delRuns += 1;
    return { deleted: "unexpected" };
  });
  await delStarted.promise;
  assert.notEqual(coordinator.inspectionBarrier("7"), null);
  assert.equal(coordinator.inspectionBarrier("8"), null);

  delRelease.resolve();
  assert.deepEqual(await Promise.all([firstDel, secondDel]), [{ deleted: "7" }, { deleted: "7" }]);
  assert.equal(delRuns, 1);
  assert.equal(coordinator.inspectionBarrier("7"), null);

  // 2. Rejected deleteArtifact still resolves waiter barrier without poisoning clearCache
  const failingGate = deferred();
  const failingDel = coordinator.deleteArtifact("9", async () => {
    await failingGate.promise;
    throw new Error("disk busy");
  });
  const waiterBarrier = coordinator.inspectionBarrier("9");
  assert.notEqual(waiterBarrier, null);

  const clearPromise = coordinator.clearCache(async () => ({ cleared: true }));
  // Concurrent clearCache joins the in-flight clear
  const duplicateClear = coordinator.clearCache(async () => ({ cleared: false }));

  failingGate.resolve();
  await assert.rejects(() => failingDel, /disk busy/);
  await waiterBarrier; // resolves cleanly despite deletion failure
  assert.deepEqual(await Promise.all([clearPromise, duplicateClear]), [
    { cleared: true },
    { cleared: true },
  ]);
  assert.equal(coordinator.inspectionBarrier("9"), null);

  // 3. deleteArtifact called while clearCache is active waits until clear finishes
  const holdClear = deferred();
  const clearEntered = deferred();
  const order = [];
  const activeClear = coordinator.clearCache(async () => {
    order.push("clear-start");
    clearEntered.resolve();
    await holdClear.promise;
    order.push("clear-end");
    return { cleared: true };
  });
  await clearEntered.promise;

  const queuedDel = coordinator.deleteArtifact("12", async () => {
    order.push("delete-after-clear");
    return { deleted: "12" };
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["clear-start"]);

  holdClear.resolve();
  await Promise.all([activeClear, queuedDel]);
  assert.deepEqual(order, ["clear-start", "clear-end", "delete-after-clear"]);
});

test("pr-artifact-explorer cache inspects ZIP streams, deduplicates concurrent downloads, validates bounds, and refreshes mismatched repos offline", async (t) => {
  await clearArtifactCache();
  const origFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = origFetch;
    await clearArtifactCache();
  });

  // Invalid artifact IDs reject synchronously/immediately
  for (const badId of [0, -4, "not-an-id", ""]) {
    await assert.rejects(
      () => inspectArtifact("test-token", "octo/demo", badId),
      /Artifact id must be a positive integer/,
    );
  }

  // Expired artifact and >4 GiB artifact reject cleanly and emit stage: "error"
  globalThis.fetch = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/artifacts/10")) {
      return jsonResponse({
        id: 10,
        name: "expired-logs",
        size_in_bytes: 128,
        expired: true,
      });
    }
    if (pathname.endsWith("/artifacts/11")) {
      return jsonResponse({
        id: 11,
        name: "huge-bundle",
        size_in_bytes: MAX_ARCHIVE_BYTES + 100,
        expired: false,
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const expiredEvents = [];
  await assert.rejects(
    () =>
      inspectArtifact("test-token", "octo/demo", 10, {
        onProgress: (ev) => expiredEvents.push(ev),
      }),
    /expired/,
  );
  assert.equal(expiredEvents.at(-1)?.stage, "error");

  const oversizedEvents = [];
  await assert.rejects(
    () =>
      inspectArtifact("test-token", "octo/demo", 11, {
        onProgress: (ev) => oversizedEvents.push(ev),
      }),
    /exceeds the 4 GiB ZIP download limit/,
  );
  assert.equal(oversizedEvents.at(-1)?.stage, "error");

  // Corrupt non-ZIP payload cleans up temporary/archive/metadata files on indexing failure
  globalThis.fetch = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/artifacts/12")) {
      return jsonResponse({ id: 12, name: "corrupt-zip", size_in_bytes: 16, expired: false });
    }
    if (pathname.endsWith("/artifacts/12/zip")) {
      return zipStreamResponse(Buffer.from("not-a-valid-zip!"));
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  await assert.rejects(() => inspectArtifact("test-token", "octo/demo", 12), /not a valid ZIP/);
  assert.equal(await getCachedArtifact(12), null);

  // Concurrent inspectArtifact deduplicates network transfer, fans out progress, and caches result
  const zipAlpha = buildZipBuffer([
    { name: "docs/nested.html", data: "<h1>Nested Docs</h1>" },
    { name: "logs/build.txt", data: "Build succeeded in 1.2s\n" },
  ]);
  const releaseDownload = deferred();
  let zipDownloads = 0;

  globalThis.fetch = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/artifacts/21")) {
      return jsonResponse({
        id: 21,
        name: "ci-docs",
        size_in_bytes: zipAlpha.length,
        expired: false,
      });
    }
    if (pathname.endsWith("/artifacts/21/zip")) {
      zipDownloads += 1;
      await releaseDownload.promise;
      return zipStreamResponse(zipAlpha);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const stagesA = [];
  const stagesB = [];
  const p1 = inspectArtifact("test-token", "octo/alpha", 21, {
    onProgress: (ev) => stagesA.push(ev.stage),
  });
  const p2 = inspectArtifact("test-token", "octo/alpha", "21", {
    onProgress: (ev) => stagesB.push(ev.stage),
  });
  await new Promise((r) => setImmediate(r));
  releaseDownload.resolve();

  const [meta1, meta2] = await Promise.all([p1, p2]);
  assert.equal(zipDownloads, 1);
  assert.equal(meta1.repository, "octo/alpha");
  assert.equal(meta2.artifact.name, "ci-docs");
  assert.ok(stagesA.includes("preparing") && stagesA.includes("ready"));
  assert.ok(stagesB.includes("indexing") && stagesB.includes("ready"));

  // Warm cache hit emits cached:true without hitting fetch again
  globalThis.fetch = async () => {
    throw new Error("should not fetch on warm cache hit");
  };
  const warmEvents = [];
  const warmMeta = await inspectArtifact("test-token", "octo/alpha", 21, {
    onProgress: (ev) => warmEvents.push(ev),
  });
  assert.equal(warmMeta.repository, "octo/alpha");
  assert.equal(warmEvents.length, 1);
  assert.equal(warmEvents[0].cached, true);

  // Inspecting the same numeric id under a different repository evicts stale cache and re-fetches
  const zipBeta = buildZipBuffer([{ name: "index.html", data: "<!doctype html><title>Site</title>" }]);
  globalThis.fetch = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/artifacts/21")) {
      return jsonResponse({
        id: 21,
        name: "beta-site",
        size_in_bytes: zipBeta.length,
        expired: false,
      });
    }
    if (pathname.endsWith("/artifacts/21/zip")) {
      return zipStreamResponse(zipBeta);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const replacedMeta = await inspectArtifact("test-token", "octo/beta", 21);
  assert.equal(replacedMeta.repository, "octo/beta");
  assert.equal(replacedMeta.analysis.primary.kind, "static-site");
});

test("pr-artifact-explorer entry readers, summary sanitizer, and delete/clear abort handlers manage cached files cleanly", async (t) => {
  await clearArtifactCache();
  const origFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = origFetch;
    await clearArtifactCache();
  });

  await assert.rejects(
    () => getCachedEntry(404, "missing.txt"),
    /Artifact is not cached/,
  );

  // Populate two artifacts: #31 has nested HTML only (no root index.html), #32 has root index.html
  const nestedHtmlZip = buildZipBuffer([
    { name: "sub/report.html", data: "<p>Subdir report</p>" },
    { name: "notes.txt", data: "Hello artifact notes!" },
  ]);
  const rootSiteZip = buildZipBuffer([
    { name: "index.html", data: "<!doctype html><h1>Root Site</h1>" },
  ]);

  globalThis.fetch = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/artifacts/31")) {
      return jsonResponse({ id: 31, name: "nested-html", size_in_bytes: nestedHtmlZip.length, expired: false });
    }
    if (pathname.endsWith("/artifacts/31/zip")) {
      return zipStreamResponse(nestedHtmlZip);
    }
    if (pathname.endsWith("/artifacts/32")) {
      return jsonResponse({ id: 32, name: "root-site", size_in_bytes: rootSiteZip.length, expired: false });
    }
    if (pathname.endsWith("/artifacts/32/zip")) {
      return zipStreamResponse(rootSiteZip);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await inspectArtifact("test-token", "octo/demo", 31);
  await inspectArtifact("test-token", "octo/demo", 32);

  // getCachedArtifact touch:false preserves lastAccessedAt; touch:true updates it
  const untouchedMeta = await getCachedArtifact(31, { touch: false });
  assert.equal(untouchedMeta.artifact.name, "nested-html");

  const readNote = await readCachedEntry(31, "notes.txt", 1024);
  assert.equal(readNote.content.toString("utf8"), "Hello artifact notes!");
  await assert.rejects(() => readCachedEntry(31, "notes.txt", 5), /too large for an inline preview/);
  await assert.rejects(() => getCachedEntry(31, "absent.txt"), /File was not found/);

  // Inject a corrupt metadata file (99.json) to verify getCacheSummary records errors without throwing
  fs.writeFileSync(path.join(CACHE_ROOT, "99.json"), "{corrupt-metadata", "utf8");

  const summary = await getCacheSummary();
  assert.equal(summary.count, 2);
  assert.ok(summary.totalBytes > 0);
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0].id, "99");

  const item31 = summary.artifacts.find((a) => a.id === "31");
  const item32 = summary.artifacts.find((a) => a.id === "32");
  // Artifact #31 had nested html without root index.html -> inspectEntries fell back to notes.txt
  assert.equal(item31.primary?.kind, "text");
  assert.equal(item32.primary?.kind, "static-site");

  // Legacy cached metadata with primary.kind="html" and no root index.html is sanitized to null
  const meta31Path = path.join(CACHE_ROOT, "31.json");
  const legacyMeta31 = JSON.parse(fs.readFileSync(meta31Path, "utf8"));
  legacyMeta31.analysis.primary = { kind: "html", path: "sub/report.html", label: "HTML report" };
  fs.writeFileSync(meta31Path, JSON.stringify(legacyMeta31), "utf8");
  const legacySummary = await getCacheSummary();
  assert.equal(legacySummary.artifacts.find((a) => a.id === "31")?.primary, null);

  // deleteCachedArtifact aborts an in-flight download for that artifact id
  const downloadStarted = deferred();
  globalThis.fetch = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/artifacts/55")) {
      return jsonResponse({ id: 55, name: "inflight", size_in_bytes: 64, expired: false });
    }
    if (pathname.endsWith("/artifacts/55/zip")) {
      downloadStarted.resolve();
      return await new Promise((_, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(init.signal.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const inflightInspect = inspectArtifact("test-token", "octo/demo", 55);
  const inflightRejection = assert.rejects(inflightInspect, /Cache cleared/);
  await downloadStarted.promise;
  const [deleted] = await Promise.all([deleteCachedArtifact(55), inflightRejection]);
  assert.deepEqual(deleted, { deleted: "55" });

  // clearArtifactCache removes all remaining cached artifacts and corrupt files
  const cleared = await clearArtifactCache();
  assert.deepEqual(cleared, { cleared: true });
  const emptySummary = await getCacheSummary();
  assert.equal(emptySummary.count, 0);
  assert.equal(emptySummary.errors.length, 0);
});
