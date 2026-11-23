import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Transform } from "node:stream";
import { deflateRawSync } from "node:zlib";
import { test } from "node:test";
import {
  analyzeArtifact,
  extensionOf,
  hasRootIndexHtml,
  isInlineTextKind,
  kindForPath,
  mimeForPath,
} from "../extensions/pr-artifact-explorer/detector.mjs";
import { ExpiringPromiseCache } from "../extensions/pr-artifact-explorer/memory-cache.mjs";
import {
  findZipEntry,
  readEntryPrefix,
  readZipEntry,
  readZipIndex,
  streamZipEntry,
} from "../extensions/pr-artifact-explorer/zip.mjs";

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

function makeTempDir(t, prefix = "awesome-copilot-prae-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Build a minimal synthetic ZIP archive buffer with full control over methods,
 * flags, unix modes, CRCs, declared sizes, and comments for offline unit tests.
 */
function buildZipBuffer(entries, { archiveComment = "", disk = 0 } = {}) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const spec of entries) {
    const rawData = Buffer.isBuffer(spec.data)
      ? spec.data
      : Buffer.from(spec.data ?? "", "utf8");
    const method = spec.method ?? 8;
    const flags = spec.flags ?? 0x0800; // UTF-8 by default
    const nameBytes = Buffer.from(spec.name, flags & 0x0800 ? "utf8" : "latin1");
    const compressed =
      spec.rawCompressed ?? (method === 0 ? rawData : deflateRawSync(rawData));
    const entryCrc = spec.crc32 ?? crc32(rawData);
    const uncompressedSize = spec.uncompressedSize ?? rawData.length;
    const compressedSize = spec.compressedSize ?? compressed.length;
    const modDate = spec.modDate ?? ((2026 - 1980) << 9) | (3 << 5) | 15;
    const modTime = spec.modTime ?? (10 << 11) | (30 << 5) | 10;
    const unixMode = spec.unixMode ?? (spec.name.endsWith("/") ? 0o040755 : 0o100644);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(modTime, 10);
    localHeader.writeUInt16LE(modDate, 12);
    localHeader.writeUInt32LE(entryCrc >>> 0, 14);
    localHeader.writeUInt32LE(compressedSize >>> 0, 18);
    localHeader.writeUInt32LE(uncompressedSize >>> 0, 22);
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
    centralHeader.writeUInt32LE(compressedSize >>> 0, 20);
    centralHeader.writeUInt32LE(uncompressedSize >>> 0, 24);
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
  const commentBytes = Buffer.from(archiveComment, "utf8");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(disk, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(commentBytes.length, 20);

  return Buffer.concat([...localParts, centralBuffer, eocd, commentBytes]);
}

test("zip reader indexes stored/deflated entries, streams with CRC+size verification, slices prefixes, and blocks unsafe archives", async (t) => {
  const dir = makeTempDir(t, "prae-zip-");
  const validZip = path.join(dir, "artifact.zip");
  const longText = "Line of log output for prefix and streaming tests.\n".repeat(40);

  fs.writeFileSync(
    validZip,
    buildZipBuffer(
      [
        { name: "docs/", data: "", method: 0 },
        { name: "docs/stored.txt", data: "Hello stored world!", method: 0 },
        { name: "docs/deflated.log", data: longText, method: 8 },
        { name: "docs/empty.txt", data: "", method: 0 },
        { name: "docs/link.txt", data: "target", method: 0, unixMode: 0o120777 }, // symlink -> unsupported
        { name: "docs/secret.txt", data: "cipher", method: 8, flags: 0x0801 }, // encrypted -> unsupported
      ],
      { archiveComment: "CI build artifact" },
    ),
  );

  const index = await readZipIndex(validZip);
  assert.equal(index.entries.length, 6);
  assert.equal(index.totalUncompressedBytes, "Hello stored world!".length + longText.length + "target".length + "cipher".length);

  const storedEntry = findZipEntry(index, "./docs\\stored.txt");
  assert.ok(storedEntry?.supported);
  assert.match(storedEntry.modifiedAt, /^2026-03-15T10:30:20\.000Z$/);
  assert.equal((await readZipEntry(validZip, storedEntry, 1024)).toString("utf8"), "Hello stored world!");
  assert.equal((await readEntryPrefix(validZip, storedEntry, 5)).toString("utf8"), "Hello");

  const deflatedEntry = findZipEntry(index, "docs/deflated.log");
  assert.ok(deflatedEntry?.supported);
  assert.equal((await readZipEntry(validZip, deflatedEntry, 10_000)).toString("utf8"), longText);
  assert.equal((await readEntryPrefix(validZip, deflatedEntry, 18)).toString("utf8"), longText.slice(0, 18));
  await assert.rejects(() => readZipEntry(validZip, deflatedEntry, 10), /too large for an inline preview/);

  // Stream deflated entry through uppercasing transform
  const sink = new PassThrough();
  const chunks = [];
  sink.on("data", (c) => chunks.push(c));
  const upper = new Transform({
    transform(chunk, _enc, cb) {
      cb(null, Buffer.from(chunk.toString("utf8").toUpperCase(), "utf8"));
    },
  });
  await streamZipEntry(validZip, deflatedEntry, sink, upper);
  assert.equal(Buffer.concat(chunks).toString("utf8"), longText.toUpperCase());

  // Empty entry streams 0 bytes cleanly and returns empty prefix
  const emptyEntry = findZipEntry(index, "docs/empty.txt");
  assert.equal((await readEntryPrefix(validZip, emptyEntry, 64)).length, 0);
  const emptySink = new PassThrough();
  await streamZipEntry(validZip, emptyEntry, emptySink);

  // Unsupported symlink/encrypted entries are rejected for reading and streaming
  const symlinkEntry = findZipEntry(index, "docs/link.txt");
  assert.equal(symlinkEntry.symlink, true);
  assert.equal(symlinkEntry.supported, false);
  assert.equal(await readEntryPrefix(validZip, symlinkEntry, 16), null);
  await assert.rejects(() => readZipEntry(validZip, symlinkEntry, 1024), /cannot be previewed/);
  await assert.rejects(() => streamZipEntry(validZip, symlinkEntry, new PassThrough()), /cannot be served/);

  const encryptedEntry = findZipEntry(index, "docs/secret.txt");
  assert.equal(encryptedEntry.encrypted, true);
  assert.equal(encryptedEntry.supported, false);

  // Rejects path traversal in findZipEntry and central directory
  assert.throws(() => findZipEntry(index, "../outside.txt"), /unsafe path/);
  assert.throws(() => findZipEntry(index, "C:/windows/win.ini"), /unsafe path/);
  assert.throws(() => findZipEntry(index, "bad\0name"), /invalid file name/);

  const traversalZip = path.join(dir, "traversal.zip");
  fs.writeFileSync(traversalZip, buildZipBuffer([{ name: "../../etc/passwd", data: "nope" }]));
  await assert.rejects(() => readZipIndex(traversalZip), /unsafe path/);

  const multiDiskZip = path.join(dir, "multidisk.zip");
  fs.writeFileSync(multiDiskZip, buildZipBuffer([{ name: "a.txt", data: "ok" }], { disk: 1 }));
  await assert.rejects(() => readZipIndex(multiDiskZip), /Multi-disk/);

  const tinyZip = path.join(dir, "tiny.zip");
  fs.writeFileSync(tinyZip, "not-a-zip");
  await assert.rejects(() => readZipIndex(tinyZip), /not a valid ZIP/);

  // Bad CRC and declared-size mismatch (zip bomb guard) fail on both readZipEntry and streamZipEntry
  const badCrcZip = path.join(dir, "bad-crc.zip");
  fs.writeFileSync(badCrcZip, buildZipBuffer([{ name: "corrupt.txt", data: "actual payload", crc32: 0x12345678 }]));
  const badCrcIdx = await readZipIndex(badCrcZip);
  await assert.rejects(() => readZipEntry(badCrcZip, badCrcIdx.entries[0], 1024), /checksum failed/);
  await assert.rejects(() => streamZipEntry(badCrcZip, badCrcIdx.entries[0], new PassThrough()), /checksum failed/);

  const bombZip = path.join(dir, "bomb.zip");
  fs.writeFileSync(
    bombZip,
    buildZipBuffer([{ name: "bomb.txt", data: "x".repeat(200), method: 8, uncompressedSize: 20 }]),
  );
  const bombIdx = await readZipIndex(bombZip);
  await assert.rejects(() => readZipEntry(bombZip, bombIdx.entries[0], 1024), /decompressed past declared size/);
  await assert.rejects(() => streamZipEntry(bombZip, bombIdx.entries[0], new PassThrough()), /decompressed past declared size/);
});

test("ExpiringPromiseCache enforces constructor bounds, deduplicates concurrent loads, handles failures, and evicts LRU non-pending entries", async () => {
  assert.throws(() => new ExpiringPromiseCache({ maxEntries: 0, ttlMs: 1000 }), TypeError);
  assert.throws(() => new ExpiringPromiseCache({ maxEntries: 2, ttlMs: 0 }), TypeError);

  const cache = new ExpiringPromiseCache({ maxEntries: 2, ttlMs: 50 });
  await assert.rejects(() => cache.get("k", null), TypeError);

  // Deduplicates concurrent callers on cache miss
  let calls = 0;
  const [v1, v2] = await Promise.all([
    cache.get("alpha", async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return "value-1";
    }),
    cache.get("alpha", async () => {
      calls += 1;
      return "value-2";
    }),
  ]);
  assert.equal(calls, 1);
  assert.equal(v1, "value-1");
  assert.equal(v2, "value-1");
  assert.equal(cache.peek("alpha"), "value-1");

  // Failed force-refresh and failed cold load both clean up rejected entries without poisoning cache
  await assert.rejects(
    () => cache.get("alpha", async () => { throw new Error("transient"); }, { force: true }),
    /transient/,
  );
  assert.equal(cache.peek("alpha"), undefined);

  await assert.rejects(
    () => cache.get("cold-fail", async () => { throw new Error("boom"); }),
    /boom/,
  );
  assert.equal(cache.peek("cold-fail"), undefined);

  // LRU eviction: touching alpha keeps alpha when gamma is inserted beyond maxEntries=2
  cache.set("alpha", "value-1");
  cache.set("beta", "B");
  assert.equal(cache.peek("alpha"), "value-1"); // touch alpha -> beta is now oldest
  cache.set("gamma", "G");
  assert.equal(cache.peek("beta"), undefined);
  assert.equal(cache.peek("alpha"), "value-1");
  assert.equal(cache.peek("gamma"), "G");

  // TTL expiration + delete + clear
  const shortCache = new ExpiringPromiseCache({ maxEntries: 3, ttlMs: 15 });
  shortCache.set("ephemeral", 42);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(shortCache.peek("ephemeral"), undefined);

  cache.delete("alpha");
  assert.equal(cache.peek("alpha"), undefined);
  cache.clear();
  assert.equal(cache.peek("gamma"), undefined);
});

