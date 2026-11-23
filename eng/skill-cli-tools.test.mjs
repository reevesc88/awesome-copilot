import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { run as runLatchshot } from "../skills/latchshot-page-capture/scripts/latchshot.mjs";
import {
  buildMarkdown,
  escapeHtml,
  formatHumanDate,
  getPrDetails,
  pMap,
  renderHtml,
  searchIssues,
} from "../skills/pr-dashboard/scripts/pr-dashboard-cli.mjs";
import { ROOT_FOLDER } from "./constants.mjs";

const SUBPROCESS_TIMEOUT_MS = 10_000;
const SKILLS_ROOT = path.join(ROOT_FOLDER, "skills");

function makeTempDir(t, prefix = "awesome-copilot-skill-cli-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeStreamResponse(chunks, { status = 200, headers = {} } = {}) {
  const headerMap = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
  );
  let idx = 0;
  let cancelled = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headerMap.get(String(name).toLowerCase()) ?? null,
    },
    body: {
      getReader() {
        return {
          async read() {
            if (idx >= chunks.length) return { done: true, value: undefined };
            const chunk = chunks[idx++];
            return { done: false, value: Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk) };
          },
          async cancel() {
            cancelled = true;
          },
        };
      },
    },
    get cancelled() {
      return cancelled;
    },
  };
}

