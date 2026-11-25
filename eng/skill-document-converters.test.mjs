import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ROOT_FOLDER } from "./constants.mjs";

const SUBPROCESS_TIMEOUT_MS = 15_000;
const SKILLS_ROOT = path.join(ROOT_FOLDER, "skills");

function makeTempDir(t, prefix = "awesome-copilot-doc-conv-") {
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

function runPython(args, { cwd, env = {} } = {}) {
  return spawnSync(PYTHON_EXECUTABLE, ["-B", "-E", ...args], {
    cwd,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env },
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
}

test("convert-excel-to-md extracts OOXML per-sheet media, injects markdown image blocks, and handles batch/CLI errors offline", (t) => {
  if (runPython(["--version"]).status !== 0) {
    t.skip("python3 is not available");
    return;
  }

  const dir = makeTempDir(t, "excel-to-md-");
  const scriptPath = path.join(SKILLS_ROOT, "convert-excel-to-md", "scripts", "convert_excel_to_md.py");

  const pyDriver = `
import importlib.util, io, pathlib, sys, types, zipfile
from contextlib import redirect_stdout, redirect_stderr

if not __debug__:
    raise RuntimeError("expected Python assertions to remain enabled")

spec = importlib.util.spec_from_file_location("convert_excel_to_md", ${JSON.stringify(scriptPath)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# 1. Pure path & filename helpers
assert mod._normalize_rel_path("xl/drawings", "../media/image1.png") == "xl/media/image1.png"
assert mod._normalize_rel_path("xl", "/xl/worksheets/sheet1.xml") == "xl/worksheets/sheet1.xml"
assert mod._sanitize_filename_part("Q1 / Revenue & Ops!") == "Q1_Revenue_Ops"
assert mod._sanitize_filename_part("///___!!!") == "sheet"

# 2. Build synthetic .xlsx archive with two sheets (relative + package-absolute OOXML targets)
work = pathlib.Path(${JSON.stringify(dir)})
xlsx_path = work / "metrics.xlsx"
with zipfile.ZipFile(xlsx_path, "w") as z:
    z.writestr(
        "xl/workbook.xml",
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets>'
        '<sheet name="Q1 Summary" sheetId="1" r:id="rId1"/>'
        '<sheet name="Raw Data" sheetId="2" r:id="rId2"/>'
        '<sheet name="Broken Drawing" sheetId="3" r:id="rId3"/>'
        '</sheets></workbook>',
    )
    z.writestr(
        "xl/_rels/workbook.xml.rels",
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/>'
        '<Relationship Id="rId3" Target="worksheets/sheet3.xml"/>'
        '</Relationships>',
    )
    z.writestr(
        "xl/worksheets/sheet1.xml",
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<drawing r:id="rDrw1"/></worksheet>',
    )
    z.writestr(
        "xl/worksheets/_rels/sheet1.xml.rels",
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rDrw1" Target="../drawings/drawing1.xml"/>'
        '</Relationships>',
    )
    z.writestr(
        "xl/drawings/drawing1.xml",
        '<wsDr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<a:blip r:embed="rImg1"/><a:blip r:embed="rImg2"/><a:blip r:embed="rMissing"/>'
        '</wsDr>',
    )
    z.writestr(
        "xl/drawings/_rels/drawing1.xml.rels",
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rImg1" Target="../media/chart.jpg"/>'
        '<Relationship Id="rImg2" Target="/xl/media/rawblob"/>'
        '<Relationship Id="rMissing" Target="../media/absent.png"/>'
        '</Relationships>',
    )
    z.writestr("xl/media/chart.jpg", b"JPEGDATA")
    z.writestr("xl/media/rawblob", b"BINDATA")
    # Sheet 2 has no drawing; Sheet 3 points to missing rels
    z.writestr("xl/worksheets/sheet2.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>')
    z.writestr("xl/worksheets/_rels/sheet2.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')
    z.writestr("xl/worksheets/sheet3.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>')

media_map = mod._sheet_name_to_media(xlsx_path)
assert media_map == {"Q1 Summary": ["xl/media/chart.jpg", "xl/media/rawblob"]}, media_map

img_out = work / "extracted_imgs"
written = mod.extract_images(xlsx_path, img_out)
assert written == {
    "Q1 Summary": ["sheet001_Q1_Summary_img001.jpeg", "sheet001_Q1_Summary_img002.bin"],
}, written
assert (img_out / "sheet001_Q1_Summary_img001.jpeg").read_bytes() == b"JPEGDATA"
assert (img_out / "sheet001_Q1_Summary_img002.bin").read_bytes() == b"BINDATA"

# Bad zip / non-workbook zip returns {} gracefully
bad_zip = work / "corrupt.xlsx"
bad_zip.write_bytes(b"not-a-zip")
assert mod._sheet_name_to_media(bad_zip) == {}

# 3. Markdown per-sheet image injection (including CRLF sheet headings & untouched sheets)
raw_md = "Intro\\n\\n## Q1 Summary\\r\\n| A | B |\\n| 1 | 2 |\\n\\n## Raw Data\\n| X |\\n| 9 |\\n"
injected = mod.insert_sheet_images(raw_md, written)
assert "#### Images in this sheet" in injected
assert "![sheet001_Q1_Summary_img001.jpeg](img/sheet001_Q1_Summary_img001.jpeg)" in injected
assert injected.index("#### Images in this sheet") < injected.index("## Raw Data")
assert mod.insert_sheet_images("No sheet headings", written) == "No sheet headings"
assert mod.insert_sheet_images(raw_md, {}) == raw_md

# 4. Batch discovery + CLI main() with synthetic MarkItDown stub
batch_root = work / "batch"
(batch_root / "sub").mkdir(parents=True)
(batch_root / "top.xlsx").write_bytes(xlsx_path.read_bytes())
(batch_root / "notes.txt").write_text("skip me", encoding="utf-8")
(batch_root / "sub" / "fail.xlsx").write_bytes(bad_zip.read_bytes())

non_rec, skipped_top = mod.find_xlsx_files(batch_root, recursive=False)
assert [p.name for p in non_rec] == ["top.xlsx"] and skipped_top == 1
rec_files, skipped_rec = mod.find_xlsx_files(batch_root, recursive=True)
assert [p.name for p in rec_files] == ["fail.xlsx", "top.xlsx"] and skipped_rec == 1

fake_pkg = types.ModuleType("markitdown")
class FakeMarkItDown:
    def convert(self, src):
        if src.endswith("fail.xlsx"):
            raise RuntimeError("synthetic parse error")
        return types.SimpleNamespace(text_content="## Q1 Summary\\n| Col |\\n| Val |\\n")
fake_pkg.MarkItDown = FakeMarkItDown
sys.modules["markitdown"] = fake_pkg

# Pre-populate stale image in single-file destination to verify cleanup on re-run
single_dest = work / "custom_out"
(single_dest / "img").mkdir(parents=True)
stale_file = single_dest / "img" / "stale.png"
stale_file.write_bytes(b"old")

sys.argv = ["convert_excel_to_md.py", str(xlsx_path), "-o", str(single_dest)]
with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
    assert mod.main() == mod.EXIT_OK
assert not stale_file.exists()
assert (single_dest / "metrics.md").is_file()
assert "sheet001_Q1_Summary_img001.jpeg" in (single_dest / "metrics.md").read_text(encoding="utf-8")

# Recursive batch with partial failure returns EXIT_CONVERSION_FAILED (1) and preserves relative subdir
batch_out = work / "batch_out"
sys.argv = ["convert_excel_to_md.py", str(batch_root), "-o", str(batch_out), "--recursive"]
with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
    assert mod.main() == mod.EXIT_CONVERSION_FAILED
assert (batch_out / "top" / "top.md").is_file()

# Invalid input paths and extensions return EXIT_INVALID_INPUT (3) before importing markitdown
sys.argv = ["convert_excel_to_md.py", str(work / "missing.xlsx")]
with redirect_stderr(io.StringIO()):
    assert mod.main() == mod.EXIT_INVALID_INPUT

txt_input = work / "plain.txt"
txt_input.write_text("hi", encoding="utf-8")
sys.argv = ["convert_excel_to_md.py", str(txt_input)]
with redirect_stderr(io.StringIO()):
    assert mod.main() == mod.EXIT_INVALID_INPUT

empty_dir = work / "empty_dir"
empty_dir.mkdir()
sys.argv = ["convert_excel_to_md.py", str(empty_dir)]
with redirect_stderr(io.StringIO()):
    assert mod.main() == mod.EXIT_INVALID_INPUT

# Missing markitdown dependency exits with EXIT_MISSING_DEPENDENCY (2)
del sys.modules["markitdown"]
real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__
def block_markitdown(name, *a, **kw):
    if name == "markitdown":
        raise ImportError("no markitdown")
    return real_import(name, *a, **kw)

import builtins
orig_bi = builtins.__import__
builtins.__import__ = block_markitdown
try:
    sys.argv = ["convert_excel_to_md.py", str(xlsx_path)]
    try:
        with redirect_stderr(io.StringIO()):
            mod.main()
        raise AssertionError("expected SystemExit(2)")
    except SystemExit as exc:
        assert exc.code == mod.EXIT_MISSING_DEPENDENCY
finally:
    builtins.__import__ = orig_bi

print("OK")
`;

  const check = runPython(["-c", pyDriver], { cwd: dir });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal(check.stdout.trim(), "OK");
});

test("convert-word-to-md extracts blip and VML media in document order, rewrites placeholders safely, and handles CLI errors offline", (t) => {
  if (runPython(["--version"]).status !== 0) {
    t.skip("python3 is not available");
    return;
  }

  const dir = makeTempDir(t, "word-to-md-");
  const scriptPath = path.join(SKILLS_ROOT, "convert-word-to-md", "scripts", "convert_word_to_md.py");

  const pyDriver = `
import importlib.util, io, pathlib, sys, types, zipfile
from contextlib import redirect_stdout, redirect_stderr

spec = importlib.util.spec_from_file_location("convert_word_to_md", ${JSON.stringify(scriptPath)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

work = pathlib.Path(${JSON.stringify(dir)})
docx_path = work / "handbook.docx"
with zipfile.ZipFile(docx_path, "w") as z:
    z.writestr(
        "word/document.xml",
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:v="urn:schemas-microsoft-com:vml" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<w:body>'
        '<a:blip r:embed="rId2"/>'
        '<v:imagedata r:id="rId1"/>'
        '<a:blip r:embed="rIdLink"/>'
        '<a:blip r:embed="rIdMissingZip"/>'
        '</w:body></w:document>',
    )
    z.writestr(
        "word/_rels/document.xml.rels",
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Target="/word/media/legacy.jpg"/>'
        '<Relationship Id="rId2" Target="media/diagram.png"/>'
        '<Relationship Id="rIdLink" Target="https://example.invalid/not-media"/>'
        '<Relationship Id="rIdMissingZip" Target="media/ghost.png"/>'
        '</Relationships>',
    )
    z.writestr("word/media/diagram.png", b"PNG_BYTES")
    z.writestr("word/media/legacy.jpg", b"JPG_BYTES")

ordered = mod._document_order_media(docx_path)
assert ordered == [
    ("rId2", "word/media/diagram.png"),
    ("rId1", "word/media/legacy.jpg"),
    ("rIdMissingZip", "word/media/ghost.png"),
], ordered

err_buf = io.StringIO()
with redirect_stderr(err_buf):
    extracted = mod._extract_images(docx_path, work / "imgs")
# rId2 is idx 1 -> img001.png, rId1 is idx 2 -> img002.jpeg, rIdMissingZip warns & skips
assert extracted == ["img001.png", "img002.jpeg"], extracted
assert "word/media/ghost.png" in err_buf.getvalue()
assert (work / "imgs" / "img001.png").read_bytes() == b"PNG_BYTES"
assert (work / "imgs" / "img002.jpeg").read_bytes() == b"JPG_BYTES"

# Malformed XML / corrupt archive returns []
broken_docx = work / "broken.docx"
with zipfile.ZipFile(broken_docx, "w") as z:
    z.writestr("word/document.xml", "<unclosed")
    z.writestr("word/_rels/document.xml.rels", "<unclosed")
assert mod._document_order_media(broken_docx) == []

# Placeholder rewriting: exact match replaces in order; count mismatch leaves markdown untouched
sample_md = "Lead ![Arch Diagram](data:image/png;base64...) middle ![Legacy Photo](data:image/jpeg;base64,AAA=) end"
rewritten = mod._rewrite_image_refs(sample_md, ["img001.png", "img002.jpeg"])
assert rewritten == "Lead ![Arch Diagram](img/img001.png) middle ![Legacy Photo](img/img002.jpeg) end", rewritten

mismatch_err = io.StringIO()
with redirect_stderr(mismatch_err):
    unchanged = mod._rewrite_image_refs(sample_md, ["img001.png"])
assert unchanged == sample_md
assert "leaving placeholders unreplaced" in mismatch_err.getvalue()

# End-to-end batch & ImportError inside convert_one
fake_pkg = types.ModuleType("markitdown")
class FakeWordConverter:
    def convert(self, src):
        if src.endswith("missing_extra.docx"):
            raise ImportError("missing mammoth")
        return types.SimpleNamespace(text_content=sample_md)
fake_pkg.MarkItDown = FakeWordConverter
sys.modules["markitdown"] = fake_pkg

batch_dir = work / "docs"
(batch_dir / "nested").mkdir(parents=True)
(batch_dir / "nested" / "handbook.docx").write_bytes(docx_path.read_bytes())
(batch_dir / "ignore.md").write_text("# skip", encoding="utf-8")

found_docs, skipped_count = mod.find_docx_files(batch_dir, recursive=True)
assert [p.name for p in found_docs] == ["handbook.docx"] and skipped_count == 1

out_root = work / "out_docs"
sys.argv = ["convert_word_to_md.py", str(batch_dir), "-o", str(out_root), "--recursive"]
with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
    assert mod.main() == mod.EXIT_OK
rendered_md = (out_root / "nested" / "handbook" / "handbook.md").read_text(encoding="utf-8")
assert "![Arch Diagram](img/img001.png)" in rendered_md
assert (out_root / "nested" / "handbook" / "img" / "img002.jpeg").is_file()

# ImportError raised lazily inside md.convert exits with EXIT_MISSING_DEPENDENCY (2)
lazy_fail = work / "missing_extra.docx"
lazy_fail.write_bytes(docx_path.read_bytes())
try:
    with redirect_stderr(io.StringIO()):
        mod.convert_one(FakeWordConverter(), lazy_fail, work / "unused")
    raise AssertionError("expected SystemExit(2)")
except SystemExit as exc:
    assert exc.code == mod.EXIT_MISSING_DEPENDENCY

print("OK")
`;

  const check = runPython(["-c", pyDriver], { cwd: dir });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal(check.stdout.trim(), "OK");
});

test("convert-pdf-to-md deduplicates XObject and inline page images, appends sorted page sections, and closes PDF handles", (t) => {
  if (runPython(["--version"]).status !== 0) {
    t.skip("python3 is not available");
    return;
  }

  const dir = makeTempDir(t, "pdf-to-md-");
  const scriptPath = path.join(SKILLS_ROOT, "convert-pdf-to-md", "scripts", "convert_pdf_to_md.py");

  const pyDriver = `
import importlib.util, io, pathlib, sys, types
from contextlib import redirect_stdout, redirect_stderr

spec = importlib.util.spec_from_file_location("convert_pdf_to_md", ${JSON.stringify(scriptPath)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

work = pathlib.Path(${JSON.stringify(dir)})
pdf_file = work / "whitepaper.pdf"
pdf_file.write_bytes(b"%PDF-1.4 synthetic")

closed_docs = []

class FakePage:
    def __init__(self, xobjects, blocks):
        self._xobjects = xobjects
        self._blocks = blocks
    def get_images(self, full=False):
        return self._xobjects
    def get_text(self, mode, flags=0):
        assert mode == "dict"
        return {"blocks": self._blocks}

class FakeDoc:
    def __init__(self):
        self.pages = [
            # Page 1: xref 10 (IMG_A), xref 99 (raises), xref 11 (empty), inline duplicate IMG_A, inline distinct IMG_B
            FakePage(
                [(10,), (99,), (11,)],
                [
                    {"type": 0, "text": "ignored text block"},
                    {"type": 1, "image": b"IMG_A", "ext": "PNG"},
                    {"type": 1, "image": b"IMG_B", "ext": "jpeg"},
                ],
            ),
            # Page 2: no images
            FakePage([], []),
            # Page 3: same IMG_A on a different page should still be emitted for page 3
            FakePage([(10,)], []),
        ]
    def __len__(self):
        return len(self.pages)
    def __getitem__(self, idx):
        return self.pages[idx]
    def extract_image(self, xref):
        if xref == 99:
            raise RuntimeError("corrupt XObject stream")
        if xref == 11:
            return {"image": b"", "ext": "png"}
        return {"image": b"IMG_A", "ext": "PNG"}
    def close(self):
        closed_docs.append(True)

fake_fitz = types.ModuleType("fitz")
fake_fitz.TEXT_PRESERVE_IMAGES = 8
fake_fitz.open = lambda p: FakeDoc()

fake_markitdown = types.ModuleType("markitdown")
class FakePdfMd:
    def convert(self, src):
        return types.SimpleNamespace(text_content="# Whitepaper\\n\\nBody paragraph.\\n\\n")
fake_markitdown.MarkItDown = FakePdfMd

sys.modules["fitz"] = fake_fitz
sys.modules["markitdown"] = fake_markitdown

err_buf = io.StringIO()
with redirect_stderr(err_buf):
    by_page = mod.extract_images(fake_fitz, pdf_file, work / "pdf_imgs")

assert closed_docs == [True]
assert "xref=99" in err_buf.getvalue()
assert by_page == {
    1: ["page001_img001.png", "page001_img002.jpeg"],
    3: ["page003_img001.png"],
}, by_page

appendix = mod.build_image_appendix(by_page)
assert "## Extracted Images" in appendix
assert appendix.index("### Page 1") < appendix.index("### Page 3")
assert mod.build_image_appendix({}) == ""

out_folder = work / "rendered_pdf"
sys.argv = ["convert_pdf_to_md.py", str(pdf_file), "-o", str(out_folder)]
with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
    assert mod.main() == mod.EXIT_OK

md_output = (out_folder / "whitepaper.md").read_text(encoding="utf-8")
assert md_output.startswith("# Whitepaper\\n\\nBody paragraph.\\n\\n## Extracted Images\\n")
assert "![page001_img002.jpeg](img/page001_img002.jpeg)" in md_output
assert (out_folder / "img" / "page003_img001.png").read_bytes() == b"IMG_A"

# Validation errors for wrong extension and missing path
wrong_ext = work / "notes.md"
wrong_ext.write_text("hi", encoding="utf-8")
sys.argv = ["convert_pdf_to_md.py", str(wrong_ext)]
with redirect_stderr(io.StringIO()):
    assert mod.main() == mod.EXIT_INVALID_INPUT

print("OK")
`;

  const check = runPython(["-c", pyDriver], { cwd: dir });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal(check.stdout.trim(), "OK");
});

test("publish-to-pages convert-pptx.py and convert-pdf.py render HTML slides, escape entities, and switch to external assets offline", (t) => {
  if (runPython(["--version"]).status !== 0) {
    t.skip("python3 is not available");
    return;
  }

  const dir = makeTempDir(t, "publish-pages-conv-");
  const pptxScript = path.join(SKILLS_ROOT, "publish-to-pages", "scripts", "convert-pptx.py");
  const pdfScript = path.join(SKILLS_ROOT, "publish-to-pages", "scripts", "convert-pdf.py");

  // 1. Test convert-pptx.py helpers and full convert() with a deterministic stub python-pptx module
  const pptxDriver = `
import importlib.util, io, pathlib, sys, types
from xml.etree import ElementTree as ET
from contextlib import redirect_stdout

# Build stub pptx package before loading convert-pptx.py
pptx_mod = types.ModuleType("pptx")
enum_mod = types.ModuleType("pptx.enum")
text_mod = types.ModuleType("pptx.enum.text")
oxml_mod = types.ModuleType("pptx.oxml")
ns_mod = types.ModuleType("pptx.oxml.ns")

class PP_ALIGN:
    CENTER = 2
    RIGHT = 3
    JUSTIFY = 4
text_mod.PP_ALIGN = PP_ALIGN

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
}
def qn(tag):
    prefix, local = tag.split(":")
    return f"{{{NS[prefix]}}}{local}"
ns_mod.qn = qn

fake_slides = []
class FakePresentation:
    def __init__(self, _path):
        self.slide_width = 1280
        self.slide_height = 720
        self.slides = fake_slides

pptx_mod.Presentation = FakePresentation
sys.modules["pptx"] = pptx_mod
sys.modules["pptx.enum"] = enum_mod
sys.modules["pptx.enum.text"] = text_mod
sys.modules["pptx.oxml"] = oxml_mod
sys.modules["pptx.oxml.ns"] = ns_mod

spec = importlib.util.spec_from_file_location("convert_pptx", ${JSON.stringify(pptxScript)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

assert mod.rgb_to_hex(None) is None
assert mod.rgb_to_hex("1A2B3C") == "#1A2B3C"
assert mod.get_shape_position(types.SimpleNamespace(left=320, top=180, width=640, height=360), 1280, 720) == (25.0, 25.0, 50.0, 50.0)
# Division by zero triggers fallback (5, 5, 90, 40)
assert mod.get_shape_position(types.SimpleNamespace(left=10, top=10, width=10, height=10), 0, 0) == (5, 5, 90, 40)

run_styled = types.SimpleNamespace(
    text="A & <B> > C",
    font=types.SimpleNamespace(
        bold=True,
        italic=True,
        underline=True,
        size=types.SimpleNamespace(pt=18),
        color=types.SimpleNamespace(rgb="FF5500"),
        name="Calibri",
    ),
)
para = types.SimpleNamespace(alignment=PP_ALIGN.CENTER, runs=[run_styled, types.SimpleNamespace(text="", font=None)])
rendered_p = mod.render_paragraph(para)
assert "text-align:center" in rendered_p
assert "A &amp; &lt;B&gt; &gt; C" in rendered_p
assert "font-weight:bold" in rendered_p and "color:#FF5500" in rendered_p

# Build slide shapes: title text box with solidFill, table with HTML chars, and PNG picture
bg_xml = ET.fromstring(f'<p:bg xmlns:p="{NS["p"]}" xmlns:a="{NS["a"]}"><a:solidFill><a:srgbClr val="102030"/></a:solidFill></p:bg>')
shape_fill_xml = ET.fromstring(f'<p:sp xmlns:p="{NS["p"]}" xmlns:a="{NS["a"]}"><p:spPr><a:solidFill><a:srgbClr val="AABBCC"/></a:solidFill></p:spPr></p:sp>')

title_shape = types.SimpleNamespace(
    top=20, left=40, width=600, height=100,
    shape_type=1, has_table=False, has_text_frame=True,
    text="Quarterly <Deck>",
    text_frame=types.SimpleNamespace(paragraphs=[para]),
    _element=shape_fill_xml,
)
table_shape = types.SimpleNamespace(
    top=200, left=40, width=600, height=200,
    shape_type=19, has_table=True, has_text_frame=False,
    table=types.SimpleNamespace(rows=[
        types.SimpleNamespace(cells=[types.SimpleNamespace(text="R&D <1>")])
    ]),
    _element=ET.fromstring("<sp/>"),
)
img_shape = types.SimpleNamespace(
    top=100, left=700, width=300, height=200,
    shape_type=13, has_table=False, has_text_frame=False,
    image=types.SimpleNamespace(blob=b"PNG_SLIDE_IMG", content_type="image/png"),
    _element=ET.fromstring("<pic/>"),
)
slide = types.SimpleNamespace(
    background=types.SimpleNamespace(_element=bg_xml),
    slide_layout=types.SimpleNamespace(background=types.SimpleNamespace(_element=ET.fromstring("<bg/>"))),
    shapes=[table_shape, img_shape, title_shape],
)
fake_slides.append(slide)

work = pathlib.Path(${JSON.stringify(dir)})
dummy_pptx = work / "deck.pptx"
dummy_pptx.write_bytes(b"PK-synthetic")

# Inline base64 mode
inline_html = work / "inline.html"
with redirect_stdout(io.StringIO()):
    mod.convert(str(dummy_pptx), str(inline_html), external_assets=False)
inline_text = inline_html.read_text(encoding="utf-8")
assert "background-color:#102030" in inline_text
assert "background-color:#AABBCC" in inline_text
assert "R&amp;D &lt;1>" in inline_text
assert "data:image/png;base64," in inline_text

# External assets mode writes assets/img-001.png
ext_dir = work / "ext_mode"
ext_dir.mkdir()
ext_html = ext_dir / "deck.html"
with redirect_stdout(io.StringIO()):
    mod.convert(str(dummy_pptx), str(ext_html), external_assets=True)
assert 'src="assets/img-001.png"' in ext_html.read_text(encoding="utf-8")
assert (ext_dir / "assets" / "img-001.png").read_bytes() == b"PNG_SLIDE_IMG"
print("OK")
`;

  const pptxOutcome = runPython(["-c", pptxDriver], { cwd: dir });
  assert.equal(pptxOutcome.status, 0, pptxOutcome.stdout + pptxOutcome.stderr);
  assert.equal(pptxOutcome.stdout.trim(), "OK");

  if (process.platform === "win32") {
    return;
  }

  // 2. Test convert-pdf.py on POSIX using local executable stubs for pdfinfo and pdftoppm
  const stubBin = path.join(dir, "stub-bin");
  fs.mkdirSync(stubBin, { recursive: true });
  const pdfinfoStub = path.join(stubBin, "pdfinfo");
  const pdftoppmStub = path.join(stubBin, "pdftoppm");

  fs.writeFileSync(
    pdfinfoStub,
    `#!/usr/bin/env bash
echo "Title: Demo"
echo "Pages: \${FAKE_PDF_PAGES:-2}"
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    pdftoppmStub,
    `#!/usr/bin/env bash
if [[ "\${FAKE_PDFTOPPM_EMPTY:-0}" == "1" ]]; then
  exit 0
fi
prefix="\${@: -1}"
printf 'PNG1' > "\${prefix}-1.png"
printf 'PNG2' > "\${prefix}-2.png"
`,
    { mode: 0o755 },
  );

  const samplePdf = path.join(dir, "my-pitch_deck.pdf");
  fs.writeFileSync(samplePdf, "%PDF-1.4 sample", "utf8");
  const pathWithStubs = `${stubBin}:${process.env.PATH || "/usr/bin:/bin"}`;

  // Missing PDF exits 1
  assert.equal(
    runPython([pdfScript, path.join(dir, "missing.pdf")], { env: { PATH: pathWithStubs } }).status,
    1,
  );

  // Empty directory without pdftoppm on PATH exits 1
  const emptyBin = path.join(dir, "empty-bin");
  fs.mkdirSync(emptyBin);
  const whichSource = ["/usr/bin/which", "/bin/which"].find((p) => fs.existsSync(p));
  if (whichSource) {
    fs.symlinkSync(whichSource, path.join(emptyBin, "which"));
    const noPoppler = runPython([pdfScript, samplePdf], { env: { PATH: emptyBin } });
    assert.equal(noPoppler.status, 1);
    assert.match(noPoppler.stdout, /pdftoppm not found/);
  }

  // Auto-enables external assets when pdfinfo reports > 50 pages
  const autoExtDir = path.join(dir, "pdf-auto-ext");
  fs.mkdirSync(autoExtDir);
  const autoExtHtml = path.join(autoExtDir, "slides.html");
  const autoExtOutcome = runPython([pdfScript, samplePdf, autoExtHtml], {
    env: { PATH: pathWithStubs, FAKE_PDF_PAGES: "55" },
  });
  assert.equal(autoExtOutcome.status, 0, autoExtOutcome.stdout + autoExtOutcome.stderr);
  assert.match(autoExtOutcome.stdout, /Auto-enabling external assets mode/);
  const renderedAutoHtml = fs.readFileSync(autoExtHtml, "utf8");
  assert.match(renderedAutoHtml, /<title>my pitch deck<\/title>/);
  assert.match(renderedAutoHtml, /src="assets\/img-001\.png"/);
  assert.equal(fs.readFileSync(path.join(autoExtDir, "assets", "img-002.png"), "utf8"), "PNG2");

  // Forced --no-external-assets embeds base64 inline even when pages > 50
  const forcedInlineHtml = path.join(dir, "forced-inline.html");
  const forcedOutcome = runPython([pdfScript, samplePdf, forcedInlineHtml, "--no-external-assets"], {
    env: { PATH: pathWithStubs, FAKE_PDF_PAGES: "55" },
  });
  assert.equal(forcedOutcome.status, 0, forcedOutcome.stdout + forcedOutcome.stderr);
  assert.match(fs.readFileSync(forcedInlineHtml, "utf8"), /data:image\/png;base64,/);

  // Zero rendered pages exits 1
  const zeroPagesOutcome = runPython([pdfScript, samplePdf, path.join(dir, "zero.html")], {
    env: { PATH: pathWithStubs, FAKE_PDFTOPPM_EMPTY: "1" },
  });
  assert.equal(zeroPagesOutcome.status, 1);
  assert.match(zeroPagesOutcome.stdout, /No pages rendered from PDF/);
});
