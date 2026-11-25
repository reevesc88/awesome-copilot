import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { test } from "node:test";
import { ROOT_FOLDER } from "./constants.mjs";

const SUBPROCESS_TIMEOUT_MS = 15_000;
const SKILLS_ROOT = path.join(ROOT_FOLDER, "skills");

function makeTempDir(t, prefix = "awesome-copilot-media-eyeball-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const PYTHON_INFO = (() => {
  const probe = spawnSync(
    "python3",
    [
      "-B",
      "-E",
      "-c",
      "import json, sys; print(json.dumps({'executable': sys.executable, 'version': list(sys.version_info[:3])}))",
    ],
    {
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT_MS,
    },
  );
  if (probe.status !== 0 || !probe.stdout.trim()) {
    return null;
  }
  try {
    return JSON.parse(probe.stdout.trim());
  } catch {
    return null;
  }
})();

const PYTHON_EXECUTABLE = PYTHON_INFO?.executable || "python3";

function ensurePython(t, minMajor = 3, minMinor = 0, pythonInfo = PYTHON_INFO) {
  if (!pythonInfo) {
    t.skip("python3 is not available");
    return false;
  }
  const [major = 0, minor = 0, patch = 0] = Array.isArray(pythonInfo.version)
    ? pythonInfo.version
    : [];
  if (major < minMajor || (major === minMajor && minor < minMinor)) {
    t.skip(`python3 >= ${minMajor}.${minMinor} required (found ${major}.${minor}.${patch})`);
    return false;
  }
  return true;
}