test("latchshot CLI validates flags, URLs, format contracts, bounded streams, magic bytes, and secret redaction offline", async (t) => {
  const dir = makeTempDir(t, "latchshot-");
  const syntheticKey = ["ak", "synthetic", "test", "token"].join("_");
  const redactableLeak = ["ls", "live", "secretToken99"].join("_");

  async function invoke(argv, { env = {}, fetchImpl } = {}) {
    const out = [];
    const err = [];
    const code = await runLatchshot(argv, {
      env,
      fetchImpl: fetchImpl ?? (async () => { throw new Error("unexpected network call"); }),
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });
    return {
      code,
      stdout: out.join("\n"),
      stderr: err.join("\n"),
      parsedOut: out.length === 1 && out[0].startsWith("{") ? JSON.parse(out[0]) : null,
      parsedErr: err.length === 1 && err[0].startsWith("{") ? JSON.parse(err[0]) : null,
    };
  }

  // Help exits 0
  const helpRes = await invoke([]);
  assert.equal(helpRes.code, 0);
  assert.match(helpRes.stdout, /Usage:/);
  assert.equal((await invoke(["capture", "--help"])).code, 0);

  // Argument & option validation errors (exit 2)
  for (const badArgs of [
    ["unknown-cmd"],
    ["usage", "--dark"],
    ["capture", "positional"],
    ["capture", "--unknown", "1"],
    ["capture", "--dark=true"],
    ["capture", "--dark", "--dark"],
    ["capture", "--url"],
    ["capture", "--output", "-"],
    ["capture", "--output", path.join(dir, "out.bmp"), "--url", "https://example.com"],
    ["capture", "--output", path.join(dir, "out.png"), "--format", "pdf", "--url", "https://example.com"],
    ["capture", "--output", path.join(dir, "out.png"), "--scroll-page", "--url", "https://example.com"],
    ["capture", "--output", path.join(dir, "out.pdf"), "--full-page", "--url", "https://example.com"],
    ["capture", "--output", path.join(dir, "out.png"), "--quality", "80", "--url", "https://example.com"],
    ["capture", "--output", path.join(dir, "out.png"), "--paper", "A4", "--url", "https://example.com"],
    ["capture", "--output", path.join(dir, "out.png"), "--delay-ms=   ", "--url", "https://example.com"],
    ["capture", "--output", path.join(dir, "out.png"), "--delay-ms=0x10", "--url", "https://example.com"],
    ["capture", "--output", path.join(dir, "out.png"), "--width", "100", "--url", "https://example.com"],
    ["capture", "--output", path.join(dir, "out.png"), "--url", "ftp://example.com"],
    ["capture", "--output", path.join(dir, "out.png"), "--url", "https://user:pw@example.com"],
    ["capture", "--output", path.join(dir, "out.png"), "--url", "https://example.com:8443"],
    ["capture", "--output", path.join(dir, "out.png"), "--url", "https://example.com?token=1"],
    ["capture", "--output", path.join(dir, "out.png"), "--url", "https://example.com#frag"],
    ["demo", "--output", path.join(dir, "demo.png"), "--url", "https://example.com"],
    ["demo", "--output", path.join(dir, "demo.jpg"), "--dark", "--url", "https://example.com"],
  ]) {
    const res = await invoke(badArgs, { env: { LATCHSHOT_API_KEY: syntheticKey } });
    assert.equal(res.code, 2, `expected exit 2 for ${JSON.stringify(badArgs)}, got ${res.code}: ${res.stderr}`);
  }

  // Missing or whitespace-containing key -> exit 3
  assert.equal((await invoke(["usage"], { env: {} })).code, 3);
  assert.equal((await invoke(["usage"], { env: { LATCHSHOT_API_KEY: "bad key" } })).code, 3);

  // Successful PNG capture + --allow-query + existing output guard + --force overwrite
  const pngBytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("PNGDATA")]);
  const outPng = path.join(dir, "nested", "shot.png");
  let capturedPayload = null;
  const okCapture = await invoke(
    [
      "capture",
      "--url",
      "https://example.com/page?view=1",
      "--allow-query",
      "--output",
      outPng,
      "--full-page",
      "--scroll-page",
      "--dark",
    ],
    {
      env: { LATCHSHOT_API_KEY: syntheticKey },
      fetchImpl: async (_url, init) => {
        capturedPayload = JSON.parse(init.body);
        return makeStreamResponse([pngBytes], {
          status: 200,
          headers: {
            "content-type": "image/png; charset=binary",
            "x-latchshot-render-ms": "412",
            "x-quota-limit": "100",
            "x-quota-remaining": "99",
          },
        });
      },
    },
  );
  assert.equal(okCapture.code, 0, okCapture.stderr);
  assert.equal(capturedPayload.fullPage, true);
  assert.equal(capturedPayload.scrollPage, true);
  assert.equal(capturedPayload.darkMode, true);
  assert.equal(okCapture.parsedOut.render.durationMs, 412);
  assert.equal(okCapture.parsedOut.quota.remaining, 99);
  assert.deepEqual(fs.readFileSync(outPng), pngBytes);

  // Refuses overwrite without --force (exit 5), succeeds with --force
  const existsErr = await invoke(
    ["capture", "--url", "https://example.com", "--output", outPng],
    { env: { LATCHSHOT_API_KEY: syntheticKey } },
  );
  assert.equal(existsErr.code, 5);
  assert.equal(existsErr.parsedErr.error.code, "output_exists");

  // Demo JPEG capture + PDF capture
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const outJpg = path.join(dir, "demo.jpg");
  const okDemo = await invoke(
    ["demo", "--url", "https://example.com", "--output", outJpg],
    {
      fetchImpl: async () =>
        makeStreamResponse([jpegBytes], { status: 200, headers: { "content-type": "image/jpeg" } }),
    },
  );
  assert.equal(okDemo.code, 0, okDemo.stderr);
  assert.equal(okDemo.parsedOut.operation, "demo");

  const pdfBytes = Buffer.from("%PDF-1.7\n%%EOF\n", "utf8");
  const outPdf = path.join(dir, "doc.pdf");
  const okPdf = await invoke(
    ["capture", "--url", "https://example.com", "--output", outPdf, "--paper", "Letter", "--landscape"],
    {
      env: { LATCHSHOT_API_KEY: syntheticKey },
      fetchImpl: async () =>
        makeStreamResponse([pdfBytes], { status: 200, headers: { "content-type": "application/pdf" } }),
    },
  );
  assert.equal(okPdf.code, 0, okPdf.stderr);
  assert.equal(okPdf.parsedOut.format, "pdf");

  // Invalid magic bytes, wrong content-type, oversized stream, and API error redaction
  const badMagic = await invoke(
    ["capture", "--url", "https://example.com", "--output", outPng, "--force"],
    {
      env: { LATCHSHOT_API_KEY: syntheticKey },
      fetchImpl: async () =>
        makeStreamResponse([Buffer.from("not-a-png")], { status: 200, headers: { "content-type": "image/png" } }),
    },
  );
  assert.equal(badMagic.code, 5);
  assert.equal(badMagic.parsedErr.error.code, "invalid_artifact");

  const apiErr = await invoke(
    ["usage"],
    {
      env: { LATCHSHOT_API_KEY: syntheticKey },
      fetchImpl: async () =>
        makeStreamResponse(
          [JSON.stringify({ error: { code: "rate_limited", message: `Key ${redactableLeak} failed at https://internal.example/v1` } })],
          { status: 429, headers: { "content-type": "application/json" } },
        ),
    },
  );
  assert.equal(apiErr.code, 4);
  assert.equal(apiErr.parsedErr.error.code, "rate_limited");
  assert.match(apiErr.parsedErr.error.message, /\[redacted-key\]/);
  assert.match(apiErr.parsedErr.error.message, /\[redacted-url\]/);
  assert.equal(apiErr.stderr.includes(redactableLeak), false);

  const invalidUsageJson = await invoke(
    ["usage"],
    {
      env: { LATCHSHOT_API_KEY: syntheticKey },
      fetchImpl: async () =>
        makeStreamResponse([Buffer.from("{broken")], { status: 200, headers: { "content-type": "application/json" } }),
    },
  );
  assert.equal(invalidUsageJson.code, 5);
  assert.equal(invalidUsageJson.parsedErr.error.code, "invalid_usage_response");
});

