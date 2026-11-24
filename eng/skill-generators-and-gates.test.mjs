import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ROOT_FOLDER } from "./constants.mjs";

const SUBPROCESS_TIMEOUT_MS = 10_000;
const SKILLS_ROOT = path.join(ROOT_FOLDER, "skills");

function makeTempDir(t, prefix = "awesome-copilot-skill-gen-") {
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

test("quality-playbook quality_gate validates REQ patterns, cardinality reconciliation, ISO dates, and workspace artifact resolution offline", (t) => {
  if (runPy(["--version"]).status !== 0) {
    t.skip("python3 is not available");
    return;
  }

  const dir = makeTempDir(t, "qpb-gate-");
  const qpbDir = path.join(SKILLS_ROOT, "quality-playbook");

  const driver = `
import json, pathlib, sys
sys.path.insert(0, ${JSON.stringify(qpbDir)})
import quality_gate as qg

base = pathlib.Path(${JSON.stringify(dir)})

# 1. extract_req_pattern + per-site UC detection
assert qg.extract_req_pattern("### REQ-1: Demo\\n- Pattern: parity\\n") == "parity"
assert qg.extract_req_pattern("### REQ-2: Plain\\nNo pattern line\\n") is None
try:
    qg.extract_req_pattern("### REQ-3: Bad\\n- Pattern: unknown_mode\\n")
    raise AssertionError("expected ValueError")
except ValueError:
    pass

req_doc = (
    "### REQ-10: Cross-site parity\\n- Pattern: whitelist\\nCovers UC-10.a, UC-10.b, UC-10.a and ignores UC-10 or UC-10.a.bad.\\n"
    "### REQ-11: Plain req\\nCovers UC-11.\\n"
)
assert qg._enumerate_pattern_tagged_reqs(req_doc) == {"REQ-10": "whitelist"}
assert qg._enumerate_per_site_uc_reqs(req_doc) == {"REQ-10": ["UC-10.a", "UC-10.b"]}

# 2. validate_cardinality_gate: passing repo with covered + downgraded + present:true cells
ok_repo = base / "ok_repo"
ok_q = ok_repo / "quality"
ok_q.mkdir(parents=True)
(ok_q / "REQUIREMENTS.md").write_text(req_doc, encoding="utf-8")
(ok_q / "compensation_grid.json").write_text(json.dumps({
    "reqs": {
        "REQ-10": {
            "pattern": "whitelist",
            "cells": [
                {"cell_id": "REQ-10/cell-auth-api", "present": True, "evidence": "src/api.py:14-22"},
                {"cell_id": "REQ-10/cell-auth-cli", "present": False},
                {"cell_id": "REQ-10/cell-auth-batch", "present": False},
                {"cell_id": "REQ-10/cell-auth-legacy", "present": False},
            ],
        }
    }
}), encoding="utf-8")
(ok_q / "BUGS.md").write_text(
    "### BUG-001: Missing auth guard in CLI and batch\\n"
    "- Primary requirement: REQ-10\\n"
    "- Covers: [REQ-10/cell-auth-cli, REQ-10/cell-auth-batch]\\n"
    "- Consolidation rationale: Shared entrypoint middleware fixes both surfaces.\\n",
    encoding="utf-8",
)
(ok_q / "compensation_grid_downgrades.json").write_text(json.dumps({
    "downgrades": [
        {
            "cell_id": "REQ-10/cell-auth-legacy",
            "authority_ref": "SPEC.md#legacy",
            "site_citation": "src/legacy.py:1",
            "reason_class": "deprecated",
            "falsifiable_claim": "Legacy v1 endpoint is disabled at router startup.",
        }
    ]
}), encoding="utf-8")
assert qg.validate_cardinality_gate(ok_repo) == []

# 3. validate_cardinality_gate: detects missing Pattern on per-site UC, missing rationale, bad cell_id, non-bool present, bad evidence, bad downgrade, uncovered & stray cells
bad_repo = base / "bad_repo"
bad_q = bad_repo / "quality"
bad_q.mkdir(parents=True)
(bad_q / "REQUIREMENTS.md").write_text(
    "### REQ-1: Missing pattern\\nCites UC-1.a.\\n"
    "### REQ-2: Tagged but omitted from grid\\n- Pattern: parity\\n"
    "### REQ-3: Grid errors\\n- Pattern: compensation\\n",
    encoding="utf-8",
)
(bad_q / "compensation_grid.json").write_text(json.dumps({
    "reqs": {
        "REQ-3": {
            "pattern": "compensation",
            "cells": [
                {"cell_id": "REQ-3/cell-a-s1", "present": "true"},
                {"cell_id": "REQ-3/cell-b-s1", "present": True, "evidence": "/abs/path.py:10"},
                {"cell_id": "REQ-3/cell-c-s1", "present": True, "evidence": "rel.py:0"},
                {"cell_id": "REQ-3/cell-d-s1", "present": False},
            ],
        }
    }
}), encoding="utf-8")
(bad_q / "BUGS.md").write_text(
    "### BUG-002: Missing rationale and stray cover\\n"
    "- Covers: [REQ-3/cell-stray-s1, bad_id]\\n",
    encoding="utf-8",
)
(bad_q / "compensation_grid_downgrades.json").write_text(json.dumps({
    "downgrades": [
        {
            "cell_id": "REQ-3/cell-d-s1",
            "authority_ref": "SPEC",
            "site_citation": "src/x.py:2",
            "reason_class": "made-up-reason",
            "falsifiable_claim": "Invalid reason class must not count as covered.",
        }
    ]
}), encoding="utf-8")
failures = qg.validate_cardinality_gate(bad_repo)
joined = "\\n".join(failures)
for expected in [
    "REQ-1 has per-site UCs (UC-1.a)",
    "REQ-2 is pattern-tagged 'parity'",
    "Consolidation rationale:' is missing",
    "malformed cell ID 'bad_id'",
    "'present' must be boolean true or false",
    "got '/abs/path.py:10'",
    "got 'rel.py:0'",
    "reason_class 'made-up-reason'",
    "REQ-3: uncovered cells — REQ-3/cell-d-s1",
    "Covers/downgrade cells not in grid — REQ-3/cell-stray-s1",
]:
    assert expected in joined, f"missing {expected!r} in:\\n{joined}"

# 4. Date validation, language detection, source counts, and workspace fallback
assert qg.validate_iso_date("") == "empty"
assert qg.validate_iso_date("YYYY-MM-DD") == "placeholder"
assert qg.validate_iso_date("0000-00-00") == "placeholder"
assert qg.validate_iso_date("2026/03/15") == "bad_format"
assert qg.validate_iso_date("2099-01-01") == "future"
assert qg.validate_iso_date("2025-03-15T12:30:00Z") == "valid"

ws_results = ok_q / "workspace" / "results"
ws_results.mkdir(parents=True)
assert qg._resolve_artifact_path(ok_q, "results") == ws_results
top_results = ok_q / "results"
top_results.mkdir()
assert qg._resolve_artifact_path(ok_q, "results") == top_results

(ok_repo / "src").mkdir()
(ok_repo / "src" / "service.rs").write_text("pub fn main() {}\\n", encoding="utf-8")
(ok_repo / "node_modules").mkdir()
(ok_repo / "node_modules" / "ignored.go").write_text("package main\\n", encoding="utf-8")
assert qg.detect_project_language(ok_repo) == "rs"
assert qg.count_source_files(ok_repo) == 1
print("OK")
`;

  const res = runPy(["-c", driver], { cwd: dir });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stdout.trim(), "OK");
});

