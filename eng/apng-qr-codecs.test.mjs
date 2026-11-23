import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { test } from "node:test";
import {
  assembleApng,
  encodeRgbaPng,
  solidColorPng,
} from "../extensions/apng-studio/apng.mjs";
import { encodeQr } from "../extensions/apng-studio/qr.mjs";

const PNG_SIG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function parseChunks(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), PNG_SIG);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let off = 8;
  while (off < bytes.length) {
    assert.ok(off + 12 <= bytes.length, "chunk header + CRC must fit in buffer");
    const len = view.getUint32(off);
    const type = Buffer.from(bytes.subarray(off + 4, off + 8)).toString("latin1");
    const data = bytes.subarray(off + 8, off + 8 + len);
    const expectedCrc = view.getUint32(off + 8 + len);
    const actualCrc = crc32(bytes.subarray(off + 4, off + 8 + len));
    assert.equal(actualCrc, expectedCrc, `CRC mismatch on ${type} chunk`);
    chunks.push({ type, data });
    off += 12 + len;
  }
  assert.equal(off, bytes.length);
  return chunks;
}

function makeRawChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

test("encodeRgbaPng and solidColorPng emit valid CRC-checked RGBA8 PNGs and round-trip scanlines", () => {
  assert.throws(
    () => encodeRgbaPng(2, 2, new Uint8Array(15)),
    /rgba length does not match width\*height\*4/,
  );

  const rgba = Uint8Array.from([
    255, 0, 0, 255,   0, 255, 0, 128,
    0, 0, 255, 64,    255, 255, 255, 0,
  ]);
  const png = encodeRgbaPng(2, 2, rgba);
  const chunks = parseChunks(png);
  assert.deepEqual(chunks.map((c) => c.type), ["IHDR", "IDAT", "IEND"]);

  const ihdrView = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset, chunks[0].data.byteLength);
  assert.equal(ihdrView.getUint32(0), 2);
  assert.equal(ihdrView.getUint32(4), 2);
  assert.equal(chunks[0].data[8], 8); // bit depth
  assert.equal(chunks[0].data[9], 6); // RGBA

  const inflated = inflateSync(chunks[1].data);
  // 2 rows * (1 filter byte + 8 RGBA bytes) = 18 bytes
  assert.equal(inflated.length, 18);
  assert.equal(inflated[0], 0);
  assert.equal(inflated[9], 0);
  assert.deepEqual(Uint8Array.from(inflated.subarray(1, 9)), rgba.subarray(0, 8));
  assert.deepEqual(Uint8Array.from(inflated.subarray(10, 18)), rgba.subarray(8, 16));

  const solid = solidColorPng(3, 2, { r: 10, g: 20, b: 30, a: 240 });
  const solidChunks = parseChunks(solid);
  const solidRaw = inflateSync(solidChunks[1].data);
  assert.equal(solidRaw.length, 2 * (1 + 3 * 4));
  assert.deepEqual(Array.from(solidRaw.subarray(1, 5)), [10, 20, 30, 240]);
});