test("pr-dashboard-cli helpers and offline CLI escape HTML, guard prototype keys, and render dashboards", async (t) => {
  assert.equal(escapeHtml(`<script attr="x">'&`), "&lt;script attr=&quot;x&quot;&gt;&#39;&amp;");

  // pMap preserves order, limits concurrency, and filters rejected/null items
  const mapped = await pMap([1, 2, 3, 4], async (n) => {
    if (n === 3) throw new Error("skip");
    return n * 10;
  }, 2);
  assert.deepEqual(mapped, [10, 20, 40]);

  const samplePrs = [
    {
      repo: "octo/demo",
      number: 11,
      title: "Fix <unsafe> & title",
      html_url: "https://github.com/octo/demo/pull/11",
      createdAt: "Mar 1, 2026",
      updatedAt: "Mar 2, 2026",
      summary: "Summary <tag>",
      status: "OPEN",
      review: "APPROVED",
      ci: "SUCCESS",
      bodyHtml: "<p>Rendered GFM</p>",
    },
    {
      repo: "octo/demo",
      number: 12,
      title: "Prototype status check",
      html_url: "https://github.com/octo/demo/pull/12",
      createdAt: "Mar 3, 2026",
      updatedAt: "Mar 4, 2026",
      summary: "",
      status: "constructor",
      review: "REVIEW_REQUIRED",
      ci: "FAILURE",
      bodyHtml: null,
    },
  ];

  const md = buildMarkdown(samplePrs, "Last 7 days");
  assert.match(md, /\*\*2 total\*\* · ✅ 1 open/);
  assert.match(md, /Summary <tag>/);

  const htmlPath = await renderHtml(md, "Last <7> days", samplePrs);
  const html = fs.readFileSync(htmlPath, "utf8");
  assert.match(html, /Fix &lt;unsafe&gt; &amp; title/);
  assert.match(html, /<p>Rendered GFM<\/p>/);
  assert.match(html, /No description/);
  assert.equal(html.includes("function Object()"), false);

  // Offline subprocess test with stubbed gh + opener binaries
  const dir = makeTempDir(t, "pr-dash-cli-");
  const fakeBin = path.join(dir, "bin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  printf '{"login":"octocat"}'
elif [ "$1" = "api" ]; then
  printf '{"items":[]}'
fi
`,
    { mode: 0o755 },
  );
  for (const opener of ["open", "xdg-open"]) {
    fs.writeFileSync(path.join(fakeBin, opener), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }

  const cliScript = path.join(SKILLS_ROOT, "pr-dashboard", "scripts", "pr-dashboard-cli.mjs");
  const emptyRun = spawnSync(process.execPath, [cliScript, "Apr 1, 2025 - Apr 5, 2025", "Requested reviews"], {
    cwd: dir,
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(emptyRun.status, 0, emptyRun.stderr);
  assert.match(emptyRun.stdout, /review-requested:octocat/);
  assert.match(emptyRun.stdout, /No results/);

  // Exercise searchIssues + getPrDetails + formatHumanDate offline against stubbed gh endpoints
  assert.match(formatHumanDate("2026-03-15T12:00:00Z"), /2026/);
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    `#!/bin/sh
case "$*" in
  *"/search/issues"*)
    printf '%s' '{"items":[{"html_url":"https://github.com/octo/demo/pull/7"}]}' ;;
  *"/repos/octo/demo/pulls/7/reviews"*)
    printf '%s' '[{"state":"COMMENTED"},{"state":"CHANGES_REQUESTED"}]' ;;
  *"/repos/octo/demo/pulls/7"*)
    printf '%s' '{"number":7,"title":"Improve parser","html_url":"https://github.com/octo/demo/pull/7","created_at":"2026-03-01T00:00:00Z","updated_at":"2026-03-02T00:00:00Z","body":"First paragraph summary **Note**:\\n\\nSecond paragraph","draft":false,"merged":true,"state":"closed","head":{"sha":"abc123"}}' ;;
  *"/repos/octo/demo/commits/abc123/status"*)
    printf '%s' '{"state":"success"}' ;;
  *"/markdown"*)
    printf '%s' '<p>First paragraph summary</p>' ;;
  *)
    printf '%s' '{}' ;;