test("python-pypi-package-builder scaffold generates valid TOML and module-scoped tests for flat/setuptools and src/hatchling layouts", (t) => {
  if (runPy(["--version"]).status !== 0) {
    t.skip("python3 is not available");
    return;
  }

  const dir = makeTempDir(t, "pypi-scaffold-");
  const scaffoldPy = path.join(SKILLS_ROOT, "python-pypi-package-builder", "scripts", "scaffold.py");

  // Invalid package name exits 1
  assert.equal(runPy([scaffoldPy, "--name", "Invalid_Upper", "--output", dir]).status, 1);

  // 1. Default flat + setuptools scaffold must produce valid TOML and use custom module name in tests
  const flatRun = runPy([
    scaffoldPy,
    "--name",
    "acme-widget",
    "--layout",
    "flat",
    "--build",
    "setuptools",
    "--author",
    "Ada Lovelace",
    "--output",
    dir,
  ]);
  assert.equal(flatRun.status, 0, flatRun.stderr);

  // Refuses overwriting existing package directory
  assert.equal(
    runPy([scaffoldPy, "--name", "acme-widget", "--output", dir]).status,
    1,
  );

  // 2. src + hatchling scaffold
  const srcRun = runPy([
    scaffoldPy,
    "--name",
    "acme-src-lib",
    "--layout",
    "src",
    "--build",
    "hatchling",
    "--output",
    dir,
  ]);
  assert.equal(srcRun.status, 0, srcRun.stderr);

  const verifyTomlAndImports = runPy([
    "-c",
    `
import pathlib, sys
try:
    import tomllib
except ImportError:
    tomllib = None

root = pathlib.Path(${JSON.stringify(dir)})
flat_toml = (root / "acme-widget" / "pyproject.toml").read_text(encoding="utf-8")
src_toml = (root / "acme-src-lib" / "pyproject.toml").read_text(encoding="utf-8")

if tomllib is not None:
    parsed_flat = tomllib.loads(flat_toml)
    parsed_src = tomllib.loads(src_toml)
    assert parsed_flat["project"]["name"] == "acme-widget"
    assert parsed_flat["build-system"]["build-backend"] == "setuptools.build_meta"
    assert parsed_src["project"]["name"] == "acme-src-lib"
    assert parsed_src["build-system"]["build-backend"] == "hatchling.build"

assert (root / "acme-widget" / "acme_widget" / "py.typed").is_file()
assert (root / "acme-src-lib" / "src" / "acme_src_lib" / "py.typed").is_file()

backends_test = (root / "acme-widget" / "tests" / "test_backends.py").read_text(encoding="utf-8")
assert "from acme_widget.backends.memory import MemoryBackend" in backends_test
assert "your_package" not in backends_test
print("OK")
`,
  ]);
  assert.equal(verifyTomlAndImports.status, 0, verifyTomlAndImports.stdout + verifyTomlAndImports.stderr);
  assert.equal(verifyTomlAndImports.stdout.trim(), "OK");
});

