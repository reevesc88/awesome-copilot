import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ROOT_FOLDER } from "./constants.mjs";

const SUBPROCESS_TIMEOUT_MS = 10_000;
const SKILLS_ROOT = path.join(ROOT_FOLDER, "skills");

function makeTempDir(t, prefix = "awesome-copilot-graph-stack-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runPy(args, { cwd, env = {}, input } = {}) {
  return spawnSync("python3", ["-B", ...args], {
    cwd,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env },
    input,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
}

test("mini-context-graph stores, ontology normalization, RAG chunk provenance, and wiki linter operate offline", (t) => {
  if (runPy(["--version"]).status !== 0) {
    t.skip("python3 is not available");
    return;
  }

  const dir = makeTempDir(t, "mini-context-graph-");
  const dataDir = path.join(dir, "data");
  const wikiDir = path.join(dir, "wiki");
  const scriptsDir = path.join(SKILLS_ROOT, "mini-context-graph", "scripts");

  const driver = `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(scriptsDir)})

from contextgraph import ContextGraphSkill
from tools import documents_store, graph_store, index_store, ontology_store, retrieval_engine, wiki_store

# 1. Ontology normalization and counts
assert ontology_store.normalize_type("Bug") == "issue"
assert ontology_store.normalize_type("Service") == "software"
assert ontology_store.normalize_type("custom_domain") == "custom domain"
assert ontology_store.normalize_relation("Triggers") == "causes"
assert ontology_store.normalize_relation("inherits-from") == "extends"
ontology_store.add_type("bug")
ontology_store.add_type("crash")
ontology_store.add_relation("leads to")
assert ontology_store.get_all_types()["issue"] == 2
assert ontology_store.get_all_relations()["causes"] == 1

# 2. Documents store chunking, idempotency, and keyword search
long_body = (
    "CheckoutService experiences severe memory allocation spikes during batch exports. "
    + ("Background worker pools retain buffers across retries. " * 12)
    + "Ultimately the container crashes with out-of-memory errors."
)
doc1 = documents_store.add_document("doc_001", "Incident Postmortem", "/incidents/001.md", long_body)
assert len(doc1["chunks"]) >= 2
doc1_dup = documents_store.add_document("doc_001", "Changed Title Ignored", "/other", "ignored")
assert doc1_dup["title"] == "Incident Postmortem"
assert documents_store.get_chunk("doc_001_chunk_000") is not None
assert documents_store.search_chunks("the and is") == []
hits = documents_store.search_chunks("memory allocation spikes checkoutservice", top_k=2)
assert len(hits) >= 1 and hits[0]["doc_id"] == "doc_001"
assert len(documents_store.list_documents()) == 1

# 3. ContextGraphSkill orchestration + RAG provenance + confidence/depth filtering
skill = ContextGraphSkill()
try:
    skill.ingest(["raw"])
    raise AssertionError("expected NotImplementedError")
except NotImplementedError:
    pass

summary = skill.ingest_with_content(
    doc_id="doc_002",
    title="Payment Retry Analysis",
    source="/incidents/002.md",
    raw_content="RetryQueue triggers DatabasePool exhaustion when downstream latency exceeds 5s.",
    entities=[
        {"name": "RetryQueue", "type": "module", "supporting_text": "RetryQueue triggers"},
        {"name": "DatabasePool", "type": "database", "supporting_text": "DatabasePool exhaustion"},
        {"name": "MinorWarning", "type": "event", "supporting_text": "downstream latency"},
    ],
    relations=[
        {
            "source": "RetryQueue",
            "target": "DatabasePool",
            "type": "triggers",
            "confidence": 0.85,
            "supporting_text": "RetryQueue triggers DatabasePool exhaustion",
        },
        {
            "source": "DatabasePool",
            "target": "MinorWarning",
            "type": "leads to",
            "confidence": 0.4,  # below MIN_CONFIDENCE (0.6) -> skipped
        },
    ],
)
assert summary == {"doc_id": "doc_002", "chunk_count": 1, "nodes_added": 3, "edges_added": 1}

# Duplicate edge with higher confidence updates stored confidence
rq_id = graph_store.find_node_by_name("retryqueue")
db_id = graph_store.find_node_by_name("databasepool")
graph_store.add_edge(rq_id, db_id, "causes", 0.95)
evidence = skill.query_with_evidence("RetryQueue")
assert len(evidence["subgraph"]["edges"]) == 1
assert evidence["subgraph"]["edges"][0]["confidence"] == 0.95
assert "retryqueue --[causes]--> databasepool" in evidence["evidence_chain"]
assert evidence["supporting_documents"][0]["doc_id"] == "doc_002"
assert skill.query_with_evidence("nonexistent_xyz")["supporting_documents"] == []

# BFS max_nodes cap
capped = retrieval_engine.retrieve([rq_id], depth=2, min_confidence=0.6, max_nodes=1)
assert capped == [rq_id]

# 4. Wiki store: empty heading-only summary + pipe sanitization + lint_wiki
rel1 = wiki_store.write_page("entity", "Heading Only", "# Heading Only\\n")
assert rel1 == "entities/heading-only.md"
rel2 = wiki_store.write_page(
    "topic",
    "Retry Cascade",
    "# Retry Cascade\\nFirst line with | pipe and [[heading-only]] plus [[ghost-page]].\\n",
)
pages = wiki_store.list_pages()
by_slug = {p["slug"]: p for p in pages}
# Regression check: empty summary on heading-only must NOT shift date into summary
assert by_slug["heading-only"]["summary"] == ""
assert len(by_slug["heading-only"]["date"]) == 10
assert "|" not in by_slug["retry-cascade"]["summary"]

assert wiki_store.read_page("entity", "Heading Only") == "# Heading Only\\n"
assert wiki_store.read_page_by_slug("retry-cascade") is not None
assert len(wiki_store.search_wiki("cascade")) == 1
assert len(wiki_store.get_log()) == 2

# Create an unindexed orphan page and delete heading-only file to trigger missing + orphan + broken + isolated checks
(wiki_store._WIKI_DIR / "summaries" / "orphan-note.md").write_text("Standalone orphan without links\\n")
(wiki_store._WIKI_DIR / "entities" / "heading-only.md").unlink()
lint = wiki_store.lint_wiki()
assert "orphan-note" in lint["orphan_pages"]
assert "heading-only" in lint["missing_pages"]
assert "orphan-note" in lint["isolated_pages"]
assert set(lint["broken_wikilinks"]["retry-cascade"]) == {"heading-only", "ghost-page"}
print("OK")
`;

  const res = runPy(["-c", driver], {
    cwd: dir,
    env: {
      MINI_CONTEXT_GRAPH_DATA_DIR: dataDir,
      MINI_CONTEXT_GRAPH_WIKI_DIR: wikiDir,
    },
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stdout.trim(), "OK");
});

test("agent-skill-stack inventory, index search, routing profile, SVG card renderer, and staged installer enforce safety contracts offline", (t) => {
  if (runPy(["--version"]).status !== 0) {
    t.skip("python3 is not available");
    return;
  }

  const dir = makeTempDir(t, "agent-skill-stack-");
  const stackScripts = path.join(SKILLS_ROOT, "agent-skill-stack", "scripts");
  const inventoryPy = path.join(stackScripts, "inventory_skills.py");
  const indexPy = path.join(stackScripts, "skill_index.py");
  const profilePy = path.join(stackScripts, "project_profile.py");
  const cardPy = path.join(stackScripts, "render_stack_card.py");
  const stagePy = path.join(stackScripts, "stage_install.py");

  const projectRoot = path.join(dir, "project");
  const projectSkills = path.join(projectRoot, "skills");
  const globalSkills = path.join(dir, "global-skills");
  fs.mkdirSync(path.join(projectSkills, "doc-citation-checker"), { recursive: true });
  fs.mkdirSync(path.join(globalSkills, "doc-citation-checker"), { recursive: true });
  fs.mkdirSync(path.join(globalSkills, "mismatch-folder"), { recursive: true });

  fs.writeFileSync(
    path.join(projectSkills, "doc-citation-checker", "SKILL.md"),
    [
      "---",
      "name: doc-citation-checker",
      "description: >",
      "  Verify factual citations, grounded references, and evidence accuracy",
      "  across markdown reports.",
      "---",
      "# Citation Verification",
      "## Audit Steps",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(globalSkills, "doc-citation-checker", "SKILL.md"),
    [
      "---",
      "name: doc-citation-checker",
      "description: |",
      "  Verify factual citations, grounded references, and evidence accuracy.",
      "---",
      "# Global Duplicate",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(globalSkills, "mismatch-folder", "SKILL.md"),
    [
      "---",
      "name: cleanup-helper",
      'description: "Clean temporary build artifacts safely."',
      "---",
      "Avoid running chmod 777 /tmp/cache in scripts.",
    ].join("\n"),
    "utf8",
  );

  // 1. inventory_skills.py JSON + Markdown + summary-only
  const invJsonRun = runPy([
    inventoryPy,
    "--root",
    projectSkills,
    "--root",
    globalSkills,
    "--root",
    path.join(dir, "missing-root"),
    "--overlap-threshold",
    "0.2",
  ]);
  assert.equal(invJsonRun.status, 0, invJsonRun.stderr);
  const invReport = JSON.parse(invJsonRun.stdout);
  assert.equal(invReport.summary.skills_found, 3);
  assert.equal(invReport.summary.duplicate_names, 1);
  assert.equal(invReport.summary.skills_with_risk_indicators, 1);
  assert.equal(invReport.missing_roots.length, 1);
  assert.ok(invReport.overlaps.length >= 1);

  const invMdRun = runPy([
    inventoryPy,
    "--root",
    projectSkills,
    "--format",
    "markdown",
    "--summary-only",
  ]);
  assert.equal(invMdRun.status, 0, invMdRun.stderr);
  assert.match(invMdRun.stdout, /# Skill inventory/);

  // 2. skill_index.py build + search (JSON & simple)
  const indexFile = path.join(dir, "skill-index.json");
  const buildRun = runPy([
    indexPy,
    "build",
    "--root",
    projectSkills,
    "--root",
    globalSkills,
    "--project-root",
    projectRoot,
    "--output",
    indexFile,
  ]);
  assert.equal(buildRun.status, 0, buildRun.stderr);
  assert.equal(JSON.parse(buildRun.stdout).skills_indexed, 3);

  const searchRun = runPy([
    indexPy,
    "search",
    "--index",
    indexFile,
    "--query",
    "fact check citation",
  ]);
  assert.equal(searchRun.status, 0, searchRun.stderr);
  const searchPayload = JSON.parse(searchRun.stdout);
  assert.ok(searchPayload.results.length >= 2);
  // Project-scoped skill outranks identical global skill via +1 project scope bonus
  assert.equal(searchPayload.results[0].scope, "project");
  assert.equal(searchPayload.results[0].name, "doc-citation-checker");

  const simpleSearch = runPy([
    indexPy,
    "search",
    "--index",
    indexFile,
    "--query",
    "cleanup-helper",
    "--format",
    "simple",
  ]);
  assert.equal(simpleSearch.status, 0, simpleSearch.stderr);
  assert.match(simpleSearch.stdout, /1\. Cleanup Helper/);

  // 3. project_profile.py preview, apply, overwrite guard, and update
  const previewProfile = runPy([
    profilePy,
    "--project",
    projectRoot,
    "--name",
    "Docs Stack",
    "--skill",
    "doc-citation-checker",
    "--skill",
    "cleanup-helper",
    "--route",
    "verify=doc-citation-checker,cleanup-helper",
  ]);
  assert.equal(previewProfile.status, 0, previewProfile.stderr);
  const profilePath = path.join(projectRoot, ".codex", "skill-stack.json");
  assert.equal(fs.existsSync(profilePath), false);

  assert.notEqual(
    runPy([
      profilePy,
      "--project",
      projectRoot,
      "--name",
      "Docs Stack",
      "--skill",
      "doc-citation-checker",
      "--update",
    ]).status,
    0,
  );
  assert.notEqual(
    runPy([
      profilePy,
      "--project",
      projectRoot,
      "--name",
      "Docs Stack",
      "--skill",
      "doc-citation-checker",
      "--route",
      "verify=unlisted-skill",
    ]).status,
    0,
  );

  const applyProfile = runPy([
    profilePy,
    "--project",
    projectRoot,
    "--name",
    "Docs Stack",
    "--skill",
    "doc-citation-checker",
    "--apply",
  ]);
  assert.equal(applyProfile.status, 0, applyProfile.stderr);
  assert.equal(fs.existsSync(profilePath), true);

  // Refuses overwrite without --update; succeeds with --apply --update --strict
  assert.notEqual(
    runPy([
      profilePy,
      "--project",
      projectRoot,
      "--name",
      "Docs Stack",
      "--skill",
      "doc-citation-checker",
      "--apply",
    ]).status,
    0,
  );
  const updatedProfile = runPy([
    profilePy,
    "--project",
    projectRoot,
    "--name",
    "Strict Stack",
    "--skill",
    "doc-citation-checker",
    "--strict",
    "--apply",
    "--update",
  ]);
  assert.equal(updatedProfile.status, 0, updatedProfile.stderr);
  assert.equal(JSON.parse(fs.readFileSync(profilePath, "utf8")).routing.outside_search, "never");

  // 4. render_stack_card.py validation, HTML escaping, and --force guard
  const cardInput = path.join(dir, "card.json");
  const cardSvg = path.join(dir, "stack-card.svg");
  fs.writeFileSync(
    cardInput,
    JSON.stringify({
      title: 'Docs & <Safety> "Stack"',
      goal: "Audit citations & verify clean builds.",
      skills: [
        { name: "doc-citation-checker", role: "Check <links> & quotes", status: "verified" },
      ],
      boundaries: ["Never overwrite user files without confirmation."],
    }),
    "utf8",
  );
  assert.notEqual(
    runPy([cardPy, "--input", cardInput, "--output", path.join(dir, "bad.png")]).status,
    0,
  );
  const cardCreated = runPy([cardPy, "--input", cardInput, "--output", cardSvg]);
  assert.equal(cardCreated.status, 0, cardCreated.stderr);
  const svgContent = fs.readFileSync(cardSvg, "utf8");
  assert.match(svgContent, /Docs &amp; &lt;Safety&gt; &quot;Stack&quot;/);
  assert.equal(svgContent.includes("<Safety>"), false);
  assert.notEqual(runPy([cardPy, "--input", cardInput, "--output", cardSvg]).status, 0);
  assert.equal(runPy([cardPy, "--input", cardInput, "--output", cardSvg, "--force"]).status, 0);

  // 5. stage_install.py dry-run, apply, overwrite refusal, record-existing, and symlink rejection
  const installDest = path.join(dir, "installed-skills");
  const manifestPath = path.join(dir, "manifest.json");
  const cleanSource = path.join(projectSkills, "doc-citation-checker");

  const plannedRun = runPy([
    stagePy,
    "--source",
    cleanSource,
    "--dest",
    installDest,
    "--manifest",
    manifestPath,
  ]);
  assert.equal(plannedRun.status, 0, plannedRun.stderr);
  assert.equal(JSON.parse(plannedRun.stdout).status, "planned");
  assert.equal(fs.existsSync(path.join(installDest, "doc-citation-checker")), false);

  const installedRun = runPy([
    stagePy,
    "--source",
    cleanSource,
    "--dest",
    installDest,
    "--manifest",
    manifestPath,
    "--apply",
  ]);
  assert.equal(installedRun.status, 0, installedRun.stderr);
  assert.equal(JSON.parse(installedRun.stdout).status, "installed");
  assert.equal(fs.existsSync(path.join(installDest, "doc-citation-checker", "SKILL.md")), true);

  // Refuses overwriting existing destination; --record-existing works when source === target
  assert.notEqual(
    runPy([
      stagePy,
      "--source",
      cleanSource,
      "--dest",
      installDest,
      "--manifest",
      manifestPath,
      "--apply",
    ]).status,
    0,
  );
  const recordRun = runPy([
    stagePy,
    "--source",
    path.join(installDest, "doc-citation-checker"),
    "--dest",
    installDest,
    "--manifest",
    manifestPath,
    "--record-existing",
  ]);
  assert.equal(recordRun.status, 0, recordRun.stderr);
  assert.equal(JSON.parse(recordRun.stdout).status, "recorded");

  // Rejects symlinked files inside skill directory
  const symlinkSkill = path.join(dir, "symlink-skill");
  fs.mkdirSync(symlinkSkill, { recursive: true });
  fs.writeFileSync(
    path.join(symlinkSkill, "SKILL.md"),
    "---\nname: symlink-skill\ndescription: demo\n---\n",
    "utf8",
  );
  fs.symlinkSync(cardInput, path.join(symlinkSkill, "leak.json"));
  assert.notEqual(
    runPy([
      stagePy,
      "--source",
      symlinkSkill,
      "--dest",
      path.join(dir, "dest2"),
      "--manifest",
      manifestPath,
    ]).status,
    0,
  );
});
