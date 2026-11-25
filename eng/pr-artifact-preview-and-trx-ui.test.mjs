import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import vm from "node:vm";
import { deflateRawSync } from "node:zlib";
import { after, test } from "node:test";
import { ROOT_FOLDER } from "./constants.mjs";

// Isolate COPILOT_HOME before importing pr-artifact-explorer modules
const ISOLATED_COPILOT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-prae-prev-"));
const PREVIOUS_COPILOT_HOME = process.env.COPILOT_HOME;
process.env.COPILOT_HOME = ISOLATED_COPILOT_HOME;

const { invalidateAccounts } = await import("../extensions/pr-artifact-explorer/accounts.mjs");
const { inspectArtifact } = await import("../extensions/pr-artifact-explorer/cache.mjs");
const {
  startStaticPreview,
  stopAllStaticPreviews,
  stopStaticPreviewsForArtifact,
  stopStaticPreviewsForOrigin,
} = await import("../extensions/pr-artifact-explorer/preview.mjs");
const { CAPABILITY_TOKEN_HEADER } = await import("../extensions/pr-artifact-explorer/security.mjs");
const {
  broadcastCache,
  closeAllPreviews,
  contentDeliveryMode,
  navigateInstance,
  startInstance,
  stopInstance,
} = await import("../extensions/pr-artifact-explorer/server.mjs");