function runPython(args, { cwd, env = {} } = {}) {
  return spawnSync(PYTHON_EXECUTABLE, ["-B", "-E", ...args], {
    cwd,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env },
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
}

// Load pure helpers from drawio-to-png.mjs without puppeteer-core or top-level main() execution
const drawioRawSource = fs.readFileSync(
  path.join(SKILLS_ROOT, "drawio", "scripts", "drawio-to-png.mjs"),
  "utf8",
);
const drawioTestableSource = drawioRawSource
  .replace('import puppeteer from "puppeteer-core";', "const puppeteer = null;")
  .replace(
    /main\(\)\.catch\([\s\S]*?\);\s*$/,
    "export { buildViewerHtml, extractMxGraphModelXml, resolveRenderer, exportWithDrawioCli };\n",
  );
const {
  buildViewerHtml,
  exportWithDrawioCli,
  extractMxGraphModelXml,
  resolveRenderer,
} = await import(`data:text/javascript;base64,${Buffer.from(drawioTestableSource, "utf8").toString("base64")}`);

test("ensurePython skips explicitly when python3 is missing or older than the required version", () => {
  const skipMessages = [];
  const fakeContext = { skip: (msg) => skipMessages.push(msg) };

  assert.equal(ensurePython(fakeContext, 3, 10, null), false);
  assert.equal(
    ensurePython(fakeContext, 3, 10, { executable: "/usr/bin/python3", version: [3, 9, 18] }),
    false,
  );
  assert.equal(
    ensurePython(fakeContext, 3, 10, { executable: "/usr/bin/python3", version: [3, 10, 0] }),
    true,
  );
  assert.deepEqual(skipMessages, [
    "python3 is not available",
    "python3 >= 3.10 required (found 3.9.18)",
  ]);
});

test("excalidraw split-excalidraw-library sanitizes filenames, enforces single-library invariants, and generates sorted reference.md", (t) => {
  if (!ensurePython(t, 3, 8)) {
    return;
  }

  const dir = makeTempDir(t, "excalidraw-split-");
  const scriptPath = path.join(
    SKILLS_ROOT,
    "excalidraw-diagram-generator",
    "scripts",
    "split-excalidraw-library.py",
  );

  // 1. Direct helper checks
  const helperOutcome = runPython([
    "-c",
    `
import importlib.util, pathlib
spec = importlib.util.spec_from_file_location("split_lib", ${JSON.stringify(scriptPath)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

assert mod.sanitize_filename("  Azure / App Service (v2)!  ") == "Azure-App-Service-v2"
assert mod.sanitize_filename("---icon...name---") == "icon...name"
print("OK")
`,
  ]);
  assert.equal(helperOutcome.status, 0, helperOutcome.stdout + helperOutcome.stderr);
  assert.equal(helperOutcome.stdout.trim(), "OK");

  // 2. CLI validation errors: missing arg, missing directory, file instead of dir, 0 libs, >1 libs, missing libraryItems
  assert.equal(runPython([scriptPath]).status, 1);
  assert.equal(runPython([scriptPath, path.join(dir, "nonexistent")]).status, 1);

  const plainFile = path.join(dir, "not-a-dir.txt");
  fs.writeFileSync(plainFile, "hi", "utf8");
  assert.equal(runPython([scriptPath, plainFile]).status, 1);

  const emptyLibDir = path.join(dir, "empty-lib");
  fs.mkdirSync(emptyLibDir);
  assert.equal(runPython([scriptPath, emptyLibDir]).status, 1);

  const multiLibDir = path.join(dir, "multi-lib");
  fs.mkdirSync(multiLibDir);
  fs.writeFileSync(path.join(multiLibDir, "one.excalidrawlib"), "{}", "utf8");
  fs.writeFileSync(path.join(multiLibDir, "two.excalidrawlib"), "{}", "utf8");
  assert.equal(runPython([scriptPath, multiLibDir]).status, 1);

  const badSchemaDir = path.join(dir, "bad-schema");
  fs.mkdirSync(badSchemaDir);
  fs.writeFileSync(path.join(badSchemaDir, "broken.excalidrawlib"), JSON.stringify({ type: "excalidrawlib" }), "utf8");
  assert.equal(runPython([scriptPath, badSchemaDir]).status, 1);

  // 3. Valid library split writes icons/*.json and alphabetically sorted reference.md
  const validLibDir = path.join(dir, "cloud-icons");
  fs.mkdirSync(validLibDir);
  fs.writeFileSync(
    path.join(validLibDir, "cloud-icons.excalidrawlib"),
    JSON.stringify({
      type: "excalidrawlib",
      version: 2,
      libraryItems: [
        { id: "2", name: "Zebra Queue / Bus", elements: [{ id: "e2", type: "rectangle" }] },
        { id: "1", name: "Alpha Gateway!", elements: [{ id: "e1", type: "ellipse" }] },
      ],
    }),
    "utf8",
  );

  const splitOutcome = runPython([scriptPath, validLibDir]);
  assert.equal(splitOutcome.status, 0, splitOutcome.stdout + splitOutcome.stderr);

  const alphaIcon = JSON.parse(
    fs.readFileSync(path.join(validLibDir, "icons", "Alpha-Gateway.json"), "utf8"),
  );
  const zebraIcon = JSON.parse(
    fs.readFileSync(path.join(validLibDir, "icons", "Zebra-Queue-Bus.json"), "utf8"),
  );
  assert.equal(alphaIcon.elements[0].id, "e1");
  assert.equal(zebraIcon.elements[0].id, "e2");

  const refMd = fs.readFileSync(path.join(validLibDir, "reference.md"), "utf8");
  assert.match(refMd, /# cloud-icons Reference/);
  const alphaRowPos = refMd.indexOf("| Alpha Gateway! | `icons/Alpha-Gateway.json` |");
  const zebraRowPos = refMd.indexOf("| Zebra Queue / Bus | `icons/Zebra-Queue-Bus.json` |");
  assert.ok(alphaRowPos >= 0, "expected Alpha Gateway row in reference.md");
  assert.ok(zebraRowPos >= 0, "expected Zebra Queue / Bus row in reference.md");
  assert.ok(alphaRowPos < zebraRowPos, "expected Alpha row before Zebra row in reference.md");
});

test("nano-banana-pro-openrouter generate_image.py validates inputs, corrects MIME extensions, and saves multi-image payloads offline", (t) => {
  if (!ensurePython(t, 3, 10)) {
    return;
  }

  const dir = makeTempDir(t, "nano-banana-");
  const scriptPath = path.join(
    SKILLS_ROOT,
    "nano-banana-pro-openrouter",
    "scripts",
    "generate_image.py",
  );

  const pyDriver = `
import base64, importlib.util, io, os, pathlib, sys, types
from contextlib import redirect_stdout

recorded_calls = []
next_response_images = []

openai_mod = types.ModuleType("openai")
class FakeOpenAI:
    def __init__(self, base_url, api_key):
        self.base_url = base_url
        self.api_key = api_key
        self.chat = types.SimpleNamespace(
            completions=types.SimpleNamespace(create=self._create)
        )
    def _create(self, **kwargs):
        recorded_calls.append({"base_url": self.base_url, "api_key": self.api_key, **kwargs})
        msg = types.SimpleNamespace(images=list(next_response_images))
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=msg)])

openai_mod.OpenAI = FakeOpenAI
sys.modules["openai"] = openai_mod

spec = importlib.util.spec_from_file_location("generate_image", ${JSON.stringify(scriptPath)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

work = pathlib.Path(${JSON.stringify(dir)})

# 1. API key guard (synthetic 'test-token' only)
os.environ.pop("OPENROUTER_API_KEY", None)
try:
    mod.require_api_key()
    raise AssertionError("expected SystemExit when key missing")
except SystemExit as exc:
    assert "OPENROUTER_API_KEY" in str(exc)

os.environ["OPENROUTER_API_KEY"] = "test-token"
assert mod.require_api_key() == "test-token"

# 2. Data URL encode/decode + output suffix resolution
in_img = work / "ref_no_ext"
in_img.write_bytes(b"RAW_INPUT")
encoded_url = mod.encode_image_to_data_url(in_img)
assert encoded_url.startswith("data:image/png;base64,")
mime, decoded_bytes = mod.parse_data_url(encoded_url)
assert mime == "image/png" and decoded_bytes == b"RAW_INPUT"

for invalid_url in ["https://example.invalid/img.png", "data:image/png,plain"]:
    try:
        mod.parse_data_url(invalid_url)
        raise AssertionError("expected SystemExit for invalid data URL")
    except SystemExit:
        pass

try:
    mod.encode_image_to_data_url(work / "missing.png")
    raise AssertionError("expected SystemExit for missing input file")
except SystemExit:
    pass

# Single image corrects mismatched suffix (.jpg -> .png when API returns image/png)
with redirect_stdout(io.StringIO()) as warn_out:
    corrected = mod.resolve_output_path("banner.jpg", 0, 1, "image/png")
assert corrected == pathlib.Path("banner.png")
assert "Warning: filename extension '.jpg'" in warn_out.getvalue()

# Extensionless single image & numbered multi-image outputs
assert mod.resolve_output_path("card", 0, 1, "image/webp") == pathlib.Path("card.webp")
with redirect_stdout(io.StringIO()) as multi_warn:
    assert mod.resolve_output_path("out/card.png", 1, 2, "image/jpeg") == pathlib.Path("out/card-2.jpg")
assert "Using '.jpg' instead" in multi_warn.getvalue()
assert mod.extract_image_url({"image_url": {"url": "data:x"}}) == "data:x"
assert mod.extract_image_url({"url": "data:y"}) == "data:y"
assert mod.extract_image_url("not-a-dict") is None

# 3. CLI main(): >3 input images rejected; valid 2-image response writes numbered files
sys.argv = [
    "generate_image.py", "--prompt", "test", "--filename", "x.png",
    "--input-image", "a", "--input-image", "b", "--input-image", "c", "--input-image", "d",
]
try:
    mod.main()
    raise AssertionError("expected SystemExit for >3 input images")
except SystemExit as exc:
    assert "Too many input images" in str(exc)

png_b64 = base64.b64encode(b"OUT_PNG_1").decode("ascii")
webp_b64 = base64.b64encode(b"OUT_WEBP_2").decode("ascii")
next_response_images[:] = [
    {"image_url": {"url": f"data:image/png;base64,{png_b64}"}},
    {"url": f"data:image/webp;base64,{webp_b64}"},
]

target_file = work / "nested" / "scene.png"
sys.argv = [
    "generate_image.py",
    "--prompt", "Outback sunset",
    "--filename", str(target_file),
    "--resolution", "2k",
    "--input-image", str(in_img),
]
stdout_buf = io.StringIO()
with redirect_stdout(stdout_buf):
    mod.main()

assert len(recorded_calls) == 1
assert recorded_calls[0]["api_key"] == "test-token"
assert recorded_calls[0]["extra_body"]["image_config"]["image_size"] == "2K"
assert (work / "nested" / "scene-1.png").read_bytes() == b"OUT_PNG_1"
assert (work / "nested" / "scene-2.webp").read_bytes() == b"OUT_WEBP_2"
assert "MEDIA:" in stdout_buf.getvalue()

# Empty API images raises SystemExit
next_response_images[:] = []
try:
    mod.main()
    raise AssertionError("expected SystemExit when API returns no images")
except SystemExit as exc:
    assert "No images returned" in str(exc)

print("OK")
`;

  const check = runPython(["-c", pyDriver], { cwd: dir });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal(check.stdout.trim(), "OK");
});

test("eyeball.py stitches multi-page anchor regions, builds annotated Word docs, converts via LibreOffice stub, and checks setup offline", (t) => {
  if (!ensurePython(t, 3, 8)) {
    return;
  }

  const dir = makeTempDir(t, "eyeball-");
  const eyeballPath = path.join(SKILLS_ROOT, "eyeball", "tools", "eyeball.py");

  const pyDriver = `
import importlib.util, io, os, pathlib, shutil, sys, types
from contextlib import redirect_stdout, redirect_stderr

# Stub fitz, PIL, and docx so eyeball.py runs 100% deterministically without binary packages
fitz_mod = types.ModuleType("fitz")
class Rect:
    def __init__(self, x0, y0, x1, y1):
        self.x0, self.y0, self.x1, self.y1 = x0, y0, x1, y1
class Matrix:
    def __init__(self, sx, sy):
        self.sx, self.sy = sx, sy
fitz_mod.Rect = Rect
fitz_mod.Matrix = Matrix

pil_mod = types.ModuleType("PIL")
class FakeImage:
    def __init__(self, mode, size, color=(255, 255, 255)):
        self.mode = mode
        self.width, self.height = size
        self.size = (self.width, self.height)
        self.ops = []
    @classmethod
    def frombytes(cls, mode, size, _samples):
        return cls(mode, size)
    @classmethod
    def new(cls, mode, size, color=(255, 255, 255)):
        return cls(mode, size, color)
    def paste(self, img, pos):
        self.ops.append(("paste", img.size, pos))
    def save(self, buf, format="PNG"):
        buf.write(f"FAKEPNG:{self.width}x{self.height}".encode("ascii"))

class FakeImageDraw:
    @staticmethod
    def Draw(img, mode=None):
        return types.SimpleNamespace(
            rectangle=lambda box, fill=None, outline=None, width=1: img.ops.append(("rect", box, fill, outline))
        )

pil_mod.Image = FakeImage
pil_mod.ImageDraw = FakeImageDraw

docx_mod = types.ModuleType("docx")
docx_shared = types.ModuleType("docx.shared")
saved_docs = []

class FakeRun:
    def __init__(self, text):
        self.text = text
        self.font = types.SimpleNamespace(size=None, italic=False, color=types.SimpleNamespace(rgb=None))

class FakeParagraph:
    def __init__(self, text=""):
        self.text = text
        self.runs = []
        self.paragraph_format = types.SimpleNamespace(space_before=None, space_after=None)
    def add_run(self, text):
        r = FakeRun(text)
        self.runs.append(r)
        return r

class FakeDocument:
    def __init__(self):
        self.styles = {"Normal": types.SimpleNamespace(font=types.SimpleNamespace(name=None, size=None))}
        self.headings = []
        self.paragraphs = []
        self.pictures = []
        self.saved_to = None
        saved_docs.append(self)
    def add_heading(self, text, level=1):
        self.headings.append((level, text))
    def add_paragraph(self, text=""):
        p = FakeParagraph(text)
        self.paragraphs.append(p)
        return p
    def add_picture(self, buf, width=None):
        self.pictures.append((buf.getvalue(), width))
        self.paragraphs.append(FakeParagraph("[pic]"))
    def save(self, out_path):
        self.saved_to = out_path
        pathlib.Path(out_path).write_bytes(b"DOCX_OUT")

docx_mod.Document = FakeDocument
docx_shared.Inches = lambda v: ("in", v)
docx_shared.Pt = lambda v: ("pt", v)
docx_shared.RGBColor = lambda r, g, b: (r, g, b)

sys.modules["fitz"] = fitz_mod
sys.modules["PIL"] = pil_mod
sys.modules["docx"] = docx_mod
sys.modules["docx.shared"] = docx_shared

spec = importlib.util.spec_from_file_location("eyeball", ${JSON.stringify(eyeballPath)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

work = pathlib.Path(${JSON.stringify(dir)})

# 1. Path expansion & Windows LibreOffice discovery
os.environ["EYEBALL_SUBDIR"] = "reports"
assert mod._resolve_path("$EYEBALL_SUBDIR/doc.pdf") == "reports/doc.pdf"

fake_pf = work / "ProgramFiles"
soffice_win = fake_pf / "LibreOffice" / "program" / "soffice.exe"
soffice_win.parent.mkdir(parents=True)
soffice_win.write_bytes(b"MZ")
os.environ["ProgramFiles"] = str(fake_pf)
assert mod._find_libreoffice_windows() == str(soffice_win)

# 2. convert_to_pdf: missing file, PDF copy/no-op, unsupported extension, and LibreOffice headless fallback
try:
    mod.convert_to_pdf(str(work / "missing.pdf"), str(work / "out.pdf"))
    raise AssertionError("expected FileNotFoundError")
except FileNotFoundError:
    pass

src_pdf = work / "orig.pdf"
src_pdf.write_bytes(b"%PDF-orig")
copied_pdf = work / "copied.pdf"
assert mod.convert_to_pdf(str(src_pdf), str(copied_pdf)) is True
assert copied_pdf.read_bytes() == b"%PDF-orig"
assert mod.convert_to_pdf(str(src_pdf), str(src_pdf)) is True

bad_ext = work / "archive.zip"
bad_ext.write_bytes(b"PK")
try:
    mod.convert_to_pdf(str(bad_ext), str(work / "never.pdf"))
    raise AssertionError("expected RuntimeError for .zip")
except RuntimeError as exc:
    assert "Cannot convert .zip" in str(exc)

def fake_soffice_run(cmd, **kwargs):
    outdir = pathlib.Path(cmd[cmd.index("--outdir") + 1])
    src_stem = pathlib.Path(cmd[-1]).stem
    (outdir / f"{src_stem}.pdf").write_bytes(b"%PDF-from-soffice")
    return types.SimpleNamespace(returncode=0)

orig_subproc_run = mod.subprocess.run
orig_which = mod.shutil.which
orig_platform = mod.platform.system
mod.subprocess.run = fake_soffice_run
mod.shutil.which = lambda name: "/fake/soffice" if name in ("libreoffice", "soffice") else None
mod.platform.system = lambda: "Linux"
try:
    html_src = work / "page.html"
    html_src.write_text("<h1>Hi</h1>", encoding="utf-8")
    lo_pdf = work / "from_html.pdf"
    assert mod.convert_to_pdf(str(html_src), str(lo_pdf)) is True
    assert lo_pdf.read_bytes() == b"%PDF-from-soffice"
finally:
    mod.subprocess.run = orig_subproc_run
    mod.shutil.which = orig_which
    mod.platform.system = orig_platform

# 3. screenshot_region (single-page, multi-page vertical stitch, out-of-range target_pages, and miss)
class StubPdfPage:
    def __init__(self, hits_by_anchor):
        self.rect = Rect(0, 0, 600, 800)
        self._hits = hits_by_anchor
    def search_for(self, term):
        return self._hits.get(term, [])
    def get_pixmap(self, matrix, clip):
        w = max(10, int((clip.x1 - clip.x0) * matrix.sx))
        h = max(10, int((clip.y1 - clip.y0) * matrix.sy))
        return types.SimpleNamespace(width=w, height=h, samples=b"\\x00" * (w * h * 3))

class StubPdfDoc:
    def __init__(self):
        self.pages = [
            StubPdfPage({"clause A": [Rect(50, 100, 200, 120)]}),
            StubPdfPage({}),
            StubPdfPage({"clause B": [Rect(50, 300, 220, 330)]}),
        ]
        self.page_count = len(self.pages)
    def __getitem__(self, idx):
        return self.pages[idx]

pdf_doc = StubPdfDoc()
single_buf, single_label, single_size = mod.screenshot_region(pdf_doc, "clause A", target_page=1, dpi=72)
assert single_label == "page 1" and single_size[0] > 0 and single_buf.getvalue().startswith(b"FAKEPNG:")

multi_buf, multi_label, multi_size = mod.screenshot_region(
    pdf_doc, ["clause A", "clause B"], target_pages=[1, 3, 99], dpi=72
)
assert multi_label == "pages 1, 3"
assert multi_size[1] > single_size[1]  # vertically stitched height exceeds single-page crop

miss_buf, miss_label, miss_size = mod.screenshot_region(pdf_doc, ["nonexistent"], dpi=72)
assert (miss_buf, miss_label, miss_size) == (None, None, None)

# 4. build_analysis_doc: >3 anchor truncation (+N more) and missing-anchor warning paragraph
out_docx = work / "analysis.docx"
mod.build_analysis_doc(
    pdf_doc,
    sections=[
        {
            "heading": "Indemnity",
            "analysis": "Key obligations.",
            "anchors": ["clause A", "a2", "a3", "a4", "a5"],
        },
        {
            "heading": "Missing Clause",
            "analysis": "Absent term.",
            "anchors": ["ghost term"],
        },
    ],
    output_path=str(out_docx),
    title="Contract Review",
    subtitle="Draft 1",
    source_label="agreement.pdf",
    dpi=72,
)
assert out_docx.read_bytes() == b"DOCX_OUT"
built = saved_docs[-1]
all_runs = [r.text for p in built.paragraphs for r in p.runs]
assert any("(+2 more)" in t and "agreement.pdf, page 1" in t for t in all_runs), all_runs
assert any("Screenshot not available" in t and "'ghost term'" in t for t in all_runs), all_runs
assert len(built.pictures) == 1

# 5. cmd_setup_check detects PLAYWRIGHT_BROWSERS_PATH chromium folder and returns 0 vs 1 when core missing
pw_dir = work / "pw-browsers"
(pw_dir / "chromium-1140").mkdir(parents=True)
os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(pw_dir)
chk_out = io.StringIO()
with redirect_stdout(chk_out):
    assert mod.cmd_setup_check() == 0
assert "[+] Chromium browser: OK" in chk_out.getvalue()

# _check_core_deps exits 1 when fitz is None
mod.fitz = None
try:
    with redirect_stderr(io.StringIO()):
        mod._check_core_deps()
    raise AssertionError("expected SystemExit(1)")
except SystemExit as exc:
    assert exc.code == 1

print("OK")
`;

  const check = runPython(["-c", pyDriver], { cwd: dir });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal(check.stdout.trim(), "OK");
});

test("drawio-to-png helpers decode raw/compressed diagrams and sandbox-npm-install validates CLI inputs offline", (t) => {
  const dir = makeTempDir(t, "drawio-and-sandbox-");

  // 1. drawio-to-png.mjs: buildViewerHtml escapes template-literal metacharacters
  const viewerHtml = buildViewerHtml('<mxGraphModel><root id="$1" note="`quoted` \\path"/></mxGraphModel>');
  assert.match(viewerHtml, /\\\$1/);
  assert.match(viewerHtml, /\\`quoted\\`/);
  assert.match(viewerHtml, /\\\\path/);

  // 2. extractMxGraphModelXml: raw <mxGraphModel>, uncompressed <mxfile>, and deflateRaw+base64 compressed <diagram>
  const rawModel = '<mxGraphModel dx="100"><root><mxCell id="0"/></root></mxGraphModel>';
  assert.equal(extractMxGraphModelXml(`  ${rawModel}\n`), rawModel);
  assert.equal(
    extractMxGraphModelXml(`<mxfile><diagram name="Page-1">${rawModel}</diagram></mxfile>`),
    rawModel,
  );

  const compressedPayload = deflateRawSync(Buffer.from(encodeURIComponent(rawModel), "utf8")).toString("base64");
  assert.equal(
    extractMxGraphModelXml(`<mxfile><diagram id="d1">${compressedPayload}</diagram></mxfile>`),
    rawModel,
  );

  assert.throws(
    () => extractMxGraphModelXml("<svg></svg>"),
    /missing <mxGraphModel> or <diagram> content/,
  );
  const nonGraphCompressed = deflateRawSync(Buffer.from(encodeURIComponent("<notMxGraph/>"), "utf8")).toString("base64");
  assert.throws(
    () => extractMxGraphModelXml(`<mxfile><diagram>${nonGraphCompressed}</diagram></mxfile>`),
    /Failed to decode compressed <diagram> content/,
  );

  // 3. resolveRenderer parses --renderer=* and rejects unknown renderers
  assert.deepEqual(resolveRenderer(["diagram.drawio"]), {
    renderer: "auto",
    args: ["diagram.drawio"],
  });
  assert.deepEqual(resolveRenderer(["--renderer=CLI", "--dir", "out"]), {
    renderer: "cli",
    args: ["--dir", "out"],
  });
  assert.throws(() => resolveRenderer(["--renderer=svg", "a.drawio"]), /Invalid renderer 'svg'/);

  if (process.platform === "win32") {
    return;
  }

  // 4. exportWithDrawioCli invokes CLI binary with expected flags (-x -f png -e -b 10 -o <output> <input>)
  const fakeCli = path.join(dir, "fake-drawio.sh");
  fs.writeFileSync(
    fakeCli,
    `#!/usr/bin/env bash
if [[ "$8" == *"fail.png" ]]; then
  echo "render failure" >&2
  exit 2
fi
printf 'PNG_EXPORT:%s' "$9" > "$8"
`,
    { mode: 0o755 },
  );
  const outPng = path.join(dir, "exported.png");
  exportWithDrawioCli(fakeCli, "input.drawio", outPng);
  assert.equal(fs.readFileSync(outPng, "utf8"), "PNG_EXPORT:input.drawio");
  assert.throws(
    () => exportWithDrawioCli(fakeCli, "input.drawio", path.join(dir, "fail.png")),
    /render failure/,
  );

  // 5. sandbox-npm-install/scripts/install.sh CLI argument & workspace validation (stops before DEPS_BASE writes)
  const installScript = path.join(SKILLS_ROOT, "sandbox-npm-install", "scripts", "install.sh");
  const helpProc = spawnSync("bash", [installScript, "--help"], {
    cwd: dir,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(helpProc.status, 0);
  assert.match(helpProc.stdout, /Usage: install\.sh \[options\]/);

  const missingArgProc = spawnSync("bash", [installScript, "--workspace"], {
    cwd: dir,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(missingArgProc.status, 1);
  assert.match(missingArgProc.stdout, /--workspace requires a path argument/);

  const unknownFlagProc = spawnSync("bash", [installScript, "--bogus"], {
    cwd: dir,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(unknownFlagProc.status, 1);
  assert.match(unknownFlagProc.stdout, /Unknown option: --bogus/);

  const emptyWorkspace = path.join(dir, "no-pkg");
  fs.mkdirSync(emptyWorkspace);
  const noPkgProc = spawnSync("bash", [installScript, "--workspace", emptyWorkspace], {
    cwd: dir,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(noPkgProc.status, 1);
  assert.match(noPkgProc.stdout, /Could not find a valid workspace client path containing package\.json/);
});
