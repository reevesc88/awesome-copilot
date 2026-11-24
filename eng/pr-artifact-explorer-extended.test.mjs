import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { invalidateAccounts, resolveAccounts } from "../extensions/pr-artifact-explorer/accounts.mjs";
import {
  GitHubApiError,
  getArtifact,
  getPullRequest,
  getRepository,
  githubRequest,
  listPullRequestArtifacts,
  listRepositoryContributors,
  openArtifactDownload,
  searchPullRequests,
  suggestRepositories,
} from "../extensions/pr-artifact-explorer/github.mjs";
import { renderHtml } from "../extensions/pr-artifact-explorer/render.mjs";
import {
  CAPABILITY_TOKEN_HEADER,
  hasCapabilityToken,
  isCanonicalHost,
  isCrossSiteRequest,
  requiresCapabilityToken,
} from "../extensions/pr-artifact-explorer/security.mjs";
import {
  DEFAULT_PREFS,
  normalizePrefs,
  normalizeRepository,
  rememberRepository,
  setExplorerPreferences,
  setFavoriteRepository,
  setPinnedRepository,
  setPlayerPreferences,
  setPullFilterPreferences,
} from "../extensions/pr-artifact-explorer/state.mjs";
import { ROOT_FOLDER } from "./constants.mjs";

function makeTempDir(t, prefix = "awesome-copilot-prae-ext-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeResponse(body, { status = 200, contentType = "application/json", headers = {} } = {}) {
  const map = new Map(
    Object.entries({ "content-type": contentType, ...headers }).map(([k, v]) => [
      k.toLowerCase(),
      String(v),
    ]),
  );
  const rawText = typeof body === "string" ? body : body == null ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    text: async () => rawText,
    json: async () => JSON.parse(rawText),
    body: body === undefined ? null : { getReader() {} },
  };
}