after(async () => {
  await closeAllPreviews().catch(() => {});
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
    const compressed = method === 8 ? deflateRawSync(rawData) : rawData;
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

function installInMemoryServerHook(t, basePort = 49100) {
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
      const origin = new URL(urlOrOrigin).origin;
      return serversByOrigin.get(origin) ?? null;
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
    buffer: rawBody,
    text: rawBody.toString("utf8"),
  };
}

function parseSimpleXml(xmlSource) {
  function decodeEntities(str) {
    return str
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&#39;", "'")
      .replaceAll("&amp;", "&");
  }
  function makeElement(tagName, attrs = {}) {
    const attrList = Object.entries(attrs).map(([name, value]) => ({ name, value }));
    const attrMap = new Map(Object.entries(attrs));
    return {
      tagName,
      localName: tagName.includes(":") ? tagName.split(":").pop() : tagName,
      attributes: attrList,
      children: [],
      _textParts: [],
      getAttribute: (name) => attrMap.get(name) ?? null,
      get textContent() {
        return this._textParts.join("") + this.children.map((c) => c.textContent).join("");
      },
      getElementsByTagName(query) {
        const out = [];
        const visit = (node) => {
          for (const child of node.children) {
            if (query === "*" || child.tagName === query || child.localName === query) out.push(child);
            visit(child);
          }
        };
        visit(this);
        return out;
      },
    };
  }
  const cleaned = xmlSource
    .replace(/^\uFEFF/, "")
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  const rootHolder = makeElement("#document");
  const stack = [rootHolder];
  const tokenRe = /<\/?([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let lastIndex = 0;
  let match;
  while ((match = tokenRe.exec(cleaned)) !== null) {
    if (match.index !== lastIndex) return errorDoc("Malformed XML");
    lastIndex = tokenRe.lastIndex;
    if (match[4] !== undefined) {
      stack[stack.length - 1]._textParts.push(decodeEntities(match[4]));
      continue;
    }
    const full = match[0];
    const tag = match[1];
    const rawAttrs = match[2] ?? "";
    const selfClosing = match[3] === "/";
    if (full.startsWith("</")) {
      if (stack.length <= 1 || stack[stack.length - 1].tagName !== tag) return errorDoc("Mismatched tag");
      stack.pop();
      continue;
    }
    const attrs = {};
    const attrRe = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let attrMatch;
    while ((attrMatch = attrRe.exec(rawAttrs)) !== null) {
      attrs[attrMatch[1]] = decodeEntities(attrMatch[2] ?? attrMatch[3] ?? "");
    }
    const el = makeElement(tag, attrs);
    stack[stack.length - 1].children.push(el);
    if (!selfClosing) stack.push(el);
  }
  if (lastIndex !== cleaned.length || stack.length !== 1 || rootHolder.children.length !== 1) {
    return errorDoc("Unclosed XML");
  }
  return {
    documentElement: rootHolder.children[0],
    getElementsByTagName(query) {
      const root = rootHolder.children[0];
      return (query === "*" || root.tagName === query ? [root] : []).concat(
        root.getElementsByTagName(query),
      );
    },
  };
  function errorDoc(msg) {
    const errNode = makeElement("parsererror");
    errNode._textParts.push(msg);
    return { documentElement: errNode, getElementsByTagName: () => [errNode] };
  }
}

function createHtmlDomNode(tag = "div", attrs = {}) {
  const VOID_TAGS = new Set(["input", "img", "br", "hr", "meta", "link"]);
  const toCamel = (s) => s.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
  const dataset = {};
  const attrMap = new Map();
  let hidden = false;
  let value = "";

  for (const [k, v] of Object.entries(attrs)) {
    attrMap.set(k, v);
    if (k === "hidden") hidden = true;
    if (k === "value") value = v;
    if (k.startsWith("data-")) dataset[toCamel(k.slice(5))] = v;
  }

  let rawInner = "";
  let textVal = "";
  const node = {
    tagName: tag.toUpperCase(),
    dataset,
    children: [],
    get hidden() {
      return hidden;
    },
    set hidden(next) {
      hidden = Boolean(next);
    },
    get value() {
      return value;
    },
    set value(next) {
      value = String(next);
    },
    get textContent() {
      if (node.children.length === 0) return textVal;
      return textVal + node.children.map((c) => c.textContent).join("");
    },
    set textContent(next) {
      textVal = String(next);
      rawInner = textVal;
      node.children = [];
    },
    get innerHTML() {
      return rawInner;
    },
    set innerHTML(html) {
      rawInner = String(html);
      textVal = "";
      node.children = parseHtmlFragment(rawInner);
    },
    getAttribute: (name) => attrMap.get(name) ?? null,
    setAttribute(name, val) {
      attrMap.set(name, String(val));
      if (name.startsWith("data-")) dataset[toCamel(name.slice(5))] = String(val);
    },
    matches(selector) {
      if (selector.startsWith(".")) {
        const cls = (attrMap.get("class") ?? "").split(/\s+/);
        return cls.includes(selector.slice(1));
      }
      const attrParts = [...selector.matchAll(/\[([a-z0-9-]+)(?:="([^"]*)")?\]/gi)];
      if (attrParts.length > 0) {
        return attrParts.every(([, attrName, expected]) => {
          if (expected === undefined) return attrMap.has(attrName);
          return attrMap.get(attrName) === expected;
        });
      }
      return node.tagName.toLowerCase() === selector.toLowerCase();
    },
    querySelectorAll(selector) {
      const results = [];
      const walk = (parent) => {
        for (const child of parent.children) {
          if (child.matches(selector)) results.push(child);
          walk(child);
        }
      };
      walk(node);
      return results;
    },
    querySelector(selector) {
      return node.querySelectorAll(selector)[0] ?? null;
    },
  };

  function decodeHtml(s) {
    return s
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&amp;", "&");
  }

  function parseHtmlFragment(html) {
    const root = { children: [] };
    const stack = [root];
    const tagRe = /<\/?([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;
    let m;
    while ((m = tagRe.exec(html)) !== null) {
      if (m[3] !== undefined) {
        const current = stack[stack.length - 1];
        if (current !== root) current._appendText?.(decodeHtml(m[3]));
        continue;
      }
      const full = m[0];
      const tName = m[1].toLowerCase();
      const attrStr = m[2] ?? "";
      if (full.startsWith("</")) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const parsedAttrs = {};
      const attrRe = /([a-zA-Z0-9-:]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+)))?/g;
      let am;
      while ((am = attrRe.exec(attrStr)) !== null) {
        if (am[1] === "/") continue;
        parsedAttrs[am[1]] = decodeHtml(am[2] ?? am[3] ?? am[4] ?? "");
      }
      const child = createHtmlDomNode(tName, parsedAttrs);
      stack[stack.length - 1].children.push(child);
      const selfClosed = full.endsWith("/>") || VOID_TAGS.has(tName);
      if (!selfClosed) stack.push(child);
    }
    return root.children;
  }

  node._appendText = (txt) => {
    textVal += txt;
  };
  return node;
}

test("pr-artifact-explorer TrxPreview renders sorted outcomes, truncates long output, filters queries, and switches raw XML views", () => {
  const trxSource = fs.readFileSync(
    path.join(ROOT_FOLDER, "extensions", "pr-artifact-explorer", "assets", "trx-preview.js"),
    "utf8",
  );
  const sandbox = {
    DOMParser: class {
      parseFromString(xml) {
        return parseSimpleXml(xml);
      }
    },
    Intl,
    WeakMap,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(trxSource, sandbox);
  const { TrxPreview } = sandbox;

  const longStdout = "L".repeat(24_050);
  const trxXml = `<TestRun id="run-99" name="Nightly Matrix" runUser="ci-bot" computerName="build-01">
    <Times start="2026-03-20T01:00:00Z" finish="2026-03-20T02:15:00Z" />
    <ResultSummary outcome="Completed">
      <Counters total="4" passed="1" failed="1" notExecuted="1" />
    </ResultSummary>
    <Results>
      <UnitTestResult testName="AlphaPass" outcome="Passed" duration="00:00:02.500" />
      <UnitTestResult testName="BetaSkip" outcome="Inconclusive" duration="00:02:05.000" />
      <UnitTestResult testName="GammaCustom" outcome="CustomState" duration="00:00:25.400" />
      <UnitTestResult testName="DeltaCrash" className="Suite.Delta" outcome="Timeout" duration="00:00:00.450" dataRowInfo="3">
        <Output>
          <StdOut>${longStdout}</StdOut>
          <ErrorInfo><Message>Timed out waiting for worker</Message></ErrorInfo>
          <Properties>
            <Property><Key>Category</Key><Value>Integration</Value></Property>
            <Property name="Owner" value="Runtime" />
          </Properties>
        </Output>
      </UnitTestResult>
    </Results>
  </TestRun>`;

  const host = createHtmlDomNode("div");
  let highlightCalls = 0;
  TrxPreview.render(trxXml, host, {
    highlightXml(src) {
      highlightCalls += 1;
      return `<span class="hl">${src.length}</span>`;
    },
  });

  // Summarized Completed run with failures -> Failed, 1h 15m duration, failed-first ordering, and 24,000-char truncation note
  assert.match(host.innerHTML, /1h 15m/);
  assert.match(host.innerHTML, /Output truncated after 24,000 characters/);
  assert.match(host.innerHTML, /Data row 3/);
  assert.match(host.innerHTML, /Integration/);
  assert.match(host.innerHTML, /Runtime/);

  const trxRoot = host.querySelector(".trx-preview");
  assert.ok(trxRoot);
  const resultNodes = trxRoot.querySelectorAll("[data-trx-result]");
  assert.deepEqual(
    resultNodes.map((n) => n.dataset.trxCategory),
    ["failed", "other", "skipped", "passed"],
  );
  assert.equal(resultNodes[0].getAttribute("open"), ""); // first failed result auto-expanded

  // Search + outcome filter interaction
  const searchInput = trxRoot.querySelector("[data-trx-search-input]");
  searchInput.value = "delta worker";
  TrxPreview.applyFilters(trxRoot);
  assert.equal(resultNodes.filter((n) => !n.hidden).length, 1);
  assert.equal(trxRoot.querySelector("[data-trx-result-count]").textContent, "1 of 4 results");
  assert.equal(trxRoot.querySelector("[data-trx-no-results]").hidden, true);

  searchInput.value = "nonexistent-test-xyz";
  TrxPreview.applyFilters(trxRoot);
  assert.equal(trxRoot.querySelector("[data-trx-no-results]").hidden, false);

  // Category filter button (aria-pressed="true" on skipped) filters independently of search query
  searchInput.value = "";
  for (const btn of trxRoot.querySelectorAll("[data-trx-filter]")) {
    btn.setAttribute("aria-pressed", btn.dataset.trxFilter === "skipped" ? "true" : "false");
  }
  TrxPreview.applyFilters(trxRoot);
  assert.deepEqual(
    resultNodes.filter((n) => !n.hidden).map((n) => n.dataset.trxCategory),
    ["skipped"],
  );

  // Lazy raw XML syntax highlighting runs once and toggles back to structured view
  assert.equal(highlightCalls, 0);
  TrxPreview.showView(trxRoot, "raw");
  assert.equal(highlightCalls, 1);
  const panels = trxRoot.querySelectorAll("[data-trx-panel]");
  assert.equal(panels.find((p) => p.dataset.trxPanel === "raw").hidden, false);
  assert.equal(panels.find((p) => p.dataset.trxPanel === "structured").hidden, true);

  TrxPreview.showView(trxRoot, "structured");
  TrxPreview.showView(trxRoot, "raw");
  assert.equal(highlightCalls, 1); // cached via data-trx-loaded="true"

  // Large (>4 MiB) raw XML skips syntax highlighter and unhides raw-note banner
  const hugePadding = "x".repeat(4 * 1024 * 1024 + 64);
  const hugeXml = `<TestRun name="Huge"><ResultSummary outcome="Completed"><Counters total="1" passed="1" /></ResultSummary><Results><UnitTestResult testName="Big" outcome="Passed"><Output><StdOut>${hugePadding}</StdOut></Output></UnitTestResult></Results></TestRun>`;
  const hugeHost = createHtmlDomNode("div");
  let hugeHighlighted = false;
  TrxPreview.render(hugeXml, hugeHost, {
    highlightXml() {
      hugeHighlighted = true;
      return "";
    },
  });
  const hugeRoot = hugeHost.querySelector(".trx-preview");
  TrxPreview.showView(hugeRoot, "raw");
  assert.equal(hugeHighlighted, false);
  assert.equal(hugeRoot.querySelector("[data-trx-raw-note]").hidden, false);

  // Malformed XML renders alert fallback with highlighted raw source
  const errHost = createHtmlDomNode("div");
  TrxPreview.render("<TestRun><unclosed>", errHost, {
    highlightXml: (s) => `HIGHLIGHTED:${s.length}`,
  });
  assert.match(errHost.innerHTML, /Unable to parse test results/);
  assert.match(errHost.innerHTML, /HIGHLIGHTED:19/);
});

test("pr-artifact-explorer preview.mjs validates preview inputs, injects theme bridges, and enforces host/path/encoding guards offline", async (t) => {
  const hook = installInMemoryServerHook(t, 49200);
  const origFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = origFetch;
    await stopAllStaticPreviews();
  });

  const noTag65k = `<!-- ${"p".repeat(66_000)} --><div>Streamed</div>`;
  const zipBuffer = buildZipBuffer([
    { name: "index.html", data: "<!doctype html><html lang=\"en\"><body>Hello</body></html>" },
    { name: "sub/index.html", data: "<!doctype html><p>Subdir</p>" },
    { name: "notags.html", data: noTag65k },
    { name: "empty.html", data: "" },
    { name: "assets/app.js", data: "console.log('ready');" },
    { name: "unsupported.html", data: "<html/>", method: 99 },
  ]);

  globalThis.fetch = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/actions/artifacts/701")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () =>
          JSON.stringify({
            id: 701,
            name: "site-preview",
            size_in_bytes: zipBuffer.length,
            expired: false,
          }),
      };
    }
    if (pathname.endsWith("/actions/artifacts/701/zip")) {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (h) => (h.toLowerCase() === "content-length" ? String(zipBuffer.length) : "application/zip"),
        },
        body: Readable.toWeb(Readable.from([zipBuffer])),
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  await inspectArtifact("test-token", "octo/demo", 701);

  // Input validation guards before server creation
  await assert.rejects(
    () =>
      startStaticPreview(701, "unsupported.html", {
        theme: "dark",
        parentOrigin: "http://127.0.0.1:4100",
      }),
    /unsupported ZIP encoding/,
  );
  await assert.rejects(
    () =>
      startStaticPreview(701, "assets/app.js", {
        theme: "dark",
        parentOrigin: "http://127.0.0.1:4100",
      }),
    /Only HTML files/,
  );
  await assert.rejects(
    () =>
      startStaticPreview(701, "sub/index.html", {
        theme: "dark",
        parentOrigin: "http://127.0.0.1:4100",
      }),
    /root index\.html/,
  );
  await assert.rejects(
    () =>
      startStaticPreview(701, "index.html", {
        theme: "sepia",
        parentOrigin: "http://127.0.0.1:4100",
      }),
    /light or dark/,
  );
  await assert.rejects(
    () =>
      startStaticPreview(701, "index.html", {
        theme: "dark",
        parentOrigin: "https://127.0.0.1:4100",
      }),
    /loopback origin/,
  );
  await assert.rejects(
    () =>
      startStaticPreview(701, "index.html", {
        theme: "dark",
        parentOrigin: "http://localhost:4100",
      }),
    /loopback origin/,
  );

  const previewUrl = await startStaticPreview(701, "index.html", {
    theme: "dark",
    parentOrigin: "http://127.0.0.1:4100",
  });
  const dupUrl = await startStaticPreview(701, "index.html", {
    theme: "dark",
    parentOrigin: "http://127.0.0.1:4100",
  });
  assert.equal(dupUrl, previewUrl); // deduplicates existing server entry

  const parsedPreview = new URL(previewUrl);
  const server = hook.getServer(previewUrl);
  assert.ok(server);
  const hostHeader = { host: parsedPreview.host };

  // Spoofed Host -> 403; POST -> 405
  assert.equal(
    (await dispatchToServer(server, "GET", "/", { headers: { host: "evil.example" } })).status,
    403,
  );
  const postRes = await dispatchToServer(server, "POST", "/", { headers: hostHeader });
  assert.equal(postRes.status, 405);
  assert.equal(postRes.headers.allow, "GET, HEAD");

  // Invalid URL encoding -> 400; path traversal -> 400; unsupported entry -> 415; missing -> 404
  assert.equal(
    (await dispatchToServer(server, "GET", "/%E0%A4%A", { headers: hostHeader })).status,
    400,
  );
  assert.equal(
    (await dispatchToServer(server, "GET", "/C:/windows/win.ini", { headers: hostHeader })).status,
    400,
  );
  assert.equal(
    (await dispatchToServer(server, "GET", "/unsupported.html", { headers: hostHeader })).status,
    415,
  );
  assert.equal(
    (await dispatchToServer(server, "GET", "/missing.html", { headers: hostHeader })).status,
    404,
  );

  // Root HTML injects theme bridge right after <html lang="en">, HEAD omits body, empty HTML returns bridge, and JS streams uninjected
  const rootHtml = await dispatchToServer(server, "GET", "/", { headers: hostHeader });
  assert.equal(rootHtml.status, 200);
  assert.match(
    rootHtml.text,
    /^<!doctype html><html lang="en"><script data-copilot-preview-theme>[\s\S]+<\/script><body>Hello<\/body><\/html>$/,
  );
  assert.equal(Number(rootHtml.headers["content-length"]), rootHtml.buffer.length);

  const headRes = await dispatchToServer(server, "HEAD", "/", { headers: hostHeader });
  assert.equal(headRes.status, 200);
  assert.equal(headRes.buffer.length, 0);

  const doctypeHtml = await dispatchToServer(server, "GET", "/sub/", { headers: hostHeader });
  assert.equal(doctypeHtml.status, 200);
  assert.match(doctypeHtml.text, /^<!doctype html><script data-copilot-preview-theme>/);

  const emptyHtml = await dispatchToServer(server, "GET", "/empty.html", { headers: hostHeader });
  assert.equal(emptyHtml.status, 200);
  assert.match(emptyHtml.text, /^<script data-copilot-preview-theme>/);

  // >64 KiB HTML without <html>/<head>/<!doctype> flushes at HTML_INJECTION_SEARCH_BYTES and prepends bridge at offset 0
  const largeNoTagHtml = await dispatchToServer(server, "GET", "/notags.html", { headers: hostHeader });
  assert.equal(largeNoTagHtml.status, 200);
  assert.match(largeNoTagHtml.text, /^<script data-copilot-preview-theme>[\s\S]+<\/script><!-- p{100}/);
  assert.equal(Number(largeNoTagHtml.headers["content-length"]), largeNoTagHtml.buffer.length);

  const jsAsset = await dispatchToServer(server, "GET", "/assets/app.js", { headers: hostHeader });
  assert.equal(jsAsset.status, 200);
  assert.equal(jsAsset.text, "console.log('ready');");

  // Stop helpers clean up matching preview servers
  await stopStaticPreviewsForOrigin("http://127.0.0.1:9999");
  assert.equal(hook.activeCount, 1);
  await stopStaticPreviewsForOrigin("http://127.0.0.1:4100");
  assert.equal(hook.activeCount, 0);

  await startStaticPreview(701, "index.html", {
    theme: "light",
    parentOrigin: "http://127.0.0.1:4100",
  });
  assert.equal(hook.activeCount, 1);
  await stopStaticPreviewsForArtifact(701);
  assert.equal(hook.activeCount, 0);
});

test("pr-artifact-explorer server.mjs enforces capability tokens, progressive PR pagination, and archive fallback delivery offline", async (t) => {
  assert.equal(contentDeliveryMode({ supported: true }, false), "entry");
  assert.equal(contentDeliveryMode({ supported: false }, false), "unsupported");
  assert.equal(contentDeliveryMode({ supported: false }, true), "archive");

  const hook = installInMemoryServerHook(t, 49300);
  const savedEnv = { ...process.env };
  const origFetch = globalThis.fetch;
  invalidateAccounts();

  t.after(async () => {
    await stopInstance("inst-p9").catch(() => {});
    invalidateAccounts();
    globalThis.fetch = origFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "awesome-copilot-prae-nobin-"));
  t.after(() => fs.rmSync(emptyBin, { recursive: true, force: true }));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("COPILOT_GH_ACCOUNT_")) delete process.env[key];
  }
  delete process.env.GITHUB_TOKEN;
  process.env.PATH = emptyBin;
  process.env.GH_TOKEN = "dummy-server-token";

  const zipBuffer = buildZipBuffer([
    { name: "notes.txt", data: "Build succeeded" },
    { name: "logo.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    { name: "odd.bin", data: "raw", method: 99 },
  ]);

  const jsonReply = (payload, extraHeaders = {}) => {
    const raw = JSON.stringify(payload);
    const hdrs = new Map(
      Object.entries({ "content-type": "application/json", ...extraHeaders }).map(([k, v]) => [
        k.toLowerCase(),
        String(v),
      ]),
    );
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => hdrs.get(String(h).toLowerCase()) ?? null },
      text: async () => raw,
      json: async () => JSON.parse(raw),
    };
  };

  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/user") {
      return jsonReply({ login: "octocat", id: 1 }, { "x-oauth-scopes": "repo" });
    }
    if (parsed.pathname === "/repos/octo/demo") {
      return jsonReply({ id: 10, full_name: "octo/demo" });
    }
    if (parsed.pathname.endsWith("/actions/artifacts/702")) {
      return jsonReply({
        id: 702,
        name: "build\\bundle",
        size_in_bytes: zipBuffer.length,
        expired: false,
      });
    }
    if (parsed.pathname.endsWith("/actions/artifacts/702/zip")) {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (h) => (h.toLowerCase() === "content-length" ? String(zipBuffer.length) : "application/zip"),
        },
        body: Readable.toWeb(Readable.from([zipBuffer])),
      };
    }
    if (parsed.pathname === "/search/issues") {
      const items = Array.from({ length: 30 }, (_, idx) => ({
        number: idx + 1,
        title: `PR ${idx + 1}`,
        state: "open",
        user: { login: "octocat" },
        html_url: `https://github.com/octo/demo/pull/${idx + 1}`,
      }));
      return jsonReply({ total_count: 30, incomplete_results: false, items });
    }
    if (parsed.pathname === "/graphql") {
      const vars = JSON.parse(init.body).variables;
      const repoNodes = {};
      for (let idx = 0; idx < 25; idx++) {
        repoNodes[`pull${idx}`] = {
          headRefOid: `sha-${idx}`,
          isDraft: false,
          reviewDecision: "APPROVED",
          totalCommentsCount: 0,
          commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
        };
      }
      assert.equal(vars.owner, "octo");
      return jsonReply({ data: { repository: repoNodes } });
    }
    throw new Error(`Unhandled URL: ${url}`);
  };

  await inspectArtifact("dummy-server-token", "octo/demo", 702);

  const entry = await startInstance("inst-p9", { repository: "octo/demo" });
  const server = hook.getServer(entry.url);
  const authHeaders = {
    host: entry.host,
    [CAPABILITY_TOKEN_HEADER]: entry.token,
  };

  // Document & security guards
  assert.equal((await dispatchToServer(server, "GET", "/", { headers: { host: entry.host } })).status, 403);
  const docOk = await dispatchToServer(server, "GET", `/?token=${encodeURIComponent(entry.token)}`, {
    headers: { host: entry.host },
  });
  assert.equal(docOk.status, 200);
  assert.match(docOk.headers["content-security-policy"], /default-src 'self'/);

  assert.equal(
    (
      await dispatchToServer(server, "GET", "/api/cache", {
        headers: { ...authHeaders, "sec-fetch-site": "cross-site" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await dispatchToServer(server, "GET", "/api/cache", { headers: { host: entry.host } })).status,
    403,
  );

  // Progressive pull-request phases: initial -> batch -> details + validation guards
  assert.equal(
    (await dispatchToServer(server, "GET", "/api/pulls?repo=octo/demo&phase=bogus", { headers: authHeaders })).status,
    400,
  );
  const initialRes = await dispatchToServer(
    server,
    "GET",
    "/api/pulls?repo=octo/demo&phase=initial",
    { headers: authHeaders },
  );
  assert.equal(initialRes.status, 200);
  const initialJson = JSON.parse(initialRes.text);
  assert.equal(initialJson.pulls.length, 25);
  assert.equal(initialJson.progressive.complete, false);
  const sessionId = initialJson.progressive.sessionId;

  assert.equal(
    (
      await dispatchToServer(server, "GET", "/api/pulls?repo=octo/demo&phase=batch&session=wrong&offset=25", {
        headers: authHeaders,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await dispatchToServer(
        server,
        "GET",
        `/api/pulls?repo=octo/demo&phase=batch&session=${sessionId}&offset=10`,
        { headers: authHeaders },
      )
    ).status,
    400,
  );

  const batchRes = await dispatchToServer(
    server,
    "GET",
    `/api/pulls?repo=octo/demo&phase=batch&session=${sessionId}&offset=25`,
    { headers: authHeaders },
  );
  assert.equal(batchRes.status, 200);
  assert.equal(JSON.parse(batchRes.text).pulls.length, 5);

  const detail0 = await dispatchToServer(
    server,
    "GET",
    `/api/pulls?repo=octo/demo&phase=details&session=${sessionId}&offset=0`,
    { headers: authHeaders },
  );
  assert.equal(detail0.status, 200);
  assert.equal(JSON.parse(detail0.text).complete, false);

  const detail25 = await dispatchToServer(
    server,
    "GET",
    `/api/pulls?repo=octo/demo&phase=details&session=${sessionId}&offset=25`,
    { headers: authHeaders },
  );
  assert.equal(detail25.status, 200);
  assert.equal(JSON.parse(detail25.text).complete, true);

  // Content delivery & inline text endpoints
  const txtPreview = await dispatchToServer(
    server,
    "GET",
    "/api/artifacts/702/text?path=notes.txt",
    { headers: authHeaders },
  );
  assert.equal(txtPreview.status, 200);
  assert.equal(JSON.parse(txtPreview.text).content, "Build succeeded");

  assert.equal(
    (
      await dispatchToServer(server, "GET", "/api/artifacts/702/text?path=logo.png", {
        headers: authHeaders,
      })
    ).status,
    415,
  );

  assert.equal(
    (await dispatchToServer(server, "GET", "/content/702/odd.bin", { headers: authHeaders })).status,
    415,
  );
  const fallbackZip = await dispatchToServer(
    server,
    "GET",
    "/content/702/odd.bin?download=1",
    { headers: authHeaders },
  );
  assert.equal(fallbackZip.status, 200);
  assert.equal(fallbackZip.headers["content-type"], "application/zip");
  assert.match(fallbackZip.headers["content-disposition"], /bundle\.zip/);

  // SSE navigation and broadcast helpers
  const sseMessages = [];
  entry.sseClients.add({ write: (msg) => sseMessages.push(msg), end() {} });
  assert.equal(navigateInstance("unknown-instance", "/pulls"), false);
  assert.equal(navigateInstance("inst-p9", "/artifacts/702"), true);
  await broadcastCache({ refresh: true });
  assert.equal(sseMessages.some((m) => m.includes("event: navigate")), true);
  assert.equal(sseMessages.some((m) => m.includes("event: cache")), true);
  assert.equal(sseMessages.some((m) => m.includes("event: refresh")), true);

  await stopInstance("inst-p9");
  assert.equal(hook.activeCount, 0);
});