test("assembleApng builds spec-compliant acTL/fcTL/fdAT sequences, normalizes first-frame disposeOp, and supports hiddenFirst", () => {
  const f0 = solidColorPng(4, 3, { r: 255, g: 0, b: 0, a: 255 });
  const f1 = solidColorPng(4, 3, { r: 0, g: 255, b: 0, a: 255 });
  const f2 = solidColorPng(4, 3, { r: 0, g: 0, b: 255, a: 255 });

  // Normal multi-frame animation; disposeOp=2 on first animated frame must normalize to 1 (BACKGROUND)
  const apng = assembleApng(
    [
      { png: f0, delayMs: 120, disposeOp: 2, blendOp: 1 },
      { png: f1, delayNum: 1, delayDen: 0, disposeOp: 2, blendOp: 5 }, // delayDen=0 -> 1000, blendOp clamped to 1
      { png: f2, delayNum: 250, delayDen: 1000, disposeOp: 0, blendOp: 0 },
    ],
    { loops: 3 },
  );

  const chunks = parseChunks(apng);
  assert.deepEqual(
    chunks.map((c) => c.type),
    ["IHDR", "acTL", "fcTL", "IDAT", "fcTL", "fdAT", "fcTL", "fdAT", "IEND"],
  );

  const actl = new DataView(chunks[1].data.buffer, chunks[1].data.byteOffset, 8);
  assert.equal(actl.getUint32(0), 3); // num_frames
  assert.equal(actl.getUint32(4), 3); // num_plays

  // Sequence numbers across fcTL(0), fcTL(1), fdAT(2), fcTL(3), fdAT(4)
  const seqChunks = chunks.filter((c) => c.type === "fcTL" || c.type === "fdAT");
  const seqNums = seqChunks.map((c) =>
    new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength).getUint32(0),
  );
  assert.deepEqual(seqNums, [0, 1, 2, 3, 4]);

  // First fcTL normalized disposeOp 2 -> 1; second fcTL preserved disposeOp 2 and clamped blendOp 5 -> 1
  const fctl0 = new DataView(chunks[2].data.buffer, chunks[2].data.byteOffset, 26);
  assert.equal(fctl0.getUint16(20), 120);
  assert.equal(fctl0.getUint16(22), 1000);
  assert.equal(chunks[2].data[24], 1);
  assert.equal(chunks[2].data[25], 1);

  const fctl1 = new DataView(chunks[4].data.buffer, chunks[4].data.byteOffset, 26);
  assert.equal(fctl1.getUint16(20), 1);
  assert.equal(fctl1.getUint16(22), 1000);
  assert.equal(chunks[4].data[24], 2);
  assert.equal(chunks[4].data[25], 1);

  // hiddenFirst=true omits fcTL before default IDAT and starts animation at frame 1
  const hidden = assembleApng(
    [
      { png: f0, delayMs: 50 },
      { png: f1, delayMs: 80, disposeOp: 2 },
      { png: f2, delayMs: 90, disposeOp: 2 },
    ],
    { hiddenFirst: true, loops: 0 },
  );
  const hiddenChunks = parseChunks(hidden);
  assert.deepEqual(
    hiddenChunks.map((c) => c.type),
    ["IHDR", "acTL", "IDAT", "fcTL", "fdAT", "fcTL", "fdAT", "IEND"],
  );
  const hiddenActl = new DataView(hiddenChunks[1].data.buffer, hiddenChunks[1].data.byteOffset, 8);
  assert.equal(hiddenActl.getUint32(0), 2);
  assert.equal(hiddenActl.getUint32(4), 0);
  // Frame 1 is the first animated frame under hiddenFirst, so its disposeOp 2 -> 1
  assert.equal(hiddenChunks[3].data[24], 1);
  assert.equal(hiddenChunks[5].data[24], 2);
});