test("drawio add-shape, excalidraw add-arrow/split-library, code-tour generate_from_docs, and codebase scan.py work offline", (t) => {
  if (runPy(["--version"]).status !== 0) {
    t.skip("python3 is not available");
    return;
  }

  const dir = makeTempDir(t, "diagram-scan-tools-");

  // 1. draw-io-diagram-generator add-shape.py + validate-drawio.py round-trip
  const addShapePy = path.join(SKILLS_ROOT, "draw-io-diagram-generator", "scripts", "add-shape.py");
  const validateDrawioPy = path.join(
    SKILLS_ROOT,
    "draw-io-diagram-generator",
    "scripts",
    "validate-drawio.py",
  );
  const drawioPath = path.join(dir, "arch.drawio");
  const initialDrawio = `<mxfile>
  <diagram name="Page-1">
    <mxGraphModel>
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="title" value="System Overview" style="text;html=1;fontSize=18;" vertex="1" parent="1">
          <mxGeometry x="20" y="10" width="200" height="30" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
  fs.writeFileSync(drawioPath, initialDrawio, "utf8");

  // --dry-run leaves file untouched; negative and out-of-range diagram-index fail with exit 1
  const dryShape = runPy([addShapePy, drawioPath, "Worker", "100", "120", "--dry-run"]);
  assert.equal(dryShape.status, 0, dryShape.stdout);
  assert.equal(fs.readFileSync(drawioPath, "utf8"), initialDrawio);

  assert.equal(runPy([addShapePy, drawioPath, "BadNeg", "10", "10", "--diagram-index", "-1"]).status, 1);
  assert.equal(runPy([addShapePy, drawioPath, "BadHigh", "10", "10", "--diagram-index", "3"]).status, 1);

  const addedShape = runPy([
    addShapePy,
    drawioPath,
    "Queue Service",
    "140",
    "90",
    "--width",
    "160",
    "--height",
    "70",
  ]);
  assert.equal(addedShape.status, 0, addedShape.stdout);
  assert.equal(runPy([validateDrawioPy, drawioPath]).status, 0);

  // 2. excalidraw-diagram-generator add-arrow.py & split-excalidraw-library.py
  const addArrowPy = path.join(SKILLS_ROOT, "excalidraw-diagram-generator", "scripts", "add-arrow.py");
  const splitLibPy = path.join(
    SKILLS_ROOT,
    "excalidraw-diagram-generator",
    "scripts",
    "split-excalidraw-library.py",
  );
  const excalidrawPath = path.join(dir, "flow.excalidraw");
  fs.writeFileSync(excalidrawPath, JSON.stringify({ type: "excalidraw", elements: [] }), "utf8");

  assert.equal(
    runPy([addArrowPy, excalidrawPath, "10", "20", "110", "120", "--style", "wavy"]).status,
    1,
  );
  const okArrow = runPy([
    addArrowPy,
    excalidrawPath,
    "10",
    "20",
    "110",
    "120",
    "--style",
    "dashed",
    "--label",
    "gRPC",
  ]);
  assert.equal(okArrow.status, 0, okArrow.stdout + okArrow.stderr);
  assert.equal(fs.existsSync(`${excalidrawPath}.edit`), false);
  const updatedDiagram = JSON.parse(fs.readFileSync(excalidrawPath, "utf8"));
  assert.equal(updatedDiagram.elements.length, 2);
  assert.equal(updatedDiagram.elements[0].strokeStyle, "dashed");
  assert.equal(updatedDiagram.elements[1].text, "gRPC");

  // Refuses when stale .edit lock file already exists
  fs.writeFileSync(`${excalidrawPath}.edit`, "{}", "utf8");
  assert.equal(runPy([addArrowPy, excalidrawPath, "0", "0", "50", "50"]).status, 1);

  const libDir = path.join(dir, "cloud-icons");
  fs.mkdirSync(libDir, { recursive: true });
  assert.equal(runPy([splitLibPy, libDir]).status, 1); // 0 .excalidrawlib files
  fs.writeFileSync(
    path.join(libDir, "cloud-icons.excalidrawlib"),
    JSON.stringify({
      type: "excalidrawlib",
      libraryItems: [
        { name: "API   Gateway / Edge!", elements: [{ id: "1" }] },
        { name: "Worker Pool", elements: [{ id: "2" }] },
      ],
    }),
    "utf8",
  );
  const splitRun = runPy([splitLibPy, libDir]);
  assert.equal(splitRun.status, 0, splitRun.stdout + splitRun.stderr);
  assert.equal(fs.existsSync(path.join(libDir, "icons", "API-Gateway-Edge.json")), true);
  assert.match(fs.readFileSync(path.join(libDir, "reference.md"), "utf8"), /icons\/Worker-Pool\.json/);

  // 3. code-tour generate_from_docs.py + 4. acquire-codebase-knowledge scan.py
  const genTourPy = path.join(SKILLS_ROOT, "code-tour", "scripts", "generate_from_docs.py");
  const scanPy = path.join(SKILLS_ROOT, "acquire-codebase-knowledge", "scripts", "scan.py");
  const sampleRepo = path.join(dir, "sample-repo");
  fs.mkdirSync(path.join(sampleRepo, "src"), { recursive: true });
  fs.mkdirSync(path.join(sampleRepo, "packages", "core"), { recursive: true });
  fs.mkdirSync(path.join(sampleRepo, "tests"), { recursive: true });
  fs.mkdirSync(path.join(sampleRepo, ".github", "workflows"), { recursive: true });

  fs.writeFileSync(
    path.join(sampleRepo, "package.json"),
    JSON.stringify({ name: "sample-monorepo", workspaces: ["packages/*"] }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(sampleRepo, "src", "index.ts"),
    "// TODO: wire telemetry exporter\nexport const ready = true;\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(sampleRepo, "tests", "index.test.ts"),
    "// TODO: test-only comment excluded from production scan\n",
    "utf8",
  );
  fs.writeFileSync(path.join(sampleRepo, ".eslintrc.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(sampleRepo, ".env.example"), "LOG_LEVEL=info\n", "utf8");
  fs.writeFileSync(path.join(sampleRepo, "Dockerfile"), "FROM node:22-alpine\n", "utf8");
  fs.writeFileSync(path.join(sampleRepo, ".github", "workflows", "ci.yml"), "name: CI\n", "utf8");
  fs.writeFileSync(path.join(sampleRepo, "SECURITY.md"), "# Security Policy\n", "utf8");
  fs.writeFileSync(
    path.join(sampleRepo, "README.md"),
    [
      "# Sample Repo",
      "",
      "## Architecture Overview",
      "",
      "Core entrypoint lives in `src/index.ts` alongside `packages`.",
      "Read the [Architecture ADR](https://example.com/adr/001), [here](https://example.com/skip), and ![diagram](https://example.com/arch.png).",
    ].join("\n"),
    "utf8",
  );

  const tourOut = path.join(dir, "generated.tour");
  const tourRun = runPy([
    genTourPy,
    "--repo-root",
    sampleRepo,
    "--persona",
    "contributor",
    "--output",
    tourOut,
  ]);
  assert.equal(tourRun.status, 0, tourRun.stdout + tourRun.stderr);
  const skeleton = JSON.parse(fs.readFileSync(tourOut, "utf8"));
  assert.ok(skeleton.steps.some((s) => s.file === "src/index.ts"));
  assert.ok(skeleton.steps.some((s) => s.directory === "packages"));
  assert.ok(skeleton.steps.some((s) => s.uri === "https://example.com/adr/001"));
  assert.equal(skeleton.steps.some((s) => s.uri?.includes("arch.png")), false);
  assert.equal(skeleton.steps.some((s) => s.title === "here"), false);

  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "Test Bot"],
    ["config", "user.email", "bot@example.com"],
    ["config", "commit.gpgSign", "false"],
    ["add", "."],
    ["commit", "-m", "initial commit", "--quiet"],
  ]) {
    assert.equal(spawnSync("git", args, { cwd: sampleRepo, encoding: "utf8" }).status, 0);
  }

  const scanOut = path.join(dir, "scan-report.txt");
  const scanRun = runPy([scanPy, "--output", scanOut], { cwd: sampleRepo });
  assert.equal(scanRun.status, 0, scanRun.stderr);
  const scanText = fs.readFileSync(scanOut, "utf8");
  assert.match(scanText, /Found: src\/index\.ts/);
  assert.match(scanText, /Found: \.eslintrc\.json/);
  assert.match(scanText, /--- \.env\.example ---/);
  assert.match(scanText, /src\/index\.ts:1: \/\/ TODO: wire telemetry exporter/);
  assert.equal(scanText.includes("test-only comment excluded"), false);
  assert.match(scanText, /package\.json has 'workspaces' field/);
  assert.match(scanText, /CI\/CD: GitHub Actions/);
  assert.match(scanText, /Container: Docker found/);
  assert.match(scanText, /Security: SECURITY\.md/);
  assert.match(scanText, /=== SCAN COMPLETE ===/);
});
