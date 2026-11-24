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
  return spawnSync(PYTHON_EXECUTABLE, ["-B", ...args], {
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

test("excalidraw add-icon-to-diagram transforms coordinates/bindings without mutating cached icon definitions and guards .edit files", (t) => {
  if (runPy(["--version"]).status !== 0) {
    t.skip("python3 is not available");
    return;
  }

  const dir = makeTempDir(t, "excalidraw-add-icon-");
  const scriptsDir = path.join(SKILLS_ROOT, "excalidraw-diagram-generator", "scripts");
  const addIconPy = path.join(scriptsDir, "add-icon-to-diagram.py");

  // 1. Direct Python unit checks for bounding boxes and non-mutating repeated transformations
  const pyCheck = runPy([
    "-c",
    `
import importlib.util, pathlib
spec = importlib.util.spec_from_file_location("add_icon", ${JSON.stringify(addIconPy)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

assert mod.calculate_bounding_box([]) == (0, 0, 0, 0)
assert mod.calculate_bounding_box([{"id": "no-coords"}]) == (0, 0, 0, 0)
assert mod.calculate_bounding_box([
    {"x": 20, "y": 40, "width": 50, "height": 30},
    {"x": 10, "y": 50, "width": 20, "height": 40},
]) == (10, 40, 70, 90)

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

first = mod.transform_icon_elements(template_elements, 200, 300)
second = mod.transform_icon_elements(template_elements, 500, 600)

# Original template must stay untouched so second placement also rewrites nested bindings
assert template_elements[0]["boundElements"][0]["id"] == "arrow-orig"
assert template_elements[2]["startBinding"]["elementId"] == "box-orig"

assert (first[0]["x"], first[0]["y"]) == (200, 300)
assert (second[0]["x"], second[0]["y"]) == (500, 600)
assert first[0]["id"] != "box-orig" and second[0]["id"] != first[0]["id"]
assert first[0]["groupIds"][0] == first[1]["groupIds"][0]
assert second[0]["groupIds"][0] != first[0]["groupIds"][0]

# Second placement's bindings point to second placement's new IDs (not first placement's IDs!)
assert second[1]["containerId"] == second[0]["id"]
assert second[2]["startBinding"]["elementId"] == second[0]["id"]
assert second[2]["endBinding"]["elementId"] == second[1]["id"]
assert [b["id"] for b in second[0]["boundElements"]] == [second[2]["id"], second[1]["id"]]
print("OK")
`,
  ]);
  assert.equal(pyCheck.status, 0, pyCheck.stdout + pyCheck.stderr);
  assert.equal(pyCheck.stdout.trim(), "OK");

  // 2. CLI end-to-end: library loading, label centering, .edit suffix lock refusal, and --no-use-edit-suffix
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
    [addIconPy, diagramPath, "MissingIcon", "100", "200", "--library-path", libDir],
  ]) {
    assert.equal(runPy(badArgs).status, 1);
  }
  // Failed icon lookup must restore diagram.excalidraw instead of stranding it at .excalidraw.edit
  assert.equal(fs.existsSync(diagramPath), true);
  assert.equal(fs.existsSync(`${diagramPath}.edit`), false);

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

  // 3. Atomic write & recovery guarantees: partial json.dump failure, post-write rename failure + retry,
  //    post-commit cleanup guidance + recovery, rollback OSError reporting, POSIX/Windows permissions,
  //    symlink preservation, and concurrent .edit / per-diagram locking across add-icon and add-arrow
  const addArrowPy = path.join(scriptsDir, "add-arrow.py");
  const integrityCheck = runPy(
    [
      "-E",
      "-c",
      `
import ctypes, importlib.util, io, json, os, pathlib, stat, sys, tempfile, threading, types
from contextlib import redirect_stdout, redirect_stderr

if not __debug__:
    raise RuntimeError("expected Python assertions (__debug__) to stay active under -E")

add_icon_py = ${JSON.stringify(addIconPy)}
add_arrow_py = ${JSON.stringify(addArrowPy)}
diagram_file = pathlib.Path(${JSON.stringify(diagramPath)})
lib_dir = ${JSON.stringify(libDir)}

spec = importlib.util.spec_from_file_location("add_icon_integrity", add_icon_py)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

arrow_spec = importlib.util.spec_from_file_location("add_arrow_integrity", add_arrow_py)
arrow_mod = importlib.util.module_from_spec(arrow_spec)
arrow_spec.loader.exec_module(arrow_mod)

def invoke_main(extra_args=(), target_diagram=None):
    saved_argv = sys.argv[:]
    out_buf, err_buf = io.StringIO(), io.StringIO()
    exit_code = 0
    chosen = str(target_diagram if target_diagram is not None else diagram_file)
    sys.argv = [add_icon_py, chosen, "ComputeNode", "80", "90", "--library-path", lib_dir, *extra_args]
    try:
        with redirect_stdout(out_buf), redirect_stderr(err_buf):
            mod.main()
    except SystemExit as exc:
        exit_code = exc.code if isinstance(exc.code, int) else 1
    finally:
        sys.argv = saved_argv
    return exit_code, out_buf.getvalue(), err_buf.getvalue()

def invoke_arrow_main(extra_args=(), target_diagram=None):
    saved_argv = sys.argv[:]
    out_buf, err_buf = io.StringIO(), io.StringIO()
    exit_code = 0
    chosen = str(target_diagram if target_diagram is not None else diagram_file)
    sys.argv = [add_arrow_py, chosen, "10", "20", "110", "120", *extra_args]
    try:
        with redirect_stdout(out_buf), redirect_stderr(err_buf):
            arrow_mod.main()
    except SystemExit as exc:
        exit_code = exc.code if isinstance(exc.code, int) else 1
    finally:
        sys.argv = saved_argv
    return exit_code, out_buf.getvalue(), err_buf.getvalue()

def call_add_icon(*args, **kwargs):
    with redirect_stdout(io.StringIO()):
        return mod.add_icon_to_diagram(*args, **kwargs)

baseline_raw = diagram_file.read_text(encoding="utf-8")
baseline_count = len(json.loads(baseline_raw)["elements"])
assert baseline_count == 3

# 3a. Partial write failure in json.dump preserves original diagram (both --use-edit-suffix and --no-use-edit-suffix) and leaves no temp files
real_json_dump = mod.json.dump
def truncated_dump(_obj, fp, **_kwargs):
    fp.write('{"truncated": ')
    fp.flush()
    raise OSError("simulated disk full mid-dump")

mod.json.dump = truncated_dump
try:
    code_edit, _, _ = invoke_main()
    assert code_edit == 1
    assert diagram_file.read_text(encoding="utf-8") == baseline_raw
    assert not pathlib.Path(str(diagram_file) + ".edit").exists()

    code_direct, _, _ = invoke_main(["--no-use-edit-suffix"])
    assert code_direct == 1
    assert diagram_file.read_text(encoding="utf-8") == baseline_raw
    leftover_tmps = [
        p.name for p in diagram_file.parent.iterdir()
        if p.name.endswith(".tmp") or p.name.endswith(".staged") or p.name.endswith(".lock")
    ]
    assert leftover_tmps == [], f"unexpected temp/lock files: {leftover_tmps}"
finally:
    mod.json.dump = real_json_dump

# 3b. Failure during final promotion after staged write preserves original so retry adds the icon only once
real_os_replace = mod.os.replace
def fail_final_promotion(src, dst):
    if pathlib.Path(dst) == diagram_file.resolve():
        raise OSError("transient final rename failure")
    return real_os_replace(src, dst)

mod.os.replace = fail_final_promotion
try:
    code_transient, _, _ = invoke_main()
    assert code_transient == 1
    assert diagram_file.read_text(encoding="utf-8") == baseline_raw
    assert not pathlib.Path(str(diagram_file) + ".edit").exists()
    leftover_staged = [
        p.name for p in diagram_file.parent.iterdir()
        if p.name.endswith(".tmp") or p.name.endswith(".staged") or p.name.endswith(".lock")
    ]
    assert leftover_staged == [], f"unexpected staged/lock files: {leftover_staged}"
finally:
    mod.os.replace = real_os_replace

code_retry, _, _ = invoke_main()
assert code_retry == 0
after_retry_count = len(json.loads(diagram_file.read_text(encoding="utf-8"))["elements"])
assert after_retry_count == baseline_count + 1, f"expected {baseline_count + 1}, got {after_retry_count}"

# 3c. Post-commit cleanup failure on .edit exits 0, explains how to recover, and next distinct insertion succeeds after moving .edit aside
real_unlink = pathlib.Path.unlink
resolved_diagram = diagram_file.resolve()
edit_file = pathlib.Path(str(resolved_diagram) + ".edit")
def fail_edit_cleanup(self, *args, **kwargs):
    if self == edit_file:
        raise PermissionError("busy .edit cleanup")
    return real_unlink(self, *args, **kwargs)

pathlib.Path.unlink = fail_edit_cleanup
try:
    code_cleanup_warn, _, err_cleanup = invoke_main()
    assert code_cleanup_warn == 0, f"expected exit 0 after commit, got {code_cleanup_warn}: {err_cleanup}"
    assert "Warning:" in err_cleanup
    assert "committed" in err_cleanup.lower(), f"expected committed notice in: {err_cleanup}"
    assert str(edit_file) in err_cleanup, f"expected backup path in: {err_cleanup}"
    assert "no edit is active" in err_cleanup.lower(), f"expected active-edit guidance in: {err_cleanup}"
    assert "move" in err_cleanup.lower(), f"expected move guidance in: {err_cleanup}"
finally:
    pathlib.Path.unlink = real_unlink

assert len(json.loads(diagram_file.read_text(encoding="utf-8"))["elements"]) == baseline_count + 2
assert edit_file.exists()
# Next command is blocked until the user moves the reported .edit backup out of the way
code_blocked_by_leftover, _, _ = invoke_main(["--label", "Blocked Retry"])
assert code_blocked_by_leftover == 1
moved_backup = diagram_file.parent / "manual-recovery.excalidraw.bak"
edit_file.rename(moved_backup)
try:
    code_after_recovery, _, err_after_recovery = invoke_main(["--label", "Recovered Distinct Insertion"])
    assert code_after_recovery == 0, err_after_recovery
    elems_after_recovery = json.loads(diagram_file.read_text(encoding="utf-8"))["elements"]
    # ComputeNode (1) + label (1) = 2 elements added
    assert len(elems_after_recovery) == baseline_count + 4
    assert any(e.get("type") == "text" and e.get("text") == "Recovered Distinct Insertion" for e in elems_after_recovery)
finally:
    moved_backup.unlink(missing_ok=True)

# 3d. Recovery uses no-replace semantics if final_path was recreated concurrently before rollback,
#     and reports backup path + error when os.link fails on filesystems without hard links
pre_concurrent_raw = diagram_file.read_text(encoding="utf-8")
real_load_icon = mod.load_icon
def concurrent_recreate_then_fail(_icon_name, _lib_path):
    resolved_diagram.write_text('{"type": "excalidraw", "concurrent": true}', encoding="utf-8")
    raise RuntimeError("icon failure after concurrent recreate")

mod.load_icon = concurrent_recreate_then_fail
try:
    code_concurrent, _, _ = invoke_main()
    assert code_concurrent == 1
    assert json.loads(diagram_file.read_text(encoding="utf-8")).get("concurrent") is True
    assert edit_file.exists()
    assert edit_file.read_text(encoding="utf-8") == pre_concurrent_raw
finally:
    mod.load_icon = real_load_icon
    edit_file.unlink(missing_ok=True)
    diagram_file.write_text(pre_concurrent_raw, encoding="utf-8")

if os.name != "nt":
    real_os_link = mod.os.link
    def fail_os_link(_src, _dst):
        raise OSError("Operation not supported")

    def missing_icon_fail(_icon_name, _lib_path):
        raise FileNotFoundError("simulated missing icon")

    mod.os.link = fail_os_link
    mod.load_icon = missing_icon_fail
    try:
        code_link_fail, _, err_link_fail = invoke_main()
        assert code_link_fail == 1
        assert str(edit_file) in err_link_fail, f"expected backup path in stderr: {err_link_fail}"
        assert "Operation not supported" in err_link_fail, f"expected link error in stderr: {err_link_fail}"
        assert edit_file.exists()
        assert edit_file.read_text(encoding="utf-8") == pre_concurrent_raw
    finally:
        mod.os.link = real_os_link
        mod.load_icon = real_load_icon
        if edit_file.exists():
            edit_file.rename(resolved_diagram)

# 3e. Preserve POSIX file permissions across staged CLI, direct CLI, and direct helper edits
if os.name != "nt":
    perm_diagram = diagram_file.parent / "shared-perms.excalidraw"
    perm_diagram.write_text('{"type": "excalidraw", "elements": []}', encoding="utf-8")
    for expected_mode in (0o644, 0o664):
        os.chmod(perm_diagram, expected_mode)
        code_staged_perm, _, err_sp = invoke_main([], target_diagram=perm_diagram)
        assert code_staged_perm == 0, err_sp
        actual_staged_mode = stat.S_IMODE(perm_diagram.stat().st_mode)
        assert actual_staged_mode == expected_mode, f"staged mode expected {oct(expected_mode)}, got {oct(actual_staged_mode)}"

        code_direct_perm, _, err_dp = invoke_main(["--no-use-edit-suffix"], target_diagram=perm_diagram)
        assert code_direct_perm == 0, err_dp
        actual_direct_mode = stat.S_IMODE(perm_diagram.stat().st_mode)
        assert actual_direct_mode == expected_mode, f"direct mode expected {oct(expected_mode)}, got {oct(actual_direct_mode)}"

        call_add_icon(perm_diagram, "ComputeNode", 10, 20, pathlib.Path(lib_dir))
        actual_helper_mode = stat.S_IMODE(perm_diagram.stat().st_mode)
        assert actual_helper_mode == expected_mode, f"helper mode expected {oct(expected_mode)}, got {oct(actual_helper_mode)}"
    perm_diagram.unlink(missing_ok=True)

# 3f. Windows DACL preservation: staged and direct writes establish restrictive security descriptor before writing output
win_events = []
fake_sd_bytes = b"SD_RESTRICTIVE_DACL_BYTES_V1"

def fake_get_windows_dacl_sd(src_path):
    win_events.append(("get_sd", pathlib.Path(src_path)))
    return ctypes.create_string_buffer(fake_sd_bytes, len(fake_sd_bytes))

def fake_open_windows_temp_file(parent_dir, prefix, source_sd):
    assert source_sd is not None, "expected restrictive source_sd before opening temp file"
    assert source_sd.raw[:len(fake_sd_bytes)] == fake_sd_bytes
    tmp_f = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=parent_dir,
        prefix=prefix,
        suffix=".tmp",
        delete=False,
    )
    win_events.append(("open_secured_temp", pathlib.Path(tmp_f.name)))
    return pathlib.Path(tmp_f.name), tmp_f

real_is_windows = mod._is_windows
real_get_sd = mod._get_windows_dacl_sd
real_open_win_tmp = mod._open_windows_temp_file
real_dump_for_win = mod.json.dump

def recording_json_dump(obj, fp, **kwargs):
    win_events.append(("json_dump", pathlib.Path(fp.name)))
    return real_dump_for_win(obj, fp, **kwargs)

win_diagram = diagram_file.parent / "win-dacl.excalidraw"
win_diagram.write_text('{"type": "excalidraw", "elements": []}', encoding="utf-8")
win_staged = diagram_file.parent / ".win-dacl.excalidraw.staged-test"
win_edit = pathlib.Path(str(win_diagram.resolve()) + ".edit")

mod._is_windows = lambda: True
mod._get_windows_dacl_sd = fake_get_windows_dacl_sd
mod._open_windows_temp_file = fake_open_windows_temp_file
mod.json.dump = recording_json_dump
try:
    # Direct write path: reads DACL from win_diagram and secures temp file BEFORE json.dump
    call_add_icon(win_diagram, "ComputeNode", 15, 25, pathlib.Path(lib_dir))
    assert [ev[0] for ev in win_events] == ["get_sd", "open_secured_temp", "json_dump"], f"unexpected order: {win_events}"
    assert win_events[0][1] == win_diagram.resolve()

    # Staged write path: win_staged does not exist yet, so DACL is read from work_path (win_edit) BEFORE json.dump
    win_events.clear()
    win_diagram.rename(win_edit)
    call_add_icon(win_edit, "ComputeNode", 35, 45, pathlib.Path(lib_dir), output_path=win_staged)
    mod.finalize_edit_path(win_edit, win_diagram.resolve(), staged_path=win_staged)
    assert [ev[0] for ev in win_events] == ["get_sd", "open_secured_temp", "json_dump"], f"unexpected staged order: {win_events}"
    assert win_events[0][1] == win_edit.resolve()
    assert len(json.loads(win_diagram.read_text(encoding="utf-8"))["elements"]) == 2

    # Fail-closed: if DACL retrieval raises OSError, existing diagram is preserved untouched
    def fail_get_sd(_src):
        raise OSError("ACL read denied")
    mod._get_windows_dacl_sd = fail_get_sd
    before_fail_text = win_diagram.read_text(encoding="utf-8")
    raised_acl_err = False
    try:
        call_add_icon(win_diagram, "ComputeNode", 55, 65, pathlib.Path(lib_dir))
    except OSError:
        raised_acl_err = True
    assert raised_acl_err
    assert win_diagram.read_text(encoding="utf-8") == before_fail_text
finally:
    mod._is_windows = real_is_windows
    mod._get_windows_dacl_sd = real_get_sd
    mod._open_windows_temp_file = real_open_win_tmp
    mod.json.dump = real_dump_for_win
    win_diagram.unlink(missing_ok=True)
    win_staged.unlink(missing_ok=True)
    win_edit.unlink(missing_ok=True)

# Also exercise _open_windows_temp_file Win32 call sequence with stubbed ctypes.WinDLL + msvcrt
win_low_dir = diagram_file.parent / "win-lowlevel"
win_low_dir.mkdir(exist_ok=True)
lowlevel_calls = []

class FakeWinFunc:
    def __init__(self, name, fn):
        self._name = name
        self._fn = fn
        self.argtypes = None
        self.restype = None
    def __call__(self, *args):
        return self._fn(*args)

def fake_windll(dll_name, **_kwargs):
    ns = types.SimpleNamespace()
    if dll_name == "advapi32":
        ns.SetSecurityDescriptorControl = FakeWinFunc(
            "SetSecurityDescriptorControl",
            lambda _sd, mask, bits: (lowlevel_calls.append(("SetSecurityDescriptorControl", mask, bits)) or 1),
        )
        ns.SetKernelObjectSecurity = FakeWinFunc(
            "SetKernelObjectSecurity",
            lambda handle, info, _sd: (lowlevel_calls.append(("SetKernelObjectSecurity", handle, info)) or 1),
        )
    elif dll_name == "kernel32":
        def fake_create_file(filename, access, share_mode, sa_ptr, disposition, _flags, _tmpl):
            assert share_mode == 0, f"expected exclusive share_mode=0, got {share_mode}"
            assert disposition == mod._CREATE_NEW
            assert sa_ptr is not None
            raw_fd = os.open(filename, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            lowlevel_calls.append(("CreateFileW", raw_fd, access, share_mode))
            return raw_fd
        ns.CreateFileW = FakeWinFunc("CreateFileW", fake_create_file)
        ns.CloseHandle = FakeWinFunc("CloseHandle", lambda h: (os.close(h) or 1))
    return ns

fake_msvcrt = types.ModuleType("msvcrt")
fake_msvcrt.open_osfhandle = lambda handle, _flags: (lowlevel_calls.append(("open_osfhandle", handle)) or handle)

real_ctypes_windll = getattr(ctypes, "WinDLL", None)
saved_msvcrt = sys.modules.get("msvcrt")
ctypes.WinDLL = fake_windll
sys.modules["msvcrt"] = fake_msvcrt
try:
    sample_sd = ctypes.create_string_buffer(b"RAW_SD_HEADER_AND_DACL", 22)
    created_tmp, writer = mod._open_windows_temp_file(win_low_dir, ".diag.", sample_sd)
    # Security descriptor control + CreateFileW(share=0) + SetKernelObjectSecurity all ran BEFORE writer is returned
    assert [c[0] for c in lowlevel_calls] == [
        "SetSecurityDescriptorControl",
        "CreateFileW",
        "SetKernelObjectSecurity",
        "open_osfhandle",
    ], f"unexpected Win32 call order: {lowlevel_calls}"
    assert lowlevel_calls[0][1:] == (mod._SE_DACL_PROTECTED, mod._SE_DACL_PROTECTED)
    assert lowlevel_calls[2][2] == mod._DACL_SECURITY_INFORMATION
    with writer as wf:
        wf.write("{}")
    assert created_tmp.read_text(encoding="utf-8") == "{}"
    created_tmp.unlink(missing_ok=True)
finally:
    if real_ctypes_windll is None:
        delattr(ctypes, "WinDLL")
    else:
        ctypes.WinDLL = real_ctypes_windll
    if saved_msvcrt is None:
        sys.modules.pop("msvcrt", None)
    else:
        sys.modules["msvcrt"] = saved_msvcrt
    win_low_dir.rmdir()

# 3g. Symlink preservation: alias.excalidraw -> team.excalidraw updates target and keeps symlink intact
team_diagram = diagram_file.parent / "team.excalidraw"
alias_diagram = diagram_file.parent / "alias.excalidraw"
team_diagram.write_text('{"type": "excalidraw", "elements": []}', encoding="utf-8")
alias_diagram.symlink_to(team_diagram.name)
try:
    code_sym_staged, _, err_ss = invoke_main([], target_diagram=alias_diagram)
    assert code_sym_staged == 0, err_ss
    assert alias_diagram.is_symlink(), "staged CLI replaced symlink with regular file"
    assert alias_diagram.resolve() == team_diagram.resolve()
    assert len(json.loads(team_diagram.read_text(encoding="utf-8"))["elements"]) == 1

    code_sym_direct, _, err_sd = invoke_main(["--no-use-edit-suffix"], target_diagram=alias_diagram)
    assert code_sym_direct == 0, err_sd
    assert alias_diagram.is_symlink(), "direct CLI replaced symlink with regular file"
    assert len(json.loads(team_diagram.read_text(encoding="utf-8"))["elements"]) == 2

    call_add_icon(alias_diagram, "ComputeNode", 75, 85, pathlib.Path(lib_dir))
    assert alias_diagram.is_symlink(), "direct helper replaced symlink with regular file"
    assert len(json.loads(team_diagram.read_text(encoding="utf-8"))["elements"]) == 3

    code_sym_arrow, _, err_sa = invoke_arrow_main([], target_diagram=alias_diagram)
    assert code_sym_arrow == 0, err_sa
    assert alias_diagram.is_symlink(), "add-arrow replaced symlink with regular file"
    assert len(json.loads(team_diagram.read_text(encoding="utf-8"))["elements"]) == 4
finally:
    alias_diagram.unlink(missing_ok=True)
    team_diagram.unlink(missing_ok=True)

# 3h. Concurrency regression:
# (i) If a second writer pauses between its check and rename and moves the newly promoted diagram
#     onto .edit before finalize_edit_path cleans up, finalize_edit_path must NOT unlink .edit.
race_diagram = diagram_file.parent / "race.excalidraw"
race_diagram.write_text('{"type": "excalidraw", "elements": []}', encoding="utf-8")
race_resolved = race_diagram.resolve()
race_edit = pathlib.Path(str(race_resolved) + ".edit")

b_checked_ok = race_resolved.exists() and not race_edit.exists()
assert b_checked_ok
work_a, final_a = mod.prepare_edit_path(race_resolved, True)
staged_a = final_a.with_name(f".{final_a.name}.staged-race")
call_add_icon(work_a, "ComputeNode", 10, 10, pathlib.Path(lib_dir), output_path=staged_a)

real_replace_race = mod.os.replace
def promote_then_interleave_rename(src, dst):
    res = real_replace_race(src, dst)
    if pathlib.Path(dst) == race_resolved:
        # Simulate paused invocation B resuming its rename right after A's promotion, before A's cleanup unlink
        race_resolved.rename(race_edit)
    return res

mod.os.replace = promote_then_interleave_rename
try:
    mod.finalize_edit_path(work_a, final_a, staged_path=staged_a)
finally:
    mod.os.replace = real_replace_race

assert race_diagram.exists() or race_edit.exists(), "committed diagram was lost from both diagram and .edit!"
retained_path = race_diagram if race_diagram.exists() else race_edit
assert len(json.loads(retained_path.read_text(encoding="utf-8"))["elements"]) == 1
if race_edit.exists() and not race_resolved.exists():
    race_edit.rename(race_resolved)

# (ii) End-to-end cross-process per-diagram lock serializes concurrent add-icon and add-arrow invocations
#      even while the first invocation holds the diagram at .excalidraw.edit.
import subprocess, time
a_inside_edit = threading.Event()
allow_a_finish = threading.Event()
real_add_icon_fn = mod.add_icon_to_diagram

def slow_add_icon(*args, **kwargs):
    a_inside_edit.set()
    assert allow_a_finish.wait(timeout=5), "timed out waiting for child process to contend lock"
    return real_add_icon_fn(*args, **kwargs)

mod.add_icon_to_diagram = slow_add_icon
results = {}

def run_a():
    results["a"] = invoke_main([], target_diagram=race_diagram)

proc_b = None
try:
    ta = threading.Thread(target=run_a)
    ta.start()
    assert a_inside_edit.wait(timeout=5)
    # While A is mid-edit, race_diagram is moved to race_edit; a concurrent add-arrow subprocess
    # must block on diagram_edit_lock rather than failing or racing on .edit.
    child_boot = (
        "import runpy, sys; "
        "sys.stdout.write('READY\\\\n'); sys.stdout.flush(); "
        "sys.argv = sys.argv[1:]; "
        "runpy.run_path(sys.argv[0], run_name='__main__')"
    )
    proc_b = subprocess.Popen(
        [sys.executable, "-B", "-E", "-c", child_boot, add_arrow_py, str(race_diagram), "10", "20", "110", "120", "--label", "RPC"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    ready_line = proc_b.stdout.readline()
    assert ready_line.strip() == "READY", f"unexpected child output: {ready_line!r}"
    time.sleep(0.05)
    assert proc_b.poll() is None, f"expected add-arrow to block on lock, exited early with {proc_b.returncode}"
    allow_a_finish.set()
    ta.join(timeout=5)
    out_b, err_b = proc_b.communicate(timeout=5)
finally:
    allow_a_finish.set()
    mod.add_icon_to_diagram = real_add_icon_fn
    if proc_b is not None and proc_b.poll() is None:
        proc_b.kill()
        proc_b.wait()

assert results["a"][0] == 0, results["a"]
assert proc_b.returncode == 0, (out_b, err_b)
assert race_diagram.exists()
assert not race_edit.exists()
assert not race_resolved.with_name(f".{race_resolved.name}.lock").exists()
# 1 pre-existing element + 1 icon + 2 arrow+label = 4 elements
assert len(json.loads(race_diagram.read_text(encoding="utf-8"))["elements"]) == 4
race_diagram.unlink(missing_ok=True)

print("OK")
`,
    ],
    { env: { PYTHONOPTIMIZE: "1" } },
  );
  assert.equal(integrityCheck.status, 0, integrityCheck.stdout + integrityCheck.stderr);
  assert.equal(integrityCheck.stdout.trim(), "OK");
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
