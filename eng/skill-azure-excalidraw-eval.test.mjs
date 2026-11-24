import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ROOT_FOLDER } from "./constants.mjs";

const SUBPROCESS_TIMEOUT_MS = 10_000;
const SKILLS_ROOT = path.join(ROOT_FOLDER, "skills");

function makeTempDir(t, prefix = "awesome-copilot-az-excal-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const PYTHON_EXECUTABLE = (() => {
  const probe = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  return probe.status === 0 && probe.stdout.trim() ? probe.stdout.trim() : "python3";
})();

function runPy(args, { cwd, env = {}, input } = {}) {
  return spawnSync(PYTHON_EXECUTABLE, ["-B", "-E", ...args], {
    cwd,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env },
    input,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
}

test("azure-architecture-autopilot icons, generator aliases, and CLI normalization/fallback work offline", (t) => {
  if (runPy(["--version"]).status !== 0) {
    t.skip("python3 is not available");
    return;
  }

  const dir = makeTempDir(t, "az-arch-autopilot-");
  const scriptsDir = path.join(SKILLS_ROOT, "azure-architecture-autopilot", "scripts");
  const cliPy = path.join(scriptsDir, "cli.py");

  // 1. Unit-test icons.py, generator.py, and cli.py helpers directly in Python
  const pyDriver = `
import base64, io, json, pathlib, sys
from contextlib import redirect_stderr
sys.path.insert(0, ${JSON.stringify(scriptsDir)})

import icons
import generator
import cli

# icons.py: normalization, base64 SVG decode, unknown fallback, and search
uri = icons.get_icon_data_uri("AI-Studio")
assert uri.startswith("data:image/svg+xml;base64,")
raw_svg = base64.b64decode(uri.split(",", 1)[1]).decode("utf-8")
assert "<svg" in raw_svg
assert icons.get_icon_data_uri("nonexistent_service_xyz") == ""
matches = icons.search_icons("microsoft-fabric")
assert any(k == "microsoft_fabric" and name == "Microsoft-Fabric" for k, name, _cat in matches)

# generator.py: ARM resource alias resolution + fallback + HTML rendering
pe_info = generator.get_service_info("Private-Endpoints")
assert pe_info["category"] == "Network"
search_info = generator.get_service_info("cognitive_search")
assert search_info["category"] == "AI"
assert search_info["icon_data_uri"].startswith("data:image/svg+xml;base64,")
fallback_info = generator.get_service_info("custom_unmapped_resource")
assert fallback_info["category"] == "Azure"

# cli.py: _normalize_services + _normalize_connections + _load_json combined file extraction
stderr_buf = io.StringIO()
with redirect_stderr(stderr_buf):
    norm_svcs = cli._normalize_services([
        {"id": "web", "name": "Web App", "type": "web-apps", "details": "HTTPS 443", "private": "yes"},
        {"id": "pe1", "name": "Web PE", "type": "private_endpoint", "private": "0"},
        {"id": "kv", "name": "Vault", "type": "key_vaults", "private": "invalid_bool"},
    ])
assert norm_svcs[0]["details"] == ["HTTPS 443"]
assert norm_svcs[0]["private"] is True
assert norm_svcs[1]["private"] is False
assert norm_svcs[2]["private"] is False
assert "Invalid boolean value 'invalid_bool'" in stderr_buf.getvalue()

norm_conns = cli._normalize_connections([
    {"from": "web", "to": "kv"},
    {"from": "web", "to": "pe1", "type": "private", "label": "443"},
])
assert norm_conns[0]["type"] == "default"
assert norm_conns[1]["type"] == "private"

html = generator.generate_diagram(
    services=norm_svcs,
    connections=norm_conns,
    title="Hub & Spoke Prod",
    vnet_info="vnet-prod 10.10.0.0/16 | snet-app 10.10.1.0/24",
    hierarchy=[{"subscription": "sub-prod", "resourceGroups": ["rg-core"]}],
)
assert "<title>Hub & Spoke Prod</title>" in html
assert "<b>2</b> Services" in html
assert "<b>1</b> Private Endpoints" in html
assert "<b>2</b> Connections" in html
assert "10.10.0.0/16" in html
assert "sub-prod" in html
print("OK")
`;
  const unitResult = runPy(["-c", pyDriver], { cwd: dir });
  assert.equal(unitResult.status, 0, unitResult.stdout + unitResult.stderr);
  assert.equal(unitResult.stdout.trim(), "OK");

  // 2. CLI argument validation + combined JSON file + PNG fallback without puppeteer
  assert.notEqual(runPy([cliPy], { cwd: dir }).status, 0);
  const badJsonRun = runPy([cliPy, "-s", "{broken", "-c", "[]"], { cwd: dir });
  assert.equal(badJsonRun.status, 1);
  assert.match(badJsonRun.stderr, /Invalid JSON for --services/);

  const combinedPath = path.join(dir, "arch.json");
  fs.writeFileSync(
    combinedPath,
    JSON.stringify({
      services: [
        { id: "aks", name: "AKS Cluster", type: "managed_clusters", private: "true", details: "System pool" },
        { id: "acr", name: "Registry", type: "container_registries", private: "false" },
      ],
      connections: [{ from: "aks", to: "acr", label: "Pull image", type: "security" }],
      hierarchy: [{ subscription: "sub-1", resourceGroups: ["rg-aks"] }],
    }),
    "utf8",
  );

  const outHtml = path.join(dir, "diagram.html");
  const htmlCliRun = runPy(
    [
      cliPy,
      "-s",
      combinedPath,
      "-c",
      combinedPath,
      "--hierarchy",
      combinedPath,
      "-t",
      "Container Platform",
      "-o",
      outHtml,
    ],
    { cwd: dir },
  );
  assert.equal(htmlCliRun.status, 0, htmlCliRun.stderr);
  const savedHtml = fs.readFileSync(outHtml, "utf8");
  assert.match(savedHtml, /Container Platform/);
  assert.match(savedHtml, /"dash": "5,5"/);

  // --format png without puppeteer (PATH emptied so shutil.which("node") is None) falls back cleanly to HTML and cleans up .tmp.html
  const fallbackBase = path.join(dir, "fallback-out.png");
  const fallbackHtml = path.join(dir, "fallback-out.html");
  const pngFallbackRun = runPy(
    [cliPy, "-s", combinedPath, "-c", combinedPath, "-f", "png", "-o", fallbackBase],
    { cwd: dir, env: { PATH: dir } },
  );
  assert.equal(pngFallbackRun.status, 0);
  assert.match(pngFallbackRun.stderr, /WARNING: PNG export failed/);
  assert.equal(fs.existsSync(fallbackHtml), true);
  assert.equal(fs.existsSync(`${fallbackBase}.tmp.html`), false);
});

test("excalidraw add-icon-to-diagram and add-arrow transform elements, validate CLI arguments, and guard .edit files", async (t) => {
  if (runPy(["--version"]).status !== 0) {
    t.skip("python3 is not available");
    return;
  }

  const dir = makeTempDir(t, "excalidraw-add-icon-");
  const scriptsDir = path.join(SKILLS_ROOT, "excalidraw-diagram-generator", "scripts");
  const addIconPy = path.join(scriptsDir, "add-icon-to-diagram.py");
  const addArrowPy = path.join(scriptsDir, "add-arrow.py");

  // 1. Direct Python unit checks for bounding boxes, coordinate/binding transformations, and arrow creation
  const pyCheck = runPy(
    [
      "-c",
      `
import importlib.util, pathlib

if not __debug__:
    raise RuntimeError("expected Python assertions (__debug__) to stay active under -E")

spec = importlib.util.spec_from_file_location("add_icon", ${JSON.stringify(addIconPy)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

arrow_spec = importlib.util.spec_from_file_location("add_arrow", ${JSON.stringify(addArrowPy)})
arrow_mod = importlib.util.module_from_spec(arrow_spec)
arrow_spec.loader.exec_module(arrow_mod)

assert mod.calculate_bounding_box([]) == (0, 0, 0, 0)
assert mod.calculate_bounding_box([
    {"x": 20, "y": 40, "width": 50, "height": 30},
    {"x": 10, "y": 50, "width": 20, "height": 40},
]) == (10, 40, 70, 90)
assert mod.transform_icon_elements([], 100, 200) == []

template_elements = [
    {
        "id": "box-orig",
        "type": "rectangle",
        "x": 50,
        "y": 60,
        "width": 80,
        "height": 40,
        "groupIds": ["grp-orig"],
        "boundElements": [{"id": "arrow-orig", "type": "arrow"}, {"id": "txt-orig", "type": "text"}],
    },
    {
        "id": "txt-orig",
        "type": "text",
        "x": 60,
        "y": 70,
        "width": 60,
        "height": 20,
        "groupIds": ["grp-orig"],
        "containerId": "box-orig",
    },
    {
        "id": "arrow-orig",
        "type": "arrow",
        "x": 90,
        "y": 100,
        "width": 10,
        "height": 20,
        "groupIds": ["grp-orig"],
        "startBinding": {"elementId": "box-orig", "focus": 0, "gap": 1},
        "endBinding": {"elementId": "txt-orig", "focus": 0, "gap": 1},
    },
]

placed = mod.transform_icon_elements(template_elements, 200, 300)
assert (placed[0]["x"], placed[0]["y"]) == (200, 300)
assert (placed[1]["x"], placed[1]["y"]) == (210, 310)
assert placed[0]["id"] != "box-orig"
assert placed[1]["id"] != "txt-orig"
assert placed[2]["id"] != "arrow-orig"
assert placed[0]["groupIds"][0] == placed[1]["groupIds"][0] == placed[2]["groupIds"][0]
assert placed[0]["groupIds"][0] != "grp-orig"
assert placed[1]["containerId"] == placed[0]["id"]
assert placed[2]["startBinding"]["elementId"] == placed[0]["id"]
assert placed[2]["endBinding"]["elementId"] == placed[1]["id"]
assert [b["id"] for b in placed[0]["boundElements"]] == [placed[2]["id"], placed[1]["id"]]

arrow_elems = arrow_mod.create_arrow(100, 150, 300, 250, style="dashed", color="#7950f2", label="HTTPS")
assert len(arrow_elems) == 2
assert arrow_elems[0]["type"] == "arrow"
assert arrow_elems[0]["width"] == 200 and arrow_elems[0]["height"] == 100
assert arrow_elems[0]["strokeStyle"] == "dashed" and arrow_elems[0]["strokeColor"] == "#7950f2"
assert arrow_elems[1]["type"] == "text" and arrow_elems[1]["text"] == "HTTPS"
print("OK")
`,
    ],
    { env: { PYTHONOPTIMIZE: "1" } },
  );
  assert.equal(pyCheck.status, 0, pyCheck.stdout + pyCheck.stderr);
  assert.equal(pyCheck.stdout.trim(), "OK");

  // 2. CLI end-to-end: library loading, label centering, .edit suffix refusal, and --no-use-edit-suffix
  const libDir = path.join(dir, "custom-lib");
  fs.mkdirSync(path.join(libDir, "icons"), { recursive: true });
  fs.writeFileSync(
    path.join(libDir, "icons", "ComputeNode.json"),
    JSON.stringify({
      elements: [
        { id: "icon-1", type: "rectangle", x: 10, y: 20, width: 100, height: 60, groupIds: ["g1"] },
      ],
    }),
    "utf8",
  );

  const diagramPath = path.join(dir, "system.excalidraw");
  fs.writeFileSync(diagramPath, JSON.stringify({ type: "excalidraw", elements: [] }), "utf8");

  // CLI argument & missing-file validation errors exit 1
  for (const badArgs of [
    [addIconPy],
    [addIconPy, diagramPath, "ComputeNode", "100", "200", "--unknown-flag"],
    [addIconPy, diagramPath, "ComputeNode", "100", "200", "--label"],
    [addIconPy, diagramPath, "ComputeNode", "100", "200", "--library-path"],
    [addIconPy, path.join(dir, "missing.excalidraw"), "ComputeNode", "100", "200", "--library-path", libDir],
    [addIconPy, diagramPath, "ComputeNode", "100", "200", "--library-path", path.join(dir, "no-lib")],
    [addIconPy, diagramPath, "MissingIcon", "100", "200", "--library-path", libDir, "--no-use-edit-suffix"],
    [addArrowPy],
    [addArrowPy, diagramPath, "10", "20", "110", "120", "--style", "wavy"],
    [addArrowPy, diagramPath, "10", "20", "110", "120", "--style"],
    [addArrowPy, diagramPath, "10", "20", "110", "120", "--color"],
    [addArrowPy, diagramPath, "10", "20", "110", "120", "--label"],
    [addArrowPy, diagramPath, "10", "20", "110", "120", "--unknown-flag"],
    [addArrowPy, path.join(dir, "missing.excalidraw"), "10", "20", "110", "120"],
  ]) {
    assert.equal(runPy(badArgs).status, 1, `expected exit 1 for ${badArgs.join(" ")}`);
  }

  const okAdd = runPy([
    addIconPy,
    diagramPath,
    "ComputeNode",
    "300",
    "400",
    "--library-path",
    libDir,
    "--label",
    "API Worker",
  ]);
  assert.equal(okAdd.status, 0, okAdd.stdout + okAdd.stderr);
  assert.equal(fs.existsSync(`${diagramPath}.edit`), false);

  const savedDiagram = JSON.parse(fs.readFileSync(diagramPath, "utf8"));
  assert.equal(savedDiagram.elements.length, 2);
  assert.equal(savedDiagram.elements[0].x, 300);
  assert.equal(savedDiagram.elements[0].y, 400);
  assert.equal(savedDiagram.elements[1].type, "text");
  assert.equal(savedDiagram.elements[1].text, "API Worker");
  assert.equal(savedDiagram.elements[1].y, 470); // max_y (460) + 10

  // Stale .edit file blocks default --use-edit-suffix, while --no-use-edit-suffix edits directly
  fs.writeFileSync(`${diagramPath}.edit`, "{}", "utf8");
  assert.equal(
    runPy([addIconPy, diagramPath, "ComputeNode", "50", "50", "--library-path", libDir]).status,
    1,
  );
  assert.equal(
    runPy([addArrowPy, diagramPath, "10", "20", "110", "120"]).status,
    1,
  );
  assert.equal(
    runPy([
      addIconPy,
      diagramPath,
      "ComputeNode",
      "50",
      "50",
      "--library-path",
      libDir,
      "--no-use-edit-suffix",
    ]).status,
    0,
  );
  assert.equal(JSON.parse(fs.readFileSync(diagramPath, "utf8")).elements.length, 3);
  fs.rmSync(`${diagramPath}.edit`, { force: true });

  const okArrow = runPy([
    addArrowPy,
    diagramPath,
    "10",
    "20",
    "110",
    "120",
    "--style",
    "dotted",
    "--color",
    "#7950f2",
    "--label",
    "RPC",
  ]);
  assert.equal(okArrow.status, 0, okArrow.stdout + okArrow.stderr);
  assert.equal(fs.existsSync(`${diagramPath}.edit`), false);
  assert.equal(JSON.parse(fs.readFileSync(diagramPath, "utf8")).elements.length, 5);

  // 3. Isolated symlink subtest: skips only when Windows lacks SeCreateSymbolicLinkPrivilege (ERROR_PRIVILEGE_NOT_HELD = 1314)
  await t.test("preserves symlinks when editing target diagrams", (st) => {
    const symlinkDir = path.join(dir, "symlink-case");
    fs.mkdirSync(symlinkDir, { recursive: true });
    const symlinkCheck = runPy(
      [
        "-c",
        `
import importlib.util, io, json, pathlib, sys
from contextlib import redirect_stdout, redirect_stderr

if not __debug__:
    raise RuntimeError("expected Python assertions (__debug__) to stay active under -E")

add_icon_py = ${JSON.stringify(addIconPy)}
add_arrow_py = ${JSON.stringify(addArrowPy)}
symlink_dir = pathlib.Path(${JSON.stringify(symlinkDir)})
lib_dir = ${JSON.stringify(libDir)}

spec = importlib.util.spec_from_file_location("add_icon_sym", add_icon_py)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

arrow_spec = importlib.util.spec_from_file_location("add_arrow_sym", add_arrow_py)
arrow_mod = importlib.util.module_from_spec(arrow_spec)
arrow_spec.loader.exec_module(arrow_mod)

def invoke_main(script_mod, argv):
    saved_argv = sys.argv[:]
    out_buf, err_buf = io.StringIO(), io.StringIO()
    exit_code = 0
    sys.argv = argv
    try:
        with redirect_stdout(out_buf), redirect_stderr(err_buf):
            script_mod.main()
    except SystemExit as exc:
        exit_code = exc.code if isinstance(exc.code, int) else 1
    finally:
        sys.argv = saved_argv
    return exit_code, out_buf.getvalue(), err_buf.getvalue()

team_diagram = symlink_dir / "team.excalidraw"
alias_diagram = symlink_dir / "alias.excalidraw"
team_diagram.write_text('{"type": "excalidraw", "elements": []}', encoding="utf-8")

try:
    alias_diagram.symlink_to(team_diagram.name)
except OSError as exc:
    team_diagram.unlink(missing_ok=True)
    if getattr(exc, "winerror", None) == 1314:
        print("SKIP_WINERROR_1314")
        sys.exit(0)
    raise

try:
    code_sym_staged, out_ss, err_ss = invoke_main(
        mod, [add_icon_py, str(alias_diagram), "ComputeNode", "80", "90", "--library-path", lib_dir]
    )
    assert code_sym_staged == 0, out_ss + err_ss
    assert alias_diagram.is_symlink(), "staged CLI replaced symlink with regular file"
    assert alias_diagram.resolve() == team_diagram.resolve()
    assert len(json.loads(team_diagram.read_text(encoding="utf-8"))["elements"]) == 1

    code_sym_direct, out_sd, err_sd = invoke_main(
        mod,
        [add_icon_py, str(alias_diagram), "ComputeNode", "80", "90", "--library-path", lib_dir, "--no-use-edit-suffix"],
    )
    assert code_sym_direct == 0, out_sd + err_sd
    assert alias_diagram.is_symlink(), "direct CLI replaced symlink with regular file"
    assert len(json.loads(team_diagram.read_text(encoding="utf-8"))["elements"]) == 2

    with redirect_stdout(io.StringIO()):
        mod.add_icon_to_diagram(alias_diagram, "ComputeNode", 75, 85, pathlib.Path(lib_dir))
    assert alias_diagram.is_symlink(), "direct helper replaced symlink with regular file"
    assert len(json.loads(team_diagram.read_text(encoding="utf-8"))["elements"]) == 3

    code_sym_arrow, out_sa, err_sa = invoke_main(
        arrow_mod, [add_arrow_py, str(alias_diagram), "10", "20", "110", "120"]
    )
    assert code_sym_arrow == 0, out_sa + err_sa
    assert alias_diagram.is_symlink(), "add-arrow replaced symlink with regular file"
    assert len(json.loads(team_diagram.read_text(encoding="utf-8"))["elements"]) == 4
finally:
    alias_diagram.unlink(missing_ok=True)
    team_diagram.unlink(missing_ok=True)

print("OK")
`,
      ],
      { env: { PYTHONOPTIMIZE: "1" } },
    );
    assert.equal(symlinkCheck.status, 0, symlinkCheck.stdout + symlinkCheck.stderr);
    if (symlinkCheck.stdout.trim() === "SKIP_WINERROR_1314") {
      st.skip("Windows symlink creation requires SeCreateSymbolicLinkPrivilege (ERROR_PRIVILEGE_NOT_HELD / 1314)");
      return;
    }
    assert.equal(symlinkCheck.stdout.trim(), "OK");
  });
});

test("eval-driven-dev verify_step6_completion validates complete pixie result trees and reports every artifact/JSONL failure offline", (t) => {
  if (runPy(["--version"]).status !== 0) {
    t.skip("python3 is not available");
    return;
  }

  const dir = makeTempDir(t, "eval-step6-");
  const verifyPy = path.join(SKILLS_ROOT, "eval-driven-dev", "resources", "verify_step6_completion.py");

  // 1. Missing directory fails with exit 1
  const missingRun = runPy([verifyPy, path.join(dir, "does-not-exist")]);
  assert.equal(missingRun.status, 1);
  assert.match(missingRun.stdout, /results directory not found/);

  // 2. Complete, valid Step 6 results directory passes with exit 0
  const okRoot = path.join(dir, "run-pass");
  const okEntry = path.join(okRoot, "dataset-golden", "entry-001");
  fs.mkdirSync(okEntry, { recursive: true });
  for (const rootFile of ["action-plan.md", "action-plan-summary.md", "meta.json"]) {
    fs.writeFileSync(path.join(okRoot, rootFile), "{}\n", "utf8");
  }
  for (const dsFile of ["analysis.md", "analysis-summary.md"]) {
    fs.writeFileSync(path.join(okRoot, "dataset-golden", dsFile), "# Summary\n", "utf8");
  }
  fs.writeFileSync(
    path.join(okEntry, "evaluations.jsonl"),
    [
      "",
      JSON.stringify({ evaluator: "factuality", status: "completed", score: 1.0, reasoning: "Grounded." }),
      JSON.stringify({ evaluator: "conciseness", score: 0.9, reasoning: "Direct answer." }),
    ].join("\n") + "\n",
    "utf8",
  );

  const okRun = runPy([verifyPy, okRoot]);
  assert.equal(okRun.status, 0, okRun.stdout + okRun.stderr);
  assert.match(okRun.stdout, /Step 6 completion check passed\./);

  // 3. Incomplete / malformed directory reports root, dataset, entry, pending, non-dict, and missing score/reasoning errors
  const badRoot = path.join(dir, "run-fail");
  const dsEmpty = path.join(badRoot, "dataset-01-empty");
  const dsBroken = path.join(badRoot, "dataset-02-broken");
  const entryPending = path.join(dsBroken, "entry-01");
  const entryCorrupt = path.join(dsBroken, "entry-02");
  const entryMissingEval = path.join(dsBroken, "entry-03");
  fs.mkdirSync(dsEmpty, { recursive: true });
  fs.mkdirSync(entryPending, { recursive: true });
  fs.mkdirSync(entryCorrupt, { recursive: true });
  fs.mkdirSync(entryMissingEval, { recursive: true });

  // Omit meta.json at root and analysis-summary.md on dsEmpty
  fs.writeFileSync(path.join(badRoot, "action-plan.md"), "# Plan\n", "utf8");
  fs.writeFileSync(path.join(badRoot, "action-plan-summary.md"), "# Summary\n", "utf8");
  fs.writeFileSync(path.join(dsEmpty, "analysis.md"), "# Analysis\n", "utf8");
  fs.writeFileSync(path.join(dsBroken, "analysis.md"), "# Analysis\n", "utf8");
  fs.writeFileSync(path.join(dsBroken, "analysis-summary.md"), "# Summary\n", "utf8");

  fs.writeFileSync(
    path.join(entryPending, "evaluations.jsonl"),
    [
      "[1, 2, 3]",
      JSON.stringify({ evaluator: "tone-eval", status: "pending" }),
      JSON.stringify({ evaluator: "accuracy-eval", status: "scored" }),
    ].join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(path.join(entryCorrupt, "evaluations.jsonl"), "{not-valid-jsonl\n", "utf8");

  const failedRun = runPy([verifyPy, badRoot]);
  assert.equal(failedRun.status, 1);
  for (const expectedSnippet of [
    "Missing root artifact:",
    "Missing dataset artifact:",
    "no entry-* directories found",
    "Missing entry artifact:",
    "line 1 is not a JSON object",
    "Pending evaluation remains:",
    "tone-eval",
    "Missing score in scored evaluation:",
    "Missing reasoning in scored evaluation:",
    "invalid JSONL",
  ]) {
    assert.ok(
      failedRun.stdout.includes(expectedSnippet),
      `expected ${expectedSnippet} in:\n${failedRun.stdout}`,
    );
  }
});