test("detector classifies extensions/MIME types, sniffs asciinema headers, and prioritizes primary artifact previews", async () => {
  assert.equal(extensionOf("dir/sub/Report.TRX"), ".trx");
  assert.equal(extensionOf(".gitignore"), "");
  assert.equal(mimeForPath("bundle.mjs"), "text/javascript; charset=utf-8");
  assert.equal(mimeForPath("unknown.bin"), "application/octet-stream");

  assert.equal(kindForPath("demo.cast"), "asciinema");
  assert.equal(kindForPath("results.trx"), "trx");
  assert.equal(kindForPath("page.htm"), "html");
  assert.equal(kindForPath("photo.webp"), "image");
  assert.equal(kindForPath("guide.pdf"), "pdf");
  assert.equal(kindForPath("README.md"), "markdown");
  assert.equal(kindForPath("trace.map"), "json");
  assert.equal(kindForPath("proj.csproj"), "xml");
  assert.equal(kindForPath("script.ps1"), "text");
  assert.equal(kindForPath("pkg.tgz"), "archive");
  assert.equal(kindForPath("blob.wasm"), "binary");

  assert.equal(isInlineTextKind("trx"), true);
  assert.equal(isInlineTextKind("image"), false);
  assert.equal(hasRootIndexHtml([{ name: "./Index.HTML", supported: true }]), true);

  // Sniffs extensionless terminal recording via v2 header while rejecting oversized/invalid recordings
  const sniffed = await analyzeArtifact(
    {
      totalUncompressedBytes: 500,
      entries: [
        { name: "logs/", directory: true, supported: false, compressedSize: 0, uncompressedSize: 0 },
        { name: "logs/terminal-output.log", directory: false, supported: true, compressedSize: 50, uncompressedSize: 120 },
        { name: "logs/session-huge.log", directory: false, supported: true, compressedSize: 50, uncompressedSize: 9 * 1024 * 1024 },
        { name: "docs/index.html", directory: false, supported: true, compressedSize: 20, uncompressedSize: 40 },
      ],
    },
    async (entry) => {
      if (entry.name === "logs/terminal-output.log") {
        return Buffer.from('{"version":2,"width":120,"height":30}\n[0.1,"o","hi"]\n', "utf8");
      }
      return Buffer.from("not json", "utf8");
    },
  );
  assert.deepEqual(sniffed.primary, {
    kind: "asciinema",
    path: "logs/terminal-output.log",
    label: "Asciinema recording",
  });
  assert.equal(sniffed.fileCount, 3);
  assert.equal(sniffed.counts.asciinema, 1);

  // Root index.html wins as static-site; otherwise shallowest image/markdown/JSON/XML/text wins
  const siteAnalysis = await analyzeArtifact(
    {
      totalUncompressedBytes: 100,
      entries: [{ name: "index.html", directory: false, supported: true, compressedSize: 10, uncompressedSize: 20 }],
    },
    async () => null,
  );
  assert.equal(siteAnalysis.primary.kind, "static-site");

  const xmlAnalysis = await analyzeArtifact(
    {
      totalUncompressedBytes: 100,
      entries: [
        { name: "a/b/deep.xml", directory: false, supported: true, compressedSize: 10, uncompressedSize: 20 },
        { name: "top.csproj", directory: false, supported: true, compressedSize: 10, uncompressedSize: 20 },
      ],
    },
    async () => null,
  );
  assert.deepEqual(xmlAnalysis.primary, {
    kind: "xml",
    path: "top.csproj",
    label: "XML code",
  });
});