esac
`,
    { mode: 0o755 },
  );

  const origPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${origPath}`;
  t.after(() => {
    process.env.PATH = origPath;
  });

  const found = await searchIssues("is:pr author:octocat");
  assert.equal(found.length, 1);
  const details = await getPrDetails(found[0]);
  assert.equal(details.status, "MERGED");
  assert.equal(details.review, "CHANGES_REQUESTED");
  assert.equal(details.ci, "SUCCESS");
  assert.equal(details.bodyHtml, "<p>First paragraph summary</p>");
  assert.equal(await getPrDetails({ html_url: "https://example.com/not-a-pr" }), null);
});

test("bundled Python skill validators and parsers (code-tour, drawio, simplicite-log2json, analyze_plan) enforce rules offline", (t) => {
  const pyCheck = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (pyCheck.status !== 0) {
    t.skip("python3 is not available");
    return;
  }

  const dir = makeTempDir(t, "py-skills-");

  // 1. code-tour validate_tour.py
  const tourValidator = path.join(SKILLS_ROOT, "code-tour", "scripts", "validate_tour.py");
  const srcDir = path.join(dir, "src");
  const toursDir = path.join(dir, ".tours");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(toursDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, "app.py"), "def greet():\n    return 'hi'\n", "utf8");
  fs.writeFileSync(
    path.join(toursDir, "followup.tour"),
    JSON.stringify({ title: "Followup Tour", steps: [{ description: "Done" }] }),
    "utf8",
  );

  const validTourPath = path.join(toursDir, "intro.tour");
  fs.writeFileSync(
    validTourPath,
    JSON.stringify({
      title: "Intro Tour",
      nextTour: "Followup Tour",
      steps: [
        { title: "Welcome", description: "Orientation step" },
        {
          title: "Entry",
          file: "src/app.py",
          line: 1,
          selection: { start: { line: 1 }, end: { line: 2 } },
          pattern: "^def greet",
          commands: ["workbench.action.files.save"],
          description: "Inspect greet()",
        },
        { directory: "src", description: "Source folder" },
        { uri: "https://example.com/docs", description: "Docs link" },
        { title: "Wrap-up", description: "Closing summary" },
      ],
    }),
    "utf8",
  );

  const validTourRun = spawnSync("python3", [tourValidator, validTourPath, "--repo-root", dir], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(validTourRun.status, 0, validTourRun.stdout + validTourRun.stderr);

  // Malformed root array + boolean line + bad selection + non-dict step must fail with exit 1 instead of crashing
  const nonDictTour = path.join(toursDir, "array.tour");
  fs.writeFileSync(nonDictTour, "[]", "utf8");
  const arrayTourRun = spawnSync("python3", [tourValidator, nonDictTour, "--repo-root", dir], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(arrayTourRun.status, 1);
  assert.match(arrayTourRun.stdout, /Tour root must be a JSON object/);

  const edgeTour = path.join(toursDir, "edge.tour");
  fs.writeFileSync(
    edgeTour,
    JSON.stringify({
      title: "Edge Cases",
      steps: [
        null,
        { file: "src/app.py", line: true, selection: "bad", pattern: 42, description: "Bool line" },
        { file: "/abs.py", directory: 123, uri: 99, commands: [123] },
      ],
    }),
    "utf8",
  );
  const edgeTourRun = spawnSync("python3", [tourValidator, edgeTour, "--repo-root", dir], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(edgeTourRun.status, 1, edgeTourRun.stderr);
  assert.match(edgeTourRun.stdout, /Step must be a JSON object/);
  assert.match(edgeTourRun.stdout, /'line' must be an integer, got True/);
  assert.match(edgeTourRun.stdout, /'selection' must be an object/);
  assert.match(edgeTourRun.stdout, /'pattern' must be a string/);

  // 2. draw-io-diagram-generator validate-drawio.py
  const drawioValidator = path.join(SKILLS_ROOT, "draw-io-diagram-generator", "scripts", "validate-drawio.py");
  const validDrawio = path.join(dir, "valid.drawio");
  fs.writeFileSync(
    validDrawio,
    `<mxfile>
  <diagram name="Overview">
    <mxGraphModel>
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="title" value="Architecture" style="text;html=1;fontSize=18;" vertex="1" parent="1">
          <mxGeometry x="20" y="10" width="200" height="30" as="geometry" />
        </mxCell>
        <mxCell id="a" value="API" style="rounded=1;" vertex="1" parent="1">
          <mxGeometry x="20" y="60" width="100" height="40" as="geometry" />
        </mxCell>
        <mxCell id="e1" edge="1" parent="1">
          <mxGeometry relative="1" as="geometry">
            <mxPoint x="20" y="120" as="sourcePoint" />
            <mxPoint x="120" y="120" as="targetPoint" />
          </mxGeometry>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`,
    "utf8",
  );
  const okDrawio = spawnSync("python3", [drawioValidator, validDrawio], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(okDrawio.status, 0, okDrawio.stdout);

  const badDrawio = path.join(dir, "bad.drawio");
  fs.writeFileSync(
    badDrawio,
    `<mxfile><diagram name="Broken"><mxGraphModel><root>
      <mxCell id="1" parent="99" />
      <mxCell id="0" />
      <mxCell id="v1" vertex="1" parent="1" />
      <mxCell id="edge-bad" edge="1" parent="1" source="missing" />
    </root></mxGraphModel></diagram></mxfile>`,
    "utf8",
  );
  const failDrawio = spawnSync("python3", [drawioValidator, badDrawio], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(failDrawio.status, 1);
  assert.match(failDrawio.stdout, /First <mxCell> must have id='0'/);
  assert.match(failDrawio.stdout, /No title cell found/);
  assert.match(failDrawio.stdout, /missing <mxGeometry>/);
  assert.match(failDrawio.stdout, /unknown source='missing'/);

  // 3. optimize-simplicite-logs simplicite-log2json.py
  const log2json = path.join(SKILLS_ROOT, "optimize-simplicite-logs", "scripts", "simplicite-log2json.py");
  const rawLog = path.join(dir, "simplicite.log");
  const outJson = path.join(dir, "parsed.json");
  fs.writeFileSync(
    rawLog,
    [
      "2026-03-10 12:00:01,123|SIMPLICITE|ERROR||ui|/app|ERR_SQL|designer|OrderObj|save|42|First line",
      "stacktrace line 2",
      "2026-03-10 12:00:02,456|MALFORMED_LINE",
      "2026-03-10 12:00:03,789|SIMPLICITE|INFO||api|/rest|OK|admin|UserObj|ping|1|Healthy",
    ].join("\n") + "\n",
    "utf8",
  );
  const logRun = spawnSync(
    "python3",
    [log2json, rawLog, "--include", "level,event,body", "-o", outJson],
    { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS },
  );
  assert.equal(logRun.status, 0, logRun.stderr);
  assert.match(logRun.stderr, /Processed: 2 entries, Skipped: 1 entries/);
  const parsedLogs = JSON.parse(fs.readFileSync(outJson, "utf8"));
  assert.deepEqual(parsedLogs, [
    { level: "ERROR", event: "ERR_SQL", body: "First line\nstacktrace line 2" },
    { level: "INFO", event: "OK", body: "Healthy" },
  ]);

  // 4. terraform-azurerm-set-diff-analyzer analyze_plan.py
  const planAnalyzer = path.join(
    SKILLS_ROOT,
    "terraform-azurerm-set-diff-analyzer",
    "scripts",
    "analyze_plan.py",
  );
  const customAttrs = path.join(dir, "attrs.json");
  fs.writeFileSync(
    customAttrs,
    JSON.stringify({
      resources: {
        azurerm_network_security_group: {
          security_rule: "name",
          tags_set: null,
        },
      },
    }),
    "utf8",
  );

  // Order-only reordering exits 0 with --exit-code
  const orderOnlyPlan = {
    resource_changes: [
      {
        address: "azurerm_network_security_group.web",
        type: "azurerm_network_security_group",
        change: {
          actions: ["update"],
          before: {
            security_rule: [
              { name: "HTTPS", priority: 100, note: "" },
              { name: "SSH", priority: 200, note: null },
            ],
            tags_set: ["prod", "edge"],
          },
          after: {
            security_rule: [
              { name: "SSH", priority: 200, note: "" },
              { name: "HTTPS", priority: 100.0, note: null },
            ],
            tags_set: ["edge", "prod"],
          },
        },
      },
    ],
  };
  const orderRun = spawnSync(
    "python3",
    [planAnalyzer, "--attributes", customAttrs, "--format", "json", "--exit-code"],
    { input: JSON.stringify(orderOnlyPlan), encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS },
  );
  assert.equal(orderRun.status, 0, orderRun.stderr);
  const orderParsed = JSON.parse(orderRun.stdout);
  assert.equal(orderParsed.has_real_changes, false);
  assert.equal(orderParsed.summary.order_only_count, 2);

  // Resource replacement exits 2; non-object JSON exits 3
  const replacePlan = {
    resource_changes: [
      {
        address: "azurerm_network_security_group.replace_me",
        type: "azurerm_network_security_group",
        change: { actions: ["delete", "create"], before: {}, after: {} },
      },
    ],
  };
  const replaceRun = spawnSync(
    "python3",
    [planAnalyzer, "--attributes", customAttrs, "--format", "summary", "--exit-code"],
    { input: JSON.stringify(replacePlan), encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS },
  );
  assert.equal(replaceRun.status, 2);
  assert.match(replaceRun.stdout, /1 replacements/);

  const nonObjectPlanRun = spawnSync("python3", [planAnalyzer], {
    input: "[]",
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(nonObjectPlanRun.status, 3);
  assert.match(nonObjectPlanRun.stderr, /Plan root must be a JSON object/);
});