/**
 * Minimal pure-JS XML parser + DOM tree stub sufficient to run trx-preview.js
 * deterministically inside node:vm with zero external dependencies.
 */
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
      getAttribute(name) {
        return attrMap.get(name) ?? null;
      },
      get textContent() {
        return (
          this._textParts.join("") +
          this.children.map((child) => child.textContent).join("")
        );
      },
      getElementsByTagName(query) {
        const out = [];
        const visit = (node) => {
          for (const child of node.children) {
            if (query === "*" || child.tagName === query || child.localName === query) {
              out.push(child);
            }
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
    if (match.index !== lastIndex) {
      return createErrorDoc("Malformed XML token boundary.");
    }
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
      if (stack.length <= 1 || stack[stack.length - 1].tagName !== tag) {
        return createErrorDoc(`Mismatched closing tag </${tag}>.`);
      }
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
    if (!selfClosing) {
      stack.push(el);
    }
  }

  if (lastIndex !== cleaned.length || stack.length !== 1 || rootHolder.children.length !== 1) {
    return createErrorDoc("Unclosed or missing root XML element.");
  }

  return {
    documentElement: rootHolder.children[0],
    getElementsByTagName(query) {
      const root = rootHolder.children[0];
      const list = query === "*" || root.tagName === query || root.localName === query ? [root] : [];
      return list.concat(root.getElementsByTagName(query));
    },
  };

  function createErrorDoc(reason) {
    const errNode = makeElement("parsererror");
    errNode._textParts.push(reason);
    return {
      documentElement: errNode,
      getElementsByTagName() {
        return [errNode];
      },
    };
  }
}

test("pr-artifact-explorer state normalizes preferences, enforces pin/favorite/recent/filter caps, and rounds player settings", () => {
  assert.equal(
    normalizeRepository("https://github.com/octo-org/my.repo.git"),
    "octo-org/my.repo",
  );
  assert.throws(() => normalizeRepository("invalid-repo-slug"), /owner\/name format/);
  assert.throws(() => normalizeRepository("octo/repo/extra"), /owner\/name format/);

  const prefs = normalizePrefs({
    account: "",
    repository: "https://github.com/octo/alpha.git",
    pullState: "invalid-state",
    repositories: {
      pinned: "octo/pinned",
      favorites: ["octo/f1", "octo/f1", "octo/f2", "octo/f3", "octo/f4"],
      recent: Array.from({ length: 15 }, (_, i) => `octo/r-${i}`),
    },
    explorer: { sidebarCollapsed: "yes" },
    player: { fontSize: "99px", fontFamily: "comic", lineHeight: 1.36, speed: 1.5 },
  });

  assert.equal(prefs.account, null);
  assert.equal(prefs.repository, "octo/alpha");
  assert.equal(prefs.pullState, DEFAULT_PREFS.pullState);
  assert.equal(prefs.repositories.pinned, "octo/pinned");
  assert.deepEqual(prefs.repositories.favorites, ["octo/f1", "octo/f2", "octo/f3"]);
  assert.equal(prefs.repositories.recent.length, 12);
  assert.equal(prefs.repositories.recent[0], "octo/alpha");
  assert.equal(prefs.explorer.sidebarCollapsed, false);
  assert.deepEqual(prefs.player, {
    fontSize: "16px",
    fontFamily: "system",
    lineHeight: 1.4,
    speed: 1.5,
  });

  assert.equal(
    normalizePrefs({
      repositories: { pinned: "octo/pinned", favorites: ["octo/pinned", "octo/f1"] },
    }).repositories.favorites.includes("octo/pinned"),
    false,
  );

  // Pinning a favorite evicts it from favorites; favoriting the pinned repo or a 4th repo throws
  setPinnedRepository(prefs, "octo/f1");
  assert.equal(prefs.repositories.pinned, "octo/f1");
  assert.deepEqual(prefs.repositories.favorites, ["octo/f2", "octo/f3"]);
  assert.throws(() => setFavoriteRepository(prefs, "octo/f1", true), /already available/);

  setFavoriteRepository(prefs, "octo/f4", true);
  assert.deepEqual(prefs.repositories.favorites, ["octo/f4", "octo/f2", "octo/f3"]);
  assert.throws(() => setFavoriteRepository(prefs, "octo/f5", true), /up to three/);
  setFavoriteRepository(prefs, "octo/f2", false);
  assert.deepEqual(prefs.repositories.favorites, ["octo/f4", "octo/f3"]);
  assert.equal(setPinnedRepository(prefs, ""), null);

  rememberRepository(prefs, "octo/newest");
  assert.equal(prefs.repositories.recent[0], "octo/newest");
  assert.equal(prefs.repositories.recent.length, 12);

  // Pull filters cap at 50 entries ordered by newest updatedAt and sanitize fields
  const rawFilters = {};
  for (let i = 0; i < 55; i++) {
    rawFilters[`Octo/Repo-${i}`] = {
      state: i % 2 === 0 ? "closed" : "bogus",
      author: `  user-${i}-${"x".repeat(110)}  `,
      artifacts: i % 2 === 0 ? "with" : "bogus",
      ci: i % 3 === 0 ? "failing" : "bogus",
      updatedAt: i + 1,
    };
  }
  const filterPrefs = normalizePrefs({ pullFilters: rawFilters });
  const keys = Object.keys(filterPrefs.pullFilters);
  assert.equal(keys.length, 50);
  assert.equal(keys.includes("octo/repo-0"), false);
  assert.equal(keys.includes("octo/repo-54"), true);
  assert.equal(filterPrefs.pullFilters["octo/repo-54"].author.length, 100);
  assert.equal(filterPrefs.pullFilters["octo/repo-54"].state, "closed");
  assert.equal(filterPrefs.pullFilters["octo/repo-53"].state, "open");

  const updatedFilter = setPullFilterPreferences(filterPrefs, "Octo/Custom", {
    state: "all",
    author: "   ",
    artifacts: "without",
    ci: "passing",
  });
  assert.equal(updatedFilter.author, null);
  assert.equal(updatedFilter.state, "all");
  assert.equal(updatedFilter.artifacts, "without");
  assert.equal(updatedFilter.ci, "passing");

  assert.deepEqual(setExplorerPreferences(filterPrefs, { sidebarCollapsed: true }), {
    sidebarCollapsed: true,
  });
  assert.deepEqual(
    setPlayerPreferences(filterPrefs, { fontSize: "20px", fontFamily: "cascadia", lineHeight: 9, speed: 99 }),
    { fontSize: "20px", fontFamily: "cascadia", lineHeight: 1.2, speed: 1 },
  );
});

test("pr-artifact-explorer render and security helpers escape capability tokens and enforce origin/fetch-site/header rules", () => {
  const html = renderHtml('test-cap-"&<>');
  assert.match(
    html,
    /<meta name="pr-artifact-explorer-token" content="test-cap-&quot;&amp;&lt;&gt;" \/>/,
  );
  assert.equal(html.includes("__PR_ARTIFACT_EXPLORER_CAPABILITY_TOKEN__"), false);

  assert.equal(isCanonicalHost({ headers: {} }, "127.0.0.1:4000"), false);
  assert.equal(isCanonicalHost({ headers: { host: "LOCALHOST:4000" } }, "localhost:4000"), true);

  assert.equal(isCrossSiteRequest({ headers: { origin: "null" } }, "http://127.0.0.1:4000"), true);
  assert.equal(
    isCrossSiteRequest({ headers: { origin: "vscode-webview://panel" } }, "http://127.0.0.1:4000"),
    false,
  );
  assert.equal(
    isCrossSiteRequest({ headers: { "sec-fetch-site": "same-site" } }, "http://127.0.0.1:4000"),
    true,
  );
  assert.equal(
    isCrossSiteRequest({ headers: { "sec-fetch-site": "same-origin" } }, "http://127.0.0.1:4000"),
    false,
  );
  assert.equal(isCrossSiteRequest({ headers: {} }, "http://127.0.0.1:4000"), false);

  assert.equal(requiresCapabilityToken("/events/sub"), false);
  assert.equal(hasCapabilityToken({ headers: {} }, new URL("http://127.0.0.1/events?token=x"), ""), false);
  assert.equal(
    hasCapabilityToken(
      { headers: { [CAPABILITY_TOKEN_HEADER]: ["test-cap", "second"] } },
      new URL("http://127.0.0.1/api/pulls"),
      "test-cap",
    ),
    true,
  );
});

test("pr-artifact-explorer accounts resolves, deduplicates, scores, sanitizes, and caches multi-source GitHub accounts offline", async (t) => {
  invalidateAccounts();
  t.after(() => invalidateAccounts());

  const fakeBin = makeTempDir(t, "prae-gh-bin-");
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo "  Logged in to github.com account cli-user (keyring)"
  echo "  Logged in to github.com account cli-user (duplicate)"
  echo "  Logged in to ghe.internal.example account enterprise-user (keyring)"
elif [ "$1" = "auth" ] && [ "$2" = "token" ]; then
  printf 'test-token-gh\\n'
fi
`,
    { mode: 0o755 },
  );

  const savedEnv = { ...process.env };
  const origFetch = globalThis.fetch;
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    globalThis.fetch = origFetch;
  });

  for (const key of Object.keys(process.env)) {
    if (key.startsWith("COPILOT_GH_ACCOUNT_")) delete process.env[key];
  }
  process.env.PATH = `${fakeBin}${path.delimiter}${savedEnv.PATH ?? ""}`;
  process.env.COPILOT_GH_ACCOUNT_github_2E_com_ada_2D_dev = "test-token-copilot";
  process.env.GH_TOKEN = "test-token-copilot"; // duplicate token hash -> deduplicated under copilot
  process.env.GITHUB_TOKEN = "test-token-expired";

  let probeRequests = 0;
  globalThis.fetch = async (url, init = {}) => {
    probeRequests += 1;
    const auth = init.headers?.Authorization ?? "";
    const pathname = new URL(url).pathname;

    if (auth === "Bearer test-token-copilot") {
      if (pathname === "/user") {
        return makeResponse(
          { login: "ada-dev", name: "Ada", html_url: "https://github.com/ada-dev" },
          { headers: { "x-oauth-scopes": "repo, workflow" } },
        );
      }
      return makeResponse({ message: "Not Found" }, { status: 404 });
    }

    if (auth === "Bearer test-token-gh") {
      if (pathname === "/user") {
        return makeResponse(
          { login: "cli-user", name: "CLI User" },
          { headers: { "x-oauth-scopes": "repo" } },
        );
      }
      return makeResponse({ id: 1, full_name: "octo/private-repo" }, { status: 200 });
    }

    return makeResponse({ message: "Bad credentials" }, { status: 401 });
  };

  const resolved = await resolveAccounts({
    preferredId: "acct:unknown", // failed account -> must fall back to account with repo access
    repository: "octo/private-repo",
  });

  assert.equal(resolved.active?.login, "cli-user");
  assert.equal(resolved.activeToken, "test-token-gh");
  assert.equal("token" in resolved.active, false);
  assert.equal(resolved.accounts.every((acct) => !("token" in acct)), true);

  const adaAccount = resolved.accounts.find((a) => a.login === "ada-dev");
  assert.equal(adaAccount.status, "limited");
  assert.equal(adaAccount.repositoryAccess, false);
  assert.deepEqual(adaAccount.scopes, ["repo", "workflow"]);

  const failedAccount = resolved.accounts.find((a) => a.status === "failed");
  assert.ok(failedAccount);
  assert.equal(failedAccount.reason, "Bad credentials");

  // Cached lookup does not re-probe until force:true or invalidateAccounts()
  const probesBeforeCached = probeRequests;
  const cached = await resolveAccounts({
    preferredId: "acct:unknown",
    repository: "octo/private-repo",
  });
  assert.equal(probeRequests, probesBeforeCached);
  assert.equal(cached.active.login, "cli-user");

  // Preferred valid account wins even when limited
  const preferredAda = await resolveAccounts({
    preferredId: "acct:ada-dev",
    repository: "octo/private-repo",
    force: true,
  });
  assert.equal(preferredAda.active?.login, "ada-dev");
  assert.equal(preferredAda.activeToken, "test-token-copilot");
});

test("pr-artifact-explorer github client validates inputs, sanitizes search qualifiers, maps GraphQL signals, and handles API errors offline", async (t) => {
  const origFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = origFetch;
  });

  await assert.rejects(() => githubRequest("", "/user"), (err) => {
    assert.ok(err instanceof GitHubApiError);
    assert.equal(err.status, 401);
    return true;
  });
  await assert.rejects(() => githubRequest("test-token", "relative/path"), /must be absolute/);
  await assert.rejects(() => getPullRequest("test-token", "octo/demo", 0), /positive integer/);
  await assert.rejects(() => getArtifact("test-token", "octo/demo", "abc"), /positive integer/);

  // Short / oversized / invalid owner queries return [] without calling fetch
  globalThis.fetch = async () => {
    throw new Error("unexpected fetch");
  };
  assert.deepEqual(await suggestRepositories("test-token", ""), []);
  assert.deepEqual(await suggestRepositories("test-token", "a"), []);
  assert.deepEqual(await suggestRepositories("test-token", "x".repeat(101)), []);
  assert.deepEqual(await suggestRepositories("test-token", "bad!owner/repo"), []);

  // Malformed JSON and non-2xx responses surface GitHubApiError
  globalThis.fetch = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/broken-json") {
      return makeResponse("{corrupt", { status: 200 });
    }
    return makeResponse("Gateway timeout", { status: 504, contentType: "text/plain" });
  };
  await assert.rejects(() => githubRequest("test-token", "/broken-json"), /malformed JSON/);
  await assert.rejects(() => githubRequest("test-token", "/gateway"), (err) => {
    assert.ok(err instanceof GitHubApiError);
    assert.equal(err.status, 504);
    assert.match(err.message, /504/);
    return true;
  });

  // Repository summary, org/user suggestions, contributors, and sanitized PR search
  let capturedSearchQuery = "";
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/repos/octo/demo") {
      return makeResponse({
        full_name: "octo/demo",
        name: "demo",
        owner: { login: "octo", type: "Organization" },
        private: true,
        archived: false,
        html_url: "https://github.com/octo/demo",
      });
    }
    if (parsed.pathname === "/users/octo") {
      return makeResponse({ login: "octo", type: "Organization" });
    }
    if (parsed.pathname === "/orgs/octo/repos") {
      return makeResponse([
        { full_name: "octo/one", name: "one", owner: { login: "octo" }, html_url: "https://github.com/octo/one" },
      ]);
    }
    if (parsed.pathname === "/search/repositories") {
      return makeResponse({
        items: [
          { full_name: "octo/demo-cli", name: "demo-cli", owner: { login: "octo" }, html_url: "https://github.com/octo/demo-cli" },
        ],
      });
    }
    if (parsed.pathname === "/repos/octo/demo/contributors") {
      return makeResponse([
        { login: "ada", node_id: "U_1", contributions: 12 },
        { login: "dependabot[bot]", node_id: "B_1", type: "Bot", contributions: 3 },
        { contributions: 1 }, // anonymous entry filtered out
      ]);
    }
    if (parsed.pathname === "/search/issues") {
      capturedSearchQuery = parsed.searchParams.get("q") ?? "";
      return makeResponse({
        total_count: 2,
        incomplete_results: false,
        items: [
          { number: 10, title: "Failing PR", state: "open", user: { login: "ada" }, html_url: "https://github.com/octo/demo/pull/10" },
          { number: 11, title: "Passing PR", state: "open", user: { login: "bob" }, html_url: "https://github.com/octo/demo/pull/11" },
        ],
      });
    }
    if (parsed.pathname === "/graphql") {
      const body = JSON.parse(init.body);
      if (body.query.includes("ContributorProfiles")) {
        return makeResponse({
          data: {
            nodes: [
              { id: "U_1", login: "ada", name: "  Ada Lovelace  " },
              { id: "B_1", login: "dependabot[bot]" },
            ],
          },
        });
      }
      return makeResponse({
        data: {
          repository: {
            pull0: {
              number: 10,
              isDraft: false,
              headRefOid: "sha-10",
              reviewDecision: "CHANGES_REQUESTED",
              totalCommentsCount: 4,
              commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
            },
            pull1: {
              number: 11,
              isDraft: true,
              headRefOid: "sha-11",
              reviewDecision: "APPROVED",
              totalCommentsCount: 1,
              commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
            },
          },
        },
      });
    }
    if (parsed.pathname === "/repos/octo/demo/pulls/99") {
      return makeResponse({
        number: 99,
        title: "No head sha",
        state: "closed",
        head: { sha: null },
        base: { ref: "main" },
      });
    }
    if (parsed.pathname === "/repos/octo/demo/actions/artifacts/55/zip") {
      return makeResponse("", { status: 200, headers: {} });
    }
    throw new Error(`Unhandled URL: ${url}`);
  };

  const repo = await getRepository("test-token", "octo/demo");
  assert.equal(repo.visibility, "private");
  assert.equal((await suggestRepositories("test-token", "octo/")).length, 1);
  assert.equal((await suggestRepositories("test-token", "octo/cli")).length, 1);
  assert.equal((await suggestRepositories("test-token", "demo")).length, 1);

  const contributors = await listRepositoryContributors("test-token", "octo/demo");
  assert.equal(contributors.length, 2);
  assert.equal(contributors[0].name, "Ada Lovelace");
  assert.equal(contributors[1].name, null);

  const searchRes = await searchPullRequests(
    "test-token",
    "octo/demo",
    'repo:evil/other org:bad user:"spoof" author:ada',
    "open",
    { ci: "failing" },
  );
  assert.equal(capturedSearchQuery, "repo:octo/demo is:pr author:ada is:open");
  assert.equal(searchRes.filtered, true);
  assert.deepEqual(searchRes.pulls.map((p) => p.number), [10]);

  const noHeadArtifacts = await listPullRequestArtifacts("test-token", "octo/demo", 99);
  assert.deepEqual(noHeadArtifacts.artifacts, []);

  // Empty response body on openArtifactDownload throws GitHubApiError
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/zip" },
    body: null,
    text: async () => "",
  });
  await assert.rejects(
    () => openArtifactDownload("test-token", "octo/demo", 55),
    /empty response/,
  );
});

test("pr-artifact-explorer TrxPreview parses TRX XML, durations, nested results, and rejects DTD/XXE and bare ISO period strings", () => {
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

  // Rejects DTD / ENTITY declarations and non-TestRun documents
  assert.throws(
    () => TrxPreview.parse('<!DOCTYPE TestRun [<!ENTITY x "1">]><TestRun/>'),
    /DTD and entity declarations are not supported/,
  );
  assert.throws(() => TrxPreview.parse("<OtherRoot />"), /TestRun root element/);
  assert.throws(() => TrxPreview.parse("<TestRun><broken></TestRun>"), /Mismatched|Malformed|Unclosed/);

  const trxXml = `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="run-1" name="CI Suite" runUser="runner">
  <Times start="2026-03-15T10:00:00Z" finish="2026-03-15T10:00:05Z" />
  <ResultSummary outcome="Completed">
    <Counters total="4" passed="1" failed="1" notExecuted="1" />
  </ResultSummary>
  <TestDefinitions>
    <UnitTest name="LoginWorks" id="T-1">
      <TestMethod codeBase="App.Tests.dll" adapterTypeName="executor://xunit" className="App.AuthTests" name="LoginWorks" />
    </UnitTest>
    <UnitTest name="RejectsExpiredSession" id="T-2">
      <TestMethod className="App.AuthTests" name="RejectsExpiredSession" />
    </UnitTest>
  </TestDefinitions>
  <TestLists>
    <TestList name="All Loaded Results" id="L-1" />
  </TestLists>
  <Results>
    <UnitTestResult testId="t-1" testListId="l-1" outcome="Passed" duration="00:00:00.250" />
    <TestResultAggregation testId="t-2" outcome="Failed" duration="PT1M30.5S">
      <Output>
        <ErrorInfo>
          <Message>Expected 401 &lt;Unauthorized&gt;</Message>
          <StackTrace>at App.AuthTests.RejectsExpiredSession()</StackTrace>
        </ErrorInfo>
        <ResultFiles><ResultFile path="logs/failure.txt" /></ResultFiles>
      </Output>
      <InnerResults>
        <UnitTestResult testName="Row 1 (bare P duration)" outcome="NotExecuted" duration="P" />
        <UnitTestResult testName="Row 2 (bare PT duration)" outcome="CustomOutcome" duration="PT" />
      </InnerResults>
    </TestResultAggregation>
  </Results>
</TestRun>`;

  const parsed = TrxPreview.parse(trxXml);
  assert.equal(parsed.name, "CI Suite");
  assert.equal(parsed.durationMs, 5_000);
  assert.deepEqual({ ...parsed.summaryCounts }, { total: 4, passed: 1, failed: 1, skipped: 1 });
  assert.equal(parsed.results.length, 4);

  const [passedItem, failedItem, barePItem, barePtItem] = parsed.results;
  assert.equal(passedItem.className, "App.AuthTests");
  assert.equal(passedItem.testListName, "All Loaded Results");
  assert.equal(passedItem.durationMs, 250);

  assert.equal(failedItem.category, "failed");
  assert.equal(failedItem.durationMs, 90_500);
  assert.equal(failedItem.message, "Expected 401 <Unauthorized>");
  assert.deepEqual([...failedItem.resultFiles], ["logs/failure.txt"]);

  // Nested InnerResults carry depth=1 and invalid bare ISO "P" / "PT" durations resolve to null (not 0ms)
  assert.equal(barePItem.depth, 1);
  assert.equal(barePItem.category, "skipped");
  assert.equal(barePItem.durationMs, null);
  assert.equal(barePtItem.category, "other");
  assert.equal(barePtItem.durationMs, null);
});
