import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import {
  applyQualityGateResult,
  evaluateExternalPluginIssue,
  isPublicAddress,
  parseExternalPluginIssueBody,
  parseMarkReadyForReviewCommand,
  parseRerunIntakeCommand,
  PinnedAddressDispatcher,
  validateCanvasPluginMetadata,
} from "./external-plugin-intake.mjs";

const REPO = "owner/repo";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PLUGIN_ROOT = "plugins/upgrade-agent";

const TREE_PLUGINS = "tree-plugins";
const TREE_UPGRADE_AGENT = "tree-upgrade-agent";
const TREE_EXTENSIONS = "tree-extensions";

function fileNode(content) {
  return { type: "file", content: Buffer.from(content, "utf8").toString("base64") };
}

function treeEntry(path, type, sha) {
  return { path, type, mode: type === "tree" ? "040000" : "100644", sha: sha ?? "deadbeef" };
}

function treeResponse(entries, { truncated = false } = {}) {
  return { status: 200, data: { sha: "resolved", truncated, tree: entries } };
}

function decodeContentsPath(url) {
  const { pathname } = new URL(url);
  const afterContents = pathname.split("/contents/")[1] ?? "";
  return afterContents
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment))
    .join("/");
}

function decodeTreeish(url) {
  const match = String(url).match(/\/git\/trees\/([^/?]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function withMockedFetch({ contents = {}, trees = {} }, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    let route;
    if (requestUrl.includes("/git/trees/")) {
      route = trees[decodeTreeish(requestUrl)] ?? { status: 404, data: {} };
    } else {
      route = contents[decodeContentsPath(requestUrl)] ?? { status: 404, data: {} };
    }
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.data ?? {},
    };
  };

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const canvasManifest = fileNode(
  JSON.stringify({
    name: "upgrade-agent",
    version: "1.0.0",
    description: "Canvas plugin",
    logo: "assets/preview.png",
  }),
);

function baseContents(extra) {
  return {
    [`${PLUGIN_ROOT}/.github/plugin/plugin.json`]: { status: 200, data: canvasManifest },
    [`${PLUGIN_ROOT}/assets/preview.png`]: { status: 200, data: fileNode("binary") },
    ...extra,
  };
}

// Wires up the directory-walk that resolves plugins/upgrade-agent/extensions to a tree SHA.
// `extensionsEntry` controls what the walk finds at the final ".../extensions" step, and
// `extensionsSubtree` is the recursive listing returned for that resolved tree SHA.
function buildTrees({ extensionsEntry, extensionsSubtree, overrides } = {}) {
  const trees = {
    [SHA]: treeResponse([treeEntry("plugins", "tree", TREE_PLUGINS)]),
    [TREE_PLUGINS]: treeResponse([treeEntry("upgrade-agent", "tree", TREE_UPGRADE_AGENT)]),
    [TREE_UPGRADE_AGENT]: treeResponse([
      extensionsEntry ?? treeEntry("extensions", "tree", TREE_EXTENSIONS),
    ]),
  };
  if (extensionsSubtree) {
    trees[TREE_EXTENSIONS] = extensionsSubtree;
  }
  return { ...trees, ...overrides };
}

function makePlugin() {
  return {
    name: "upgrade-agent",
    keywords: ["canvas"],
    source: { source: "github", repo: REPO, sha: SHA, path: PLUGIN_ROOT },
  };
}

async function runValidation({ contents, trees }) {
  const errors = [];
  const warnings = [];
  await withMockedFetch({ contents: baseContents(contents), trees }, () =>
    validateCanvasPluginMetadata(makePlugin(), errors, warnings, null),
  );
  return { errors, warnings };
}

test("validateCanvasPluginMetadata accepts a nested extension entry point", async () => {
  const { errors, warnings } = await runValidation({
    trees: buildTrees({
      extensionsSubtree: treeResponse([
        treeEntry("modernize-dashboard", "tree"),
        treeEntry("modernize-dashboard/extension.mjs", "blob"),
      ]),
    }),
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("validateCanvasPluginMetadata accepts a flat extension entry point", async () => {
  const { errors, warnings } = await runValidation({
    trees: buildTrees({
      extensionsSubtree: treeResponse([treeEntry("extension.mjs", "blob")]),
    }),
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("validateCanvasPluginMetadata rejects when no extension.mjs exists flat or nested", async () => {
  const { errors } = await runValidation({
    trees: buildTrees({
      extensionsSubtree: treeResponse([
        treeEntry("modernize-dashboard", "tree"),
        treeEntry("modernize-dashboard/index.mjs", "blob"),
      ]),
    }),
  });

  assert.equal(
    errors.some((message) => /must include a canvas extension entry point/.test(message)),
    true,
  );
});

test("validateCanvasPluginMetadata rejects when the extensions directory is missing", async () => {
  const { errors } = await runValidation({
    trees: buildTrees({
      extensionsEntry: treeEntry("other-dir", "tree", "tree-other"),
    }),
  });

  assert.equal(
    errors.some((message) => /must include an "extensions" directory/.test(message)),
    true,
  );
});

test("validateCanvasPluginMetadata rejects when extensions is a file rather than a directory", async () => {
  const { errors } = await runValidation({
    trees: buildTrees({
      extensionsEntry: treeEntry("extensions", "blob", "blob-extensions"),
    }),
  });

  assert.equal(
    errors.some((message) => /"extensions" must be a directory/.test(message)),
    true,
  );
});

test("validateCanvasPluginMetadata rejects when extensions/extension.mjs is a directory", async () => {
  const { errors } = await runValidation({
    trees: buildTrees({
      extensionsSubtree: treeResponse([
        treeEntry("extension.mjs", "tree"),
        treeEntry("extension.mjs/placeholder.txt", "blob"),
      ]),
    }),
  });

  assert.equal(
    errors.some((message) => /"extensions\/extension\.mjs" must be a file/.test(message)),
    true,
  );
});

test("validateCanvasPluginMetadata surfaces an unverifiable result when the tree walk errors", async () => {
  const { errors, warnings } = await runValidation({
    trees: buildTrees({
      overrides: { [SHA]: { status: 500, data: {} } },
    }),
  });

  assert.deepEqual(errors, []);
  assert.equal(
    warnings.some((message) => /could not verify the canvas extension entry point/.test(message)),
    true,
  );
});

test("validateCanvasPluginMetadata treats a truncated walk level as unverifiable", async () => {
  const { errors, warnings } = await runValidation({
    trees: buildTrees({
      overrides: {
        [TREE_UPGRADE_AGENT]: treeResponse(
          [treeEntry("extensions", "tree", TREE_EXTENSIONS)],
          { truncated: true },
        ),
      },
    }),
  });

  assert.deepEqual(errors, []);
  assert.equal(
    warnings.some((message) => /could not verify the canvas extension entry point/.test(message)),
    true,
  );
});

test("validateCanvasPluginMetadata treats a truncated extensions subtree without an entry point as unverifiable", async () => {
  const { errors, warnings } = await runValidation({
    trees: buildTrees({
      extensionsSubtree: treeResponse([treeEntry("modernize-dashboard", "tree")], { truncated: true }),
    }),
  });

  assert.deepEqual(errors, []);
  assert.equal(
    warnings.some((message) => /could not verify the canvas extension entry point/.test(message)),
    true,
  );
});

test("validateCanvasPluginMetadata accepts an entry point found within a truncated subtree", async () => {
  const { errors, warnings } = await runValidation({
    trees: buildTrees({
      extensionsSubtree: treeResponse(
        [
          treeEntry("modernize-dashboard", "tree"),
          treeEntry("modernize-dashboard/extension.mjs", "blob"),
        ],
        { truncated: true },
      ),
    }),
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// ref/sha consistency tests (evaluateExternalPluginIssue)
// ---------------------------------------------------------------------------

const ORIGINAL_FETCH = global.fetch;
const INTAKE_REPO = "octo/example";
const RESOLVED_REF_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROVIDED_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

function buildIssueBody({ ref, sha }) {
  return [
    "<!-- external-plugin-submission -->",
    "### Plugin name",
    "",
    "intake-ref-sha-consistency-test-plugin",
    "",
    "### Short description",
    "",
    "Test plugin for external intake validation.",
    "",
    "### GitHub repository",
    "",
    INTAKE_REPO,
    "",
    "### Plugin path inside the repository",
    "",
    "_No response_",
    "",
    "### Ref to review",
    "",
    ref,
    "",
    "### Commit SHA to review",
    "",
    sha,
    "",
    "### Version",
    "",
    "1.2.3",
    "",
    "### License identifier",
    "",
    "MIT",
    "",
    "### Author name",
    "",
    "Copilot Test",
    "",
    "### Author URL",
    "",
    "_No response_",
    "",
    "### Homepage URL",
    "",
    "_No response_",
    "",
    "### Keywords",
    "",
    "testing",
    "",
    "### Additional notes for reviewers",
    "",
    "_No response_",
    "",
    "### Submission checklist",
    "",
    "- [x] The plugin lives in a public GitHub repository.",
    "- [x] The ref and/or sha I provided is immutable (release tag and/or full 40-character commit SHA), not a branch.",
    "- [x] This submission follows this repository's contribution, security, and responsible AI policies.",
    "- [x] This plugin is not already listed in the Awesome Copilot marketplace.",
    "",
  ].join("\n");
}

function jsonResponse(payload, { status = 200, text } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : "OK",
    headers: new Map(),
    async json() {
      return payload;
    },
    async text() {
      return text ?? "";
    },
    body: text === undefined
      ? null
      : new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      }),
  };
}

const PUBLIC_HOMEPAGE_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }];

test("evaluateExternalPluginIssue surfaces repository and homepage review signals", async () => {
  installMockFetch();
  const githubFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url) === "https://example.com/pricing") {
      return jsonResponse({}, { text: "<html><body>Pricing · Book a demo · Start your free trial</body></html>" });
    }
    return githubFetch(url, options);
  };

  const issue = {
    body: buildIssueBody({ ref: "v1.2.3", sha: RESOLVED_REF_SHA }).replace(
      "### Homepage URL\n\n_No response_",
      "### Homepage URL\n\nhttps://example.com/pricing",
    ),
  };
  const result = await evaluateExternalPluginIssue({
    issue,
    lookupFn: PUBLIC_HOMEPAGE_LOOKUP,
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.reviewSignals.homepage.signals, ["pricing", "sales", "trial"]);
  assert.match(result.commentBody, /3 watchers · 0 forks · 4 open issues\/PRs/);
  assert.match(result.commentBody, /### Reviewer signals/);
  assert.match(result.commentBody, /Homepage heuristics.*pricing, sales, trial/);
});

test("evaluateExternalPluginIssue rejects homepage URLs resolving to loopback", async () => {
  installMockFetch();
  const issue = {
    body: buildIssueBody({ ref: "v1.2.3", sha: RESOLVED_REF_SHA }).replace(
      "### Homepage URL\n\n_No response_",
      "### Homepage URL\n\nhttps://127.0.0.1/",
    ),
  };

  const result = await evaluateExternalPluginIssue({ issue });

  assert.equal(result.valid, true);
  assert.match(result.reviewSignals.homepage.output, /non-public address/);
});

test("homepage inspection limits streamed content to 512 KB", async () => {
  installMockFetch();
  const homepage = `${"a".repeat(512_000)} pricing`;
  const githubFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url) === "https://example.com/large") {
      return jsonResponse({}, { text: homepage });
    }
    return githubFetch(url, options);
  };
  const issue = {
    body: buildIssueBody({ ref: "v1.2.3", sha: RESOLVED_REF_SHA }).replace(
      "### Homepage URL\n\n_No response_",
      "### Homepage URL\n\nhttps://example.com/large",
    ),
  };

  const result = await evaluateExternalPluginIssue({
    issue,
    lookupFn: PUBLIC_HOMEPAGE_LOOKUP,
  });

  assert.equal(result.valid, true);
  assert.equal(result.reviewSignals.homepage.status, "pass");
  assert.deepEqual(result.reviewSignals.homepage.signals, []);
});

test("pinned homepage dispatcher connects to the validated address and preserves Host", async () => {
  let receivedHost;
  const server = http.createServer((request, response) => {
    receivedHost = request.headers.host;
    response.end("pinned");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const url = new URL(`http://example.com:${port}/homepage`);

  try {
    const response = await fetch(url, {
      dispatcher: new PinnedAddressDispatcher(url, { address: "127.0.0.1", family: 4 }),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "pinned");
    assert.equal(receivedHost, `example.com:${port}`);
  } finally {
    server.close();
  }
});

function installMockFetch() {
  global.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl === `https://api.github.com/repos/${INTAKE_REPO}`) {
      return jsonResponse({
        private: false,
        archived: false,
        created_at: new Date().toISOString(),
        stargazers_count: 0,
        subscribers_count: 3,
        forks_count: 0,
        open_issues_count: 4,
      });
    }

    if (
      requestUrl === `https://api.github.com/repos/${INTAKE_REPO}/git/commits/${PROVIDED_SHA}` ||
      requestUrl === `https://api.github.com/repos/${INTAKE_REPO}/git/commits/${RESOLVED_REF_SHA}`
    ) {
      const sha = requestUrl.endsWith(RESOLVED_REF_SHA) ? RESOLVED_REF_SHA : PROVIDED_SHA;
      return jsonResponse({ sha });
    }

    if (requestUrl === `https://api.github.com/repos/${INTAKE_REPO}/git/ref/tags/v1.2.3`) {
      return jsonResponse({ object: { type: "tag", sha: "cccccccccccccccccccccccccccccccccccccccc" } });
    }

    if (requestUrl === `https://api.github.com/repos/${INTAKE_REPO}/commits/v1.2.3`) {
      return jsonResponse({ sha: RESOLVED_REF_SHA });
    }

    return jsonResponse({}, { status: 404 });
  };
}

test("evaluateExternalPluginIssue fails when ref and sha resolve to different commits", async () => {
  installMockFetch();
  const issue = { body: buildIssueBody({ ref: "v1.2.3", sha: PROVIDED_SHA }) };

  const result = await evaluateExternalPluginIssue({ issue });

  assert.equal(result.valid, false);
  assert.match(
    result.commentBody,
    /must reference the same commit \(ref "v1\.2\.3" resolves to "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sha is "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"\)/,
  );
});

test("evaluateExternalPluginIssue passes when ref and sha resolve to the same commit", async () => {
  installMockFetch();
  const issue = { body: buildIssueBody({ ref: "v1.2.3", sha: RESOLVED_REF_SHA }) };

  const result = await evaluateExternalPluginIssue({ issue });

  assert.equal(result.valid, true);
  assert.equal(
    result.errors.some((error) => error.includes("must reference the same commit")),
    false,
  );
});

test("isPublicAddress filters private, loopback, link-local, documentation, and mapped IPv4/IPv6 ranges", () => {
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("127.0.0.1"), false);
  assert.equal(isPublicAddress("10.0.0.5"), false);
  assert.equal(isPublicAddress("100.64.1.1"), false);
  assert.equal(isPublicAddress("169.254.169.254"), false);
  assert.equal(isPublicAddress("172.16.0.1"), false);
  assert.equal(isPublicAddress("192.168.1.1"), false);
  assert.equal(isPublicAddress("224.0.0.1"), false);

  assert.equal(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946"), true);
  assert.equal(isPublicAddress("::1"), false);
  assert.equal(isPublicAddress("fe80::1"), false);
  assert.equal(isPublicAddress("fd00::1"), false);
  assert.equal(isPublicAddress("2001:db8::1"), false);
  assert.equal(isPublicAddress("::ffff:127.0.0.1"), false);
  assert.equal(isPublicAddress("::ffff:93.184.216.34"), true);
  assert.equal(isPublicAddress("not-an-ip"), false);
});

test("parseExternalPluginIssueBody, command parsers, and applyQualityGateResult handle legacy fields, overrides, and merged states", () => {
  assert.equal(parseRerunIntakeCommand("Updated tag.\n  /rerun-intake "), true);
  assert.equal(parseRerunIntakeCommand("/rerun-intake-later"), false);

  assert.deepEqual(
    parseMarkReadyForReviewCommand("Reviewed manually.\n/mark-ready-for-review transient CLI issue"),
    {
      command: "/mark-ready-for-review",
      reason: "transient CLI issue",
    },
  );
  assert.equal(parseMarkReadyForReviewCommand("No command here"), undefined);

  // Supports legacy "Immutable ref to review" heading + legacy checklist item text
  const legacyBody = [
    "<!-- external-plugin-submission -->",
    "### Plugin name\n\nlegacy-pack",
    "### Short description\n\nLegacy template submission",
    "### GitHub repository\n\nhttps://github.com/octo/legacy-pack.git",
    "### Immutable ref to review\n\nv2.0.0",
    "### Version\n\n2.0.0",
    "### License identifier\n\nMIT",
    "### Author name\n\nOcto",
    "### Keywords\n\nci, automation\nworkflow",
    "### Submission checklist",
    "- [x] The plugin lives in a public GitHub repository.",
    "- [x] The ref I provided is an immutable release tag or full 40-character commit SHA, not a branch.",
    "- [x] This submission follows this repository's contribution, security, and responsible AI policies.",
    "- [x] This plugin is not already listed in the Awesome Copilot marketplace.",
  ].join("\n\n");

  const parsedLegacy = parseExternalPluginIssueBody(legacyBody);
  assert.equal(parsedLegacy.markerPresent, true);
  assert.deepEqual(parsedLegacy.errors, []);
  assert.equal(parsedLegacy.plugin.source.repo, "octo/legacy-pack");
  assert.equal(parsedLegacy.plugin.source.ref, "v2.0.0");
  assert.deepEqual(parsedLegacy.plugin.keywords, ["ci", "automation", "workflow"]);

  // applyQualityGateResult merges states and workflow run links
  const baseEval = {
    valid: true,
    plugin: parsedLegacy.plugin,
    warnings: ["submission: minor note"],
    commentMarker: "<!-- external-plugin-intake -->",
    commentBody: "initial",
  };

  const specWarnMerged = applyQualityGateResult(
    JSON.stringify(baseEval),
    JSON.stringify({
      overall_status: "pass",
      failure_class: "none",
      spec_compliance_status: "warning",
      spec_compliance_output: "manifest location warning",
      vally_lint_status: "pass",
      smoke_status: "pass",
    }),
    "98765",
    "reevesc88",
    "awesome-copilot",
  );
  assert.equal(specWarnMerged.intakeState, "ready-for-review");
  assert.match(specWarnMerged.commentBody, /passed with spec warnings/);
  assert.match(specWarnMerged.commentBody, /actions\/runs\/98765/);

  const submitterFixMerged = applyQualityGateResult(baseEval, {
    overall_status: "fail",
    failure_class: "submitter_fixes",
    vally_lint_status: "fail",
  });
  assert.equal(submitterFixMerged.intakeState, "requires-submitter-fixes");

  const infraMerged = applyQualityGateResult(baseEval, {
    overall_status: "infra_error",
    failure_class: "infra",
    smoke_status: "infra_error",
  });
  assert.equal(infraMerged.intakeState, "awaiting-review");
});