test("assembleApng rejects empty frame lists, mismatched dimensions, and malformed or truncated PNGs", () => {
  const valid = solidColorPng(2, 2, { r: 1, g: 2, b: 3, a: 255 });
  const otherSize = solidColorPng(4, 2, { r: 1, g: 2, b: 3, a: 255 });

  assert.throws(() => assembleApng([]), /at least one frame/);
  assert.throws(() => assembleApng([{ png: valid }, { png: otherSize }]), /share dimensions/);
  assert.throws(() => assembleApng([{ png: new Uint8Array([1, 2, 3]) }]), /Not a PNG/);
  assert.throws(() => assembleApng([{ png: null }]), /Not a PNG/);

  // Truncated mid-chunk must throw instead of silently clamping via subarray()
  const truncatedMidChunk = valid.subarray(0, valid.length - 6);
  assert.throws(() => assembleApng([{ png: truncatedMidChunk }]), /PNG chunk truncated|PNG missing IEND/);

  // Invalid IHDR length (< 13 bytes)
  const shortIhdrPng = new Uint8Array([
    ...PNG_SIG,
    ...makeRawChunk("IHDR", new Uint8Array(8)),
    ...makeRawChunk("IDAT", new Uint8Array([1, 2, 3])),
    ...makeRawChunk("IEND", new Uint8Array(0)),
  ]);
  assert.throws(() => assembleApng([{ png: shortIhdrPng }]), /invalid IHDR length/);

  // Missing IHDR
  const noIhdrPng = new Uint8Array([
    ...PNG_SIG,
    ...makeRawChunk("IDAT", new Uint8Array([1, 2, 3])),
    ...makeRawChunk("IEND", new Uint8Array(0)),
  ]);
  assert.throws(() => assembleApng([{ png: noIhdrPng }]), /missing IHDR/);

  // Missing IDAT
  const ihdr13 = new Uint8Array(13);
  new DataView(ihdr13.buffer).setUint32(0, 1);
  new DataView(ihdr13.buffer).setUint32(4, 1);
  ihdr13[8] = 8;
  ihdr13[9] = 6;
  const noIdatPng = new Uint8Array([
    ...PNG_SIG,
    ...makeRawChunk("IHDR", ihdr13),
    ...makeRawChunk("IEND", new Uint8Array(0)),
  ]);
  assert.throws(() => assembleApng([{ png: noIdatPng }]), /missing IDAT/);

  // Missing IEND
  const noIendPng = new Uint8Array([
    ...PNG_SIG,
    ...makeRawChunk("IHDR", ihdr13),
    ...makeRawChunk("IDAT", new Uint8Array([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
  ]);
  assert.throws(() => assembleApng([{ png: noIendPng }]), /missing IEND/);
});

test("encodeQr selects versions 1..10, preserves finder/timing/version invariants, and validates forceMask", () => {
  // <=14 bytes -> Version 1 (21x21); 15 bytes -> Version 2 (25x25 with alignment pattern)
  const v1 = encodeQr("http://10.0.0");
  assert.equal(v1.version, 1);
  assert.equal(v1.size, 21);
  assert.equal(v1.matrix.length, 21);
  assert.ok(v1.mask >= 0 && v1.mask <= 7);

  const v2 = encodeQr("http://10.0.0.5");
  assert.equal(v2.version, 2);
  assert.equal(v2.size, 25);
  assert.equal(v2.matrix[18][18], 1); // alignment pattern center at (18, 18)

  // Verify 7x7 finder corners, dark module at (size - 8, 8), and alternating timing pattern
  for (const [fr, fc] of [[0, 0], [0, v1.size - 7], [v1.size - 7, 0]]) {
    assert.equal(v1.matrix[fr][fc], 1);
    assert.equal(v1.matrix[fr + 3][fc + 3], 1);
    assert.equal(v1.matrix[fr + 1][fc + 1], 0);
  }
  assert.equal(v1.matrix[v1.size - 8][8], 1);
  assert.equal(v1.matrix[6][8], 1);
  assert.equal(v1.matrix[6][9], 0);
  assert.equal(v1.matrix[6][10], 1);

  // Version 7+ (>= 125 bytes) exercises multi-block Reed-Solomon interleaving + 18-bit BCH version info
  const v7Text = "https://example.com/lan-preview/" + "a".repeat(100);
  const v7 = encodeQr(v7Text);
  assert.ok(v7.version >= 7 && v7.version <= 10);
  assert.equal(v7.size, v7.version * 4 + 17);
  // Symmetric version info transpose check: m[i][size - 11 + j] === m[size - 11 + j][i]
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 3; j++) {
      assert.equal(v7.matrix[i][v7.size - 11 + j], v7.matrix[v7.size - 11 + j][i]);
    }
  }

  // Forced masks 0..7 produce distinct data masks while automatic pick matches one of them
  const maskedMatrices = [];
  for (let m = 0; m < 8; m++) {
    const res = encodeQr("Hello QR ✨", { forceMask: m });
    assert.equal(res.mask, m);
    maskedMatrices.push(JSON.stringify(res.matrix));
  }
  assert.equal(new Set(maskedMatrices).size, 8);
  const auto = encodeQr("Hello QR ✨");
  assert.equal(JSON.stringify(auto.matrix), maskedMatrices[auto.mask]);

  // Invalid forceMask values throw RangeError instead of TypeError inside applyMask
  for (const badMask of [-1, 8, 1.5, Number.NaN, "0"]) {
    assert.throws(() => encodeQr("test", { forceMask: badMask }), RangeError);
  }

  // Payload exceeding version 10 capacity (213 data codewords - 3 header bytes = 210 bytes max) throws
  assert.throws(() => encodeQr("x".repeat(250)), /Data too long for QR versions 1-10/);
});
