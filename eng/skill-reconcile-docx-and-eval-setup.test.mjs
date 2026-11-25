import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import { ROOT_FOLDER } from "./constants.mjs";

const SUBPROCESS_TIMEOUT_MS = 10_000;
const SKILLS_ROOT = path.join(ROOT_FOLDER, "skills");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function makeTempDir(t, prefix = "awesome-copilot-skill-p9-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const PYTHON_INFO = (() => {
  const probe = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-c",
      "import json, sys; print(json.dumps({'executable': sys.executable, 'version': list(sys.version_info[:3])}))",
    ],
    { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS },
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

function ensurePython(t, minMajor = 3, minMinor = 10) {
  if (!PYTHON_INFO) {
    t.skip("python3 is not available");
    return false;
  }
  const [major, minor] = PYTHON_INFO.version;
  if (major < minMajor || (major === minMajor && minor < minMinor)) {
    t.skip(`python3 >= ${minMajor}.${minMinor} required, found ${major}.${minor}`);
    return false;
  }
  return true;
}

function runPy(args, { cwd, env = {}, input } = {}) {
  return spawnSync(PYTHON_INFO?.executable ?? "python3", ["-I", "-S", "-B", ...args], {
    cwd,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env },
    input,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
}

function buildMinimalPng(width, height) {
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[i] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) {
      c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const typeBuf = Buffer.from(type, "ascii");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  };

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rawScanlines = Buffer.alloc(height * (1 + 3 * width));
  const idat = deflateSync(rawScanlines);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function createDocxMarkdownLexer() {
  function parseInline(text) {
    const tokens = [];
    const pattern =
      /(\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]*)\]\(([^)]+)\)|<br\s*\/?>|~~([^~]+)~~)/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) {
        const plain = text.slice(last, match.index);
        tokens.push({ type: "text", text: plain, raw: plain });
      }
      if (match[2] !== undefined) {
        tokens.push({
          type: "strong",
          tokens: [{ type: "em", tokens: [{ type: "text", text: match[2], raw: match[2] }] }],
        });
      } else if (match[3] !== undefined) {
        tokens.push({ type: "strong", tokens: parseInline(match[3]) });
      } else if (match[4] !== undefined) {
        tokens.push({ type: "em", tokens: parseInline(match[4]) });
      } else if (match[5] !== undefined) {
        tokens.push({ type: "codespan", text: match[5], raw: match[0] });
      } else if (match[6] !== undefined) {
        tokens.push({ type: "image", text: match[6], href: match[7], raw: match[0] });
      } else if (match[8] !== undefined) {
        tokens.push({ type: "link", text: match[8], href: match[9], raw: match[0] });
      } else if (match[10] !== undefined) {
        tokens.push({ type: "del", raw: match[10] });
      } else {
        tokens.push({ type: "br", raw: match[0] });
      }
      last = pattern.lastIndex;
    }
    if (last < text.length) {
      const tail = text.slice(last);
      tokens.push({ type: "text", text: tail, raw: tail });
    }
    return tokens;
  }

  return function lexer(markdown) {
    const lines = markdown.replace(/\r\n/g, "\n").split("\n");
    const tokens = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        tokens.push({ type: "space", raw: "\n" });
        i += 1;
        continue;
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        tokens.push({
          type: "heading",
          depth: headingMatch[1].length,
          text: headingMatch[2].trim(),
          raw: line,
        });
        i += 1;
        continue;
      }

      if (/^---+\s*$/.test(line)) {
        tokens.push({ type: "hr", raw: line });
        i += 1;
        continue;
      }

      const fenceMatch = line.match(/^```(\w*)\s*$/);
      if (fenceMatch) {
        const lang = fenceMatch[1] || "";
        const body = [];
        i += 1;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          body.push(lines[i]);
          i += 1;
        }
        i += 1;
        tokens.push({ type: "code", lang, text: body.join("\n") });
        continue;
      }

      if (line.startsWith("|") && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const splitCells = (rowLine) =>
          rowLine
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((cell) => ({ text: cell.trim(), tokens: parseInline(cell.trim()) }));
        const header = splitCells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].startsWith("|")) {
          rows.push(splitCells(lines[i]));
          i += 1;
        }
        tokens.push({ type: "table", header, rows });
        continue;
      }

      const listMatch = line.match(/^(\d+\.|-)\s+(.+)$/);
      if (listMatch) {
        const ordered = listMatch[1] !== "-";
        const items = [];
        while (i < lines.length) {
          const itemMatch = lines[i].match(/^(\d+\.|-)\s+(.+)$/);
          if (!itemMatch || (itemMatch[1] !== "-") !== ordered) break;
          const itemRaw = lines[i];
          const itemText = itemMatch[2];
          const itemTokens = [{ type: "text", text: itemText, tokens: parseInline(itemText) }];
          i += 1;
          const subItems = [];
          while (i < lines.length) {
            const subMatch = lines[i].match(/^\s{2,}(-|\d+\.)\s+(.+)$/);
            if (!subMatch) break;
            subItems.push({
              raw: lines[i].trim(),
              text: subMatch[2],
              tokens: [{ type: "text", text: subMatch[2], tokens: parseInline(subMatch[2]) }],
            });
            i += 1;
          }
          if (subItems.length > 0) {
            itemTokens.push({
              type: "list",
              ordered: /^\d+\./.test(subItems[0].raw),
              items: subItems,
            });
          }
          items.push({ raw: itemRaw, text: itemText, tokens: itemTokens });
        }
        tokens.push({ type: "list", ordered, items });
        continue;
      }

      if (line.startsWith("> ")) {
        tokens.push({ type: "blockquote", raw: line.slice(2) });
        i += 1;
        continue;
      }

      tokens.push({
        type: "paragraph",
        text: line,
        raw: line,
        tokens: parseInline(line),
      });
      i += 1;
    }

    return tokens;
  };
}

test("sql-server-table-reconciliation reconcile.py resolves wildcards, detects schema/PK/row drift, and exports reports offline", (t) => {
  if (!ensurePython(t)) return;

  const dir = makeTempDir(t, "sql-reconcile-");
  const scriptPath = path.join(SKILLS_ROOT, "sql-server-table-reconciliation", "scripts", "reconcile.py");

  const driver = `
import builtins, csv, importlib.util, io, json, math, os, pathlib, sys, types
from contextlib import redirect_stdout

base = pathlib.Path(${JSON.stringify(dir)})
os.chdir(base)

def _is_null(v):
    return v is None or (isinstance(v, float) and math.isnan(v))

class MiniIndex:
    def __init__(self, values):
        self._values = list(values)
    def tolist(self):
        return list(self._values)
    def __iter__(self):
        return iter(self._values)
    def __contains__(self, item):
        return item in self._values
    def isin(self, allowed):
        allowed_set = set(allowed)
        return [v in allowed_set for v in self._values]

class MiniLoc:
    def __init__(self, df):
        self._df = df
    def __getitem__(self, key):
        if isinstance(key, tuple):
            row_sel, col_sel = key
            selected_rows = [
                (idx, row) for (idx, row), keep in zip(zip(self._df._index, self._df._rows), row_sel) if keep
            ]
            new_rows = [{c: r.get(c) for c in col_sel} for _, r in selected_rows]
            return MiniDataFrame(new_rows, index=[idx for idx, _ in selected_rows], columns=list(col_sel))
        for idx, row in zip(self._df._index, self._df._rows):
            if idx == key:
                return row
        raise KeyError(key)

class MiniDataFrame:
    def __init__(self, rows, index=None, columns=None):
        self._rows = [dict(r) for r in rows]
        self._index = list(range(len(self._rows))) if index is None else list(index)
        if columns is not None:
            self.columns = list(columns)
        elif self._rows:
            self.columns = list(self._rows[0].keys())
        else:
            self.columns = []
    @property
    def index(self):
        return MiniIndex(self._index)
    @property
    def loc(self):
        return MiniLoc(self)
    def __len__(self):
        return len(self._rows)
    def __getitem__(self, col):
        return [r.get(col) for r in self._rows]
    def set_index(self, cols):
        key_cols = [cols] if isinstance(cols, str) else list(cols)
        new_index = []
        new_rows = []
        for r in self._rows:
            idx = r[key_cols[0]] if len(key_cols) == 1 else tuple(r[k] for k in key_cols)
            new_index.append(idx)
            new_rows.append({k: v for k, v in r.items() if k not in key_cols})
        rem_cols = [c for c in self.columns if c not in key_cols]
        return MiniDataFrame(new_rows, index=new_index, columns=rem_cols)
    def compare(self, other, keep_shape=False):
        other_map = {idx: row for idx, row in zip(other._index, other._rows)}
        diffs = []
        for idx, row in zip(self._index, self._rows):
            orow = other_map.get(idx, {})
            changed = {}
            for col in self.columns:
                a, b = row.get(col), orow.get(col)
                if _is_null(a) and _is_null(b):
                    continue
                if a != b:
                    changed[col] = (a, b)
            if changed:
                diffs.append(changed)
        return MiniDataFrame(diffs)
    def to_csv(self, filename, index=False):
        with open(filename, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=self.columns)
            writer.writeheader()
            writer.writerows(self._rows)

class MiniArrowColumn:
    def __init__(self, values):
        self._values = list(values)
    def to_pylist(self):
        return list(self._values)

class MiniArrowTable:
    def __init__(self, rows, columns=None):
        self._rows = [dict(r) for r in rows]
        self._columns = columns or (list(self._rows[0].keys()) if self._rows else [])
    def to_pandas(self):
        return MiniDataFrame(self._rows, columns=self._columns)
    def column(self, name):
        return MiniArrowColumn([r.get(name) for r in self._rows])

# Install synthetic modules before loading reconcile.py
pd_mod = types.ModuleType("pandas")
pd_mod.DataFrame = MiniDataFrame
pa_mod = types.ModuleType("pyarrow")
pc_mod = types.ModuleType("pyarrow.compute")
pa_mod.compute = pc_mod
mssql_mod = types.ModuleType("mssql_python")

recorded_conn_strings = []
db_fixtures = {}

class FakeCursor:
    def __init__(self, db_name):
        self.db_name = db_name
        self.last_query = ""
        self.last_params = None
        self._result = MiniArrowTable([])
    def execute(self, query, params=None):
        self.last_query = " ".join(query.split())
        self.last_params = params
        fx = db_fixtures[self.db_name]
        fx["queries"].append((self.last_query, params))
        if "INFORMATION_SCHEMA.TABLES" in self.last_query:
            schema = params[0]
            self._result = MiniArrowTable([{"TABLE_NAME": t} for t in fx["tables"].get(schema, [])], columns=["TABLE_NAME"])
        elif "INFORMATION_SCHEMA.COLUMNS" in self.last_query:
            key = f"{params[0]}.{params[1]}"
            self._result = MiniArrowTable(fx["schemas"].get(key, []), columns=["COLUMN_NAME", "DATA_TYPE", "IS_NULLABLE"])
        elif "sys.indexes" in self.last_query:
            key = f"{params[0]}.{params[1]}"
            self._result = MiniArrowTable([{"name": c} for c in fx["pks"].get(key, [])], columns=["name"])
        elif "HASHBYTES(" in self.last_query:
            self._result = MiniArrowTable([{"id": 1, "row_hash": b"hash1"}], columns=["id", "row_hash"])
        elif "SELECT * FROM " in self.last_query:
            tbl = self.last_query.split("SELECT * FROM ")[1].split(" ORDER BY ")[0]
            self._result = MiniArrowTable(fx["rows"].get(tbl, []))
    def arrow(self):
        return self._result

class FakeConn:
    def __init__(self, db_name):
        self.db_name = db_name
    def cursor(self):
        return FakeCursor(self.db_name)

def fake_connect(conn_str):
    recorded_conn_strings.append(conn_str)
    for part in conn_str.split(";"):
        if part.startswith("Database="):
            return FakeConn(part.split("=", 1)[1])
    return FakeConn("default")

mssql_mod.connect = fake_connect
sys.modules["pandas"] = pd_mod
sys.modules["pyarrow"] = pa_mod
sys.modules["pyarrow.compute"] = pc_mod
sys.modules["mssql_python"] = mssql_mod

spec = importlib.util.spec_from_file_location("reconcile_mod", ${JSON.stringify(scriptPath)})
rec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rec)

db_fixtures["SourceDB"] = {
    "queries": [],
    "tables": {"dbo": ["AuditLog", "Orders", "OrderLines"]},
    "schemas": {
        "dbo.Orders": [
            {"COLUMN_NAME": "OrderId", "DATA_TYPE": "int", "IS_NULLABLE": "NO"},
            {"COLUMN_NAME": "Status", "DATA_TYPE": "varchar", "IS_NULLABLE": "YES"},
            {"COLUMN_NAME": "LegacyFlag", "DATA_TYPE": "bit", "IS_NULLABLE": "YES"},
        ],
        "dbo.OrderLines": [
            {"COLUMN_NAME": "OrderId", "DATA_TYPE": "int", "IS_NULLABLE": "NO"},
            {"COLUMN_NAME": "LineNo", "DATA_TYPE": "int", "IS_NULLABLE": "NO"},
            {"COLUMN_NAME": "Notes", "DATA_TYPE": "nvarchar", "IS_NULLABLE": "YES"},
        ],
        "dbo.AuditLog": [
            {"COLUMN_NAME": "Message", "DATA_TYPE": "nvarchar", "IS_NULLABLE": "YES"},
        ],
    },
    "pks": {
        "dbo.Orders": ["OrderId"],
        "dbo.OrderLines": [],  # falls back to target PK detection
        "dbo.AuditLog": [],
    },
    "rows": {
        "dbo.Orders": [
            {"OrderId": 1, "Status": "SHIPPED", "LegacyFlag": 1},
            {"OrderId": 2, "Status": None, "LegacyFlag": 0},
            {"OrderId": 3, "Status": "PENDING", "LegacyFlag": 0},
        ],
        "dbo.OrderLines": [
            {"OrderId": 10, "LineNo": 1, "Notes": None},
            {"OrderId": 10, "LineNo": 2, "Notes": "Rush"},
        ],
    },
}

db_fixtures["TargetDB"] = {
    "queries": [],
    "tables": {"dbo": ["AuditLog", "Orders", "OrderLines"]},
    "schemas": {
        "dbo.Orders": [
            {"COLUMN_NAME": "OrderId", "DATA_TYPE": "int", "IS_NULLABLE": "NO"},
            {"COLUMN_NAME": "Status", "DATA_TYPE": "nvarchar", "IS_NULLABLE": "YES"},
            {"COLUMN_NAME": "SyncedAt", "DATA_TYPE": "datetime2", "IS_NULLABLE": "YES"},
        ],
        "dbo.OrderLines": [
            {"COLUMN_NAME": "OrderId", "DATA_TYPE": "int", "IS_NULLABLE": "NO"},
            {"COLUMN_NAME": "LineNo", "DATA_TYPE": "int", "IS_NULLABLE": "NO"},
            {"COLUMN_NAME": "Notes", "DATA_TYPE": "nvarchar", "IS_NULLABLE": "YES"},
        ],
        "dbo.AuditLog": [
            {"COLUMN_NAME": "Message", "DATA_TYPE": "nvarchar", "IS_NULLABLE": "YES"},
        ],
    },
    "pks": {
        "dbo.Orders": ["OrderId"],
        "dbo.OrderLines": ["OrderId", "LineNo"],
        "dbo.AuditLog": [],
    },
    "rows": {
        "dbo.Orders": [
            {"OrderId": 1, "Status": "DELIVERED", "SyncedAt": "2026-01-01"},
            {"OrderId": 2, "Status": None, "SyncedAt": "2026-01-01"},
            {"OrderId": 4, "Status": "NEW", "SyncedAt": "2026-01-02"},
        ],
        "dbo.OrderLines": [
            {"OrderId": 10, "LineNo": 1, "Notes": None},
            {"OrderId": 10, "LineNo": 2, "Notes": "Rush"},
        ],
    },
}

# 1. Connection string generation: SQL env/prompt vs Entra
os.environ.pop("MSSQL_USER", None)
os.environ.pop("MSSQL_PASSWORD", None)
orig_input = builtins.input
builtins.input = lambda _prompt="": "prompt-user"
rec.getpass = lambda _prompt="": "test-password"
try:
    rec.connect("sql-a.example.net", "SourceDB", "sql")
finally:
    builtins.input = orig_input
assert "UID=prompt-user;PWD=test-password;" in recorded_conn_strings[-1]

rec.connect("sql-b.example.net", "TargetDB", "entra")
assert "Authentication=ActiveDirectoryDefault;" in recorded_conn_strings[-1]

# 2. Wildcard + explicit table resolution and hash extraction query
src_conn = FakeConn("SourceDB")
resolved = rec.resolve_tables(src_conn, "dbo.*, sales.Summary")
assert resolved == ["dbo.AuditLog", "dbo.Orders", "dbo.OrderLines", "sales.Summary"]

hash_arrow = rec.extract_hashes(src_conn, "dbo.Orders", ["OrderId"], ["Status", "LegacyFlag"])
assert hash_arrow.column("row_hash").to_pylist() == [b"hash1"]
assert "HASHBYTES('SHA2_256', CONCAT_WS('|', Status, LegacyFlag))" in db_fixtures["SourceDB"]["queries"][-1][0]

# 3. Full CLI main() run with JSON export, then CSV export
sys.argv = [
    "reconcile.py",
    "--source-server", "src.example.net",
    "--source-database", "SourceDB",
    "--target-server", "tgt.example.net",
    "--target-database", "TargetDB",
    "--tables", "dbo.*",
    "--auth", "entra",
    "--output", "json",
]
buf = io.StringIO()
with redirect_stdout(buf):
    rec.main()

out = buf.getvalue()
assert "=== Summary: 1 passed, 1 failed, 1 skipped / 3 tables ===" in out
assert "Columns only in source: ['LegacyFlag']" in out
assert "Columns only in target: ['SyncedAt']" in out
assert "Status: type varchar vs nvarchar" in out
assert "SKIPPED: No PK detected" in out

json_rows = json.loads((base / "reconciliation_report.json").read_text(encoding="utf-8"))
by_table = {r["table"]: r for r in json_rows}
assert by_table["dbo.AuditLog"]["status"] == "SKIPPED"
assert by_table["dbo.Orders"] == {
    "table": "dbo.Orders",
    "status": "FAIL",
    "source_rows": 3,
    "target_rows": 3,
    "missing": 1,
    "extra": 1,
    "mismatches": 1,  # OrderId=2 has NULL==NULL so only OrderId=1 mismatches
}
assert by_table["dbo.OrderLines"]["status"] == "PASS"

# CSV export branch
csv_buf = io.StringIO()
with redirect_stdout(csv_buf):
    rec.generate_report([
        rec.reconcile_table(FakeConn("SourceDB"), FakeConn("TargetDB"), "dbo.OrderLines"),
    ], output_format="csv")
csv_text = (base / "reconciliation_report.csv").read_text(encoding="utf-8")
assert "dbo.OrderLines,PASS,2,2,0,0,0" in csv_text
print("SQL_RECONCILE_OK")
`;

  const res = runPy(["-c", driver], { cwd: dir });
  assert.equal(res.status, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /SQL_RECONCILE_OK/);
});

test("md-to-docx CLI parses front-matter, builds TOC/tables/lists/mermaid blocks, and scales PNG images offline", async (t) => {
  const dir = makeTempDir(t, "md-to-docx-");
  const scriptPath = path.join(SKILLS_ROOT, "md-to-docx", "scripts", "md-to-docx.mjs");
  const rawSource = fs.readFileSync(scriptPath, "utf8");

  // Transform top-level ESM imports into an injectable async runner while keeping 100% of converter logic intact
  const bodySource = rawSource
    .replace(/^import\s+\{[^}]+\}\s+from\s+"fs";\s*$/m, "")
    .replace(/^import\s+\{[^}]+\}\s+from\s+"path";\s*$/m, "")
    .replace(/^import\s+\{[^}]+\}\s+from\s+"marked";\s*$/m, "")
    .replace(/^import\s+\{[\s\S]*?\}\s+from\s+"docx";\s*$/m, "");

  const runner = new AsyncFunction(
    "deps",
    `
    const {
      readFileSync, writeFileSync, existsSync,
      dirname, join, resolve,
      marked,
      Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun,
      TableRow, TableCell, Table, WidthType, BorderStyle,
      AlignmentType, ShadingType, PageBreak,
      process, console,
    } = deps;
    ${bodySource}
    `,
  );

  function createDocxMocks() {
    const captured = { documents: [], logs: [], errors: [] };
    class NodeRecord {
      constructor(kind, opts = {}) {
        this.kind = kind;
        Object.assign(this, opts);
      }
    }
    return {
      captured,
      Document: class extends NodeRecord {
        constructor(opts) {
          super("Document", opts);
          captured.documents.push(this);
        }
      },
      Packer: {
        async toBuffer(doc) {
          return Buffer.from(JSON.stringify({ sectionCount: doc.sections.length }), "utf8");
        },
      },
      Paragraph: class extends NodeRecord {
        constructor(opts) {
          super("Paragraph", opts);
        }
      },
      TextRun: class extends NodeRecord {
        constructor(opts) {
          super("TextRun", opts);
        }
      },
      ImageRun: class extends NodeRecord {
        constructor(opts) {
          super("ImageRun", opts);
        }
      },
      TableRow: class extends NodeRecord {
        constructor(opts) {
          super("TableRow", opts);
        }
      },
      TableCell: class extends NodeRecord {
        constructor(opts) {
          super("TableCell", opts);
        }
      },
      Table: class extends NodeRecord {
        constructor(opts) {
          super("Table", opts);
        }
      },
      PageBreak: class extends NodeRecord {
        constructor() {
          super("PageBreak", {});
        }
      },
      HeadingLevel: {
        HEADING_1: "H1",
        HEADING_2: "H2",
        HEADING_3: "H3",
        HEADING_4: "H4",
      },
      WidthType: { PERCENTAGE: "pct" },
      BorderStyle: { SINGLE: "single" },
      AlignmentType: { CENTER: "center" },
      ShadingType: { SOLID: "solid" },
      console: {
        log: (...args) => captured.logs.push(args.join(" ")),
        error: (...args) => captured.errors.push(args.join(" ")),
      },
    };
  }

  const lexer = createDocxMarkdownLexer();

  // 1. Missing CLI argument exits 1 with usage error
  {
    const mocks = createDocxMocks();
    class ExitError extends Error {
      constructor(code) {
        super(`exit:${code}`);
        this.code = code;
      }
    }
    await assert.rejects(
      () =>
        runner({
          readFileSync: fs.readFileSync,
          writeFileSync: fs.writeFileSync,
          existsSync: fs.existsSync,
          dirname: path.dirname,
          join: path.join,
          resolve: path.resolve,
          marked: { lexer },
          ...mocks,
          process: {
            argv: ["node", "md-to-docx.mjs"],
            exit(code) {
              throw new ExitError(code);
            },
          },
        }),
      (err) => err.code === 1,
    );
    assert.match(mocks.captured.errors[0], /Usage: node md-to-docx\.mjs/);
  }

  // 2. Full Markdown document with front-matter, manual TOC section, PNG + non-PNG + missing images, mermaid, table, and nested lists
  const widePngPath = path.join(dir, "diagram.png");
  fs.writeFileSync(widePngPath, buildMinimalPng(1160, 400));
  const nonPngPath = path.join(dir, "photo.jpg");
  fs.writeFileSync(nonPngPath, Buffer.from("not-a-png-header", "utf8"));

  const mdPath = path.join(dir, "spec.md");
  fs.writeFileSync(
    mdPath,
    [
      "---",
      'title: "System Manual — Cloud Edition"',
      "date: 2026-04-10",
      "version: 2.3",
      "audience: Platform Engineers",
      "---",
      "",
      "# System Manual — Cloud Edition",
      "",
      "## Table of Contents",
      "",
      "- Ignored manual TOC bullet",
      "",
      "### Ignored manual TOC subsection",
      "",
      "## Overview &amp; Scope",
      "",
      "Paragraph with **bold**, *italic*, ***both***, `code()`, [Docs](https://example.com), ~~legacy~~, and &lt;tags&gt;<br>next line.",
      "",
      "![Architecture Diagram](diagram.png)",
      "",
      "![](photo.jpg)",
      "",
      "![Missing Asset](does-not-exist.png)",
      "",
      "| Service | Tier |",
      "| --- | --- |",
      "| Gateway | Edge |",
      "| Worker | Core |",
      "",
      "```mermaid",
      "graph TD; A-->B;",
      "```",
      "",
      "```js",
      "const ok = true;",
      "",
      "```",
      "",
      "1. First ordered",
      "  - Nested bullet",
      "",
      "> Quoted &quot;callout&quot; &#39;note&#39;",
      "",
      "---",
      "",
      "#### Deep Heading",
    ].join("\n"),
    "utf8",
  );

  const mocks = createDocxMocks();
  await runner({
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    existsSync: fs.existsSync,
    dirname: path.dirname,
    join: path.join,
    resolve: path.resolve,
    marked: { lexer },
    ...mocks,
    process: {
      argv: ["node", "md-to-docx.mjs", mdPath],
      exit(code) {
        throw new Error(`unexpected exit ${code}`);
      },
    },
  });

  const defaultDocxPath = path.join(dir, "spec.docx");
  assert.equal(fs.existsSync(defaultDocxPath), true);
  assert.match(mocks.captured.logs[0], /Generated: .*spec\.docx/);

  const doc = mocks.captured.documents[0];
  const children = doc.sections[0].children;
  const allTexts = children
    .flatMap((node) => (node.children || []).map((c) => c.text).filter(Boolean));

  // Title page metadata + static TOC + skipped manual TOC body
  assert.equal(allTexts.includes("System Manual"), true);
  assert.equal(allTexts.includes("Cloud Edition"), true);
  assert.equal(allTexts.includes("Date: 2026-04-10  |  Version: 2.3"), true);
  assert.equal(allTexts.includes("Audience: Platform Engineers"), true);
  assert.equal(allTexts.includes("Overview & Scope"), true);
  assert.equal(allTexts.some((txt) => txt.includes("Ignored manual TOC bullet")), false);
  assert.equal(
    allTexts.filter((txt) => txt === "Ignored manual TOC subsection").length,
    1, // appears only in static TOC pre-scan, skipped in document body via skipToc
  );

  // Mermaid placeholder, missing-image notice, decoded blockquote, and H4 mapping
  assert.equal(
    allTexts.includes("[Diagram: See source .md file for interactive Mermaid diagram]"),
    true,
  );
  assert.equal(allTexts.includes("[Image not found: does-not-exist.png]"), true);
  assert.equal(allTexts.includes('Quoted "callout" \'note\''), true);
  assert.equal(allTexts.includes("Architecture Diagram"), true);

  // Image scaling: 1160x400 -> 580x200; non-PNG fallback 600x400 -> 580x387
  const imageRuns = children
    .flatMap((node) => node.children || [])
    .filter((c) => c.kind === "ImageRun");
  assert.equal(imageRuns.length, 2);
  assert.deepEqual(imageRuns[0].transformation, { width: 580, height: 200 });
  assert.deepEqual(imageRuns[1].transformation, { width: 580, height: 387 });

  // Table header + alternating row shading
  const tableNode = children.find((node) => node.kind === "Table");
  assert.ok(tableNode);
  assert.equal(tableNode.rows.length, 3);
  assert.equal(tableNode.rows[0].tableHeader, true);
  assert.equal(tableNode.rows[1].children[0].shading, undefined);
  assert.equal(tableNode.rows[2].children[0].shading.fill, "F2F7FB");

  // 3. Fallback H1 subtitle extraction when front-matter is absent
  const h1MdPath = path.join(dir, "plain.md");
  const customOutPath = path.join(dir, "custom-out.docx");
  fs.writeFileSync(h1MdPath, "# Release Plan – Q4 Rollout\n\n## Milestones\n", "utf8");
  const h1Mocks = createDocxMocks();
  await runner({
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    existsSync: fs.existsSync,
    dirname: path.dirname,
    join: path.join,
    resolve: path.resolve,
    marked: { lexer },
    ...h1Mocks,
    process: {
      argv: ["node", "md-to-docx.mjs", h1MdPath, customOutPath],
      exit(code) {
        throw new Error(`unexpected exit ${code}`);
      },
    },
  });
  assert.equal(fs.existsSync(customOutPath), true);
  const h1Texts = h1Mocks.captured.documents[0].sections[0].children.flatMap((n) =>
    (n.children || []).map((c) => c.text).filter(Boolean),
  );
  assert.equal(h1Texts.includes("Q4 Rollout"), true);
});

test("eval-driven-dev setup.sh handles uv/poetry/pip install paths, fallback upgrades, and fatal init/start errors offline", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX shell stubs require non-Windows PATH semantics");
    return;
  }

  const setupSh = path.join(SKILLS_ROOT, "eval-driven-dev", "resources", "setup.sh");
  const binDir = makeTempDir(t, "edd-bin-");
  const logFile = path.join(binDir, "calls.log");

  const writeExecutable = (name, content) => {
    fs.writeFileSync(path.join(binDir, name), content, { mode: 0o755 });
  };

  writeExecutable(
    "npx",
    `#!/bin/sh
echo "npx $*" >> "$EDD_LOG"
exit "\${MOCK_NPX_EXIT:-0}"
`,
  );
  writeExecutable(
    "uv",
    `#!/bin/sh
echo "uv $*" >> "$EDD_LOG"
if [ "$1" = "run" ] && [ "$2" = "python" ]; then
  exit "\${MOCK_PIXIE_PREINSTALLED:-1}"
elif [ "$1" = "add" ]; then
  exit "\${MOCK_UV_ADD_EXIT:-0}"
elif [ "$1" = "pip" ]; then
  exit "\${MOCK_UV_PIP_EXIT:-0}"
elif [ "$1" = "run" ] && [ "$2" = "pixie" ] && [ "$3" = "init" ]; then
  exit "\${MOCK_INIT_EXIT:-0}"
elif [ "$1" = "run" ] && [ "$2" = "pixie" ] && [ "$3" = "start" ]; then
  exit "\${MOCK_START_EXIT:-0}"
fi
exit 0
`,
  );
  writeExecutable(
    "poetry",
    `#!/bin/sh
echo "poetry $*" >> "$EDD_LOG"
if [ "$1" = "run" ] && [ "$2" = "python" ]; then
  exit "\${MOCK_PIXIE_PREINSTALLED:-1}"
elif [ "$1" = "add" ]; then
  exit "\${MOCK_POETRY_ADD_EXIT:-0}"
elif [ "$1" = "run" ] && [ "$2" = "pixie" ] && [ "$3" = "init" ]; then
  exit "\${MOCK_INIT_EXIT:-0}"
elif [ "$1" = "run" ] && [ "$2" = "pixie" ] && [ "$3" = "start" ]; then
  exit "\${MOCK_START_EXIT:-0}"
fi
exit 0
`,
  );
  writeExecutable(
    "python",
    `#!/bin/sh
echo "python $*" >> "$EDD_LOG"
exit "\${MOCK_PIXIE_PREINSTALLED:-1}"
`,
  );
  writeExecutable(
    "pip",
    `#!/bin/sh
echo "pip $*" >> "$EDD_LOG"
exit "\${MOCK_PIP_EXIT:-0}"
`,
  );
  writeExecutable(
    "pixie",
    `#!/bin/sh
echo "pixie $*" >> "$EDD_LOG"
if [ "$1" = "init" ]; then
  exit "\${MOCK_INIT_EXIT:-0}"
elif [ "$1" = "start" ]; then
  exit "\${MOCK_START_EXIT:-0}"
fi
exit 0
`,
  );

  const runSetup = (cwd, extraEnv = {}) =>
    spawnSync("bash", [setupSh], {
      cwd,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        EDD_LOG: logFile,
        ...extraEnv,
      },
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT_MS,
    });

  // 1. uv.lock project: npx failure is non-fatal, uv add failure falls back to uv pip install
  const uvDir = makeTempDir(t, "edd-uv-");
  fs.writeFileSync(path.join(uvDir, "uv.lock"), "", "utf8");
  const uvRun = runSetup(uvDir, {
    MOCK_NPX_EXIT: "1",
    MOCK_UV_ADD_EXIT: "1",
    MOCK_UV_PIP_EXIT: "0",
  });
  assert.equal(uvRun.status, 0, uvRun.stderr);
  assert.match(uvRun.stdout, /skill update failed — proceeding with existing version/);
  assert.match(uvRun.stdout, /uv add failed — falling back to uv pip install/);
  assert.match(uvRun.stdout, /=== Setup complete ===/);

  // 2. poetry.lock project succeeds end-to-end
  const poetryDir = makeTempDir(t, "edd-poetry-");
  fs.writeFileSync(path.join(poetryDir, "poetry.lock"), "", "utf8");
  const poetryRun = runSetup(poetryDir);
  assert.equal(poetryRun.status, 0, poetryRun.stderr);
  assert.match(fs.readFileSync(logFile, "utf8"), /poetry run pixie start/);

  // 3. Plain pip project: fatal when pixie was NOT installed and pip install fails
  const pipDir = makeTempDir(t, "edd-pip-");
  const fatalInstall = runSetup(pipDir, {
    MOCK_PIXIE_PREINSTALLED: "1",
    MOCK_PIP_EXIT: "1",
  });
  assert.equal(fatalInstall.status, 1);
  assert.match(fatalInstall.stdout, /ERROR: pixie-qa is not installed and installation failed/);

  // 4. Upgrade failure is non-fatal when pixie WAS already installed
  const nonFatalUpgrade = runSetup(pipDir, {
    MOCK_PIXIE_PREINSTALLED: "0",
    MOCK_PIP_EXIT: "1",
  });
  assert.equal(nonFatalUpgrade.status, 0, nonFatalUpgrade.stderr);
  assert.match(nonFatalUpgrade.stdout, /pixie-qa upgrade failed — proceeding with existing version/);

  // 5. pixie init and pixie start failures are fatal
  const initFail = runSetup(pipDir, { MOCK_INIT_EXIT: "2" });
  assert.equal(initFail.status, 1);
  assert.match(initFail.stdout, /ERROR: Failed to initialize pixie working directory/);

  const startFail = runSetup(pipDir, { MOCK_START_EXIT: "3" });
  assert.equal(startFail.status, 1);
  assert.match(startFail.stdout, /ERROR: Failed to start the web UI server/);
});

test("datanalysis-credit-risk func.py deduplicates samples, computes OOS org stats, and ranks missing/IV/XLSX reports offline", (t) => {
  if (!ensurePython(t)) return;

  const dir = makeTempDir(t, "credit-risk-func-");
  const funcDir = path.join(SKILLS_ROOT, "datanalysis-credit-risk", "references");

  const driver = `
import csv, io, math, pathlib, sys, types
from contextlib import redirect_stdout

base = pathlib.Path(${JSON.stringify(dir)})

class NaNType:
    pass

NAN = float("nan")

def is_nan(v):
    return v is None or (isinstance(v, float) and math.isnan(v))

class StrAccessor:
    def __init__(self, values):
        self._values = [str(v) for v in values]
    def replace(self, old, new, regex=False):
        return MiniSeries([v.replace(old, new) for v in self._values])
    def __getitem__(self, sl):
        return MiniSeries([v[sl] for v in self._values])

class MiniILoc:
    def __init__(self, values):
        self._values = values
    def __getitem__(self, idx):
        return self._values[idx]

class MiniSeries:
    def __init__(self, values):
        self._values = list(values)
    @property
    def iloc(self):
        return MiniILoc(self._values)
    @property
    def str(self):
        return StrAccessor(self._values)
    def astype(self, _t):
        return MiniSeries([str(v) for v in self._values])
    def isin(self, allowed):
        s = set(allowed)
        return MiniSeries([v in s for v in self._values])
    def isna(self):
        return MiniSeries([is_nan(v) for v in self._values])
    def __or__(self, other):
        return MiniSeries([bool(a) or bool(b) for a, b in zip(self._values, other._values)])
    def __eq__(self, other):
        return MiniSeries([v == other for v in self._values])
    def __truediv__(self, other):
        return MiniSeries([a / b for a, b in zip(self._values, other._values)])
    def mean(self):
        return sum(1.0 if v is True else (0.0 if v is False else float(v)) for v in self._values) / len(self._values)
    def unique(self):
        seen = []
        for v in self._values:
            if v not in seen:
                seen.append(v)
        return seen
    def nunique(self):
        vals = [v for v in self._values if not is_nan(v)]
        return len(set(vals))
    def apply(self, fn):
        return MiniSeries([fn(v) for v in self._values])
    def __iter__(self):
        return iter(self._values)
    def __len__(self):
        return len(self._values)

class MiniGroupSeries:
    def __init__(self, rows, group_col, val_col):
        self._rows = rows
        self._group_col = group_col
        self._val_col = val_col
    def transform(self, agg):
        totals = {}
        for r in self._rows:
            k = r[self._group_col]
            totals[k] = totals.get(k, 0) + r[self._val_col]
        return MiniSeries([totals[r[self._group_col]] for r in self._rows])

class MiniGroupBy:
    def __init__(self, rows, keys):
        self._rows = rows
        self._keys = [keys] if isinstance(keys, str) else list(keys)
    def __getitem__(self, val_col):
        return MiniGroupSeries(self._rows, self._keys[0], val_col)
    def agg(self, **named_aggs):
        buckets = {}
        order = []
        for r in self._rows:
            k = tuple(r[c] for c in self._keys)
            if k not in buckets:
                buckets[k] = []
                order.append(k)
            buckets[k].append(r)
        out = []
        for k in order:
            grp = buckets[k]
            rec = {col: val for col, val in zip(self._keys, k)}
            for out_name, (col, fn_name) in named_aggs.items():
                vals = [g[col] for g in grp]
                if fn_name == "sum":
                    rec[out_name] = sum(vals)
                elif fn_name == "count":
                    rec[out_name] = len(vals)
                elif fn_name == "mean":
                    rec[out_name] = sum(vals) / len(vals)
            out.append(rec)
        return MiniDF(out)

class MiniDF:
    def __init__(self, data=None, columns=None):
        if isinstance(data, dict):
            cols = list(data.keys())
            n = len(data[cols[0]]) if cols else 0
            self._rows = [{c: list(data[c])[i] for c in cols} for i in range(n)]
            self._columns = cols
        elif isinstance(data, list):
            self._rows = [dict(r) for r in data]
            self._columns = list(columns) if columns is not None else (list(self._rows[0].keys()) if self._rows else [])
        else:
            self._rows = []
            self._columns = list(columns or [])
    @property
    def columns(self):
        return self._columns
    @columns.setter
    def columns(self, new_cols):
        new_cols = list(new_cols)
        if len(new_cols) == len(self._columns) and self._columns != new_cols:
            self._rows = [
                {new_c: r.get(old_c) for old_c, new_c in zip(self._columns, new_cols)}
                for r in self._rows
            ]
        self._columns = new_cols
    @property
    def values(self):
        return [[r.get(c) for c in self.columns] for r in self._rows]
    def __len__(self):
        return len(self._rows)
    def copy(self):
        return MiniDF([dict(r) for r in self._rows], columns=list(self.columns))
    def reset_index(self, drop=False):
        return self.copy()
    def replace(self, mapping, inplace=False):
        for r in self._rows:
            for c in list(r.keys()):
                if r[c] in mapping:
                    r[c] = mapping[r[c]]
        return self
    def drop_duplicates(self, subset):
        seen = set()
        kept = []
        for r in self._rows:
            k = tuple(r.get(c) for c in subset)
            if k not in seen:
                seen.add(k)
                kept.append(dict(r))
        return MiniDF(kept, columns=list(self.columns))
    def drop(self, columns=None, errors="raise", inplace=False):
        drop_set = set(columns or [])
        new_cols = [c for c in self.columns if c not in drop_set]
        new_rows = [{c: r[c] for c in new_cols} for r in self._rows]
        if inplace:
            self.columns = new_cols
            self._rows = new_rows
            return None
        return MiniDF(new_rows, columns=new_cols)
    def rename(self, columns=None, inplace=False):
        cmap = columns or {}
        new_cols = [cmap.get(c, c) for c in self.columns]
        new_rows = [{cmap.get(k, k): v for k, v in r.items()} for r in self._rows]
        if inplace:
            self.columns = new_cols
            self._rows = new_rows
            return None
        return MiniDF(new_rows, columns=new_cols)
    def groupby(self, keys):
        return MiniGroupBy(self._rows, keys)
    def sort_values(self, by, ascending=True):
        by_cols = [by] if isinstance(by, str) else list(by)
        asc = ascending[0] if isinstance(ascending, list) else ascending
        rows = sorted(self._rows, key=lambda r: tuple(r[c] for c in by_cols), reverse=not asc)
        return MiniDF(rows, columns=list(self.columns))
    def corr(self):
        rows = []
        for c1 in self.columns:
            row = {}
            for c2 in self.columns:
                row[c2] = 1.0 if c1 == c2 else -0.5
            rows.append(row)
        return MiniDF(rows, columns=list(self.columns))
    def abs(self):
        return MiniDF([{k: abs(v) for k, v in r.items()} for r in self._rows], columns=list(self.columns))
    def __getitem__(self, key):
        if isinstance(key, str):
            return MiniSeries([r.get(key) for r in self._rows])
        if isinstance(key, MiniSeries):
            return MiniDF([dict(r) for r, keep in zip(self._rows, key) if keep], columns=list(self.columns))
        if isinstance(key, list):
            return MiniDF([{c: r.get(c) for c in key} for r in self._rows], columns=list(key))
        raise TypeError(key)
    def __setitem__(self, key, val):
        if isinstance(val, MiniSeries):
            for r, v in zip(self._rows, val):
                r[key] = v
        else:
            for r in self._rows:
                r[key] = val
        if key not in self.columns:
            self.columns.append(key)

pd_mod = types.ModuleType("pandas")
pd_mod.DataFrame = MiniDF
pd_mod.read_parquet = lambda _p: (_ for _ in ()).throw(ValueError("not parquet"))
def _read_csv(p):
    with open(p, encoding="utf-8") as fh:
        rows = []
        for r in csv.DictReader(fh):
            parsed = {}
            for k, v in r.items():
                try:
                    parsed[k] = int(v)
                except ValueError:
                    parsed[k] = v
            rows.append(parsed)
        return MiniDF(rows)
pd_mod.read_csv = _read_csv
pd_mod.read_excel = lambda _p: (_ for _ in ()).throw(ValueError("not xlsx"))
pd_mod.read_pickle = lambda _p: (_ for _ in ()).throw(ValueError("not pkl"))

np_mod = types.ModuleType("numpy")
np_mod.nan = NAN
np_mod.isnan = is_nan

tqdm_mod = types.ModuleType("tqdm")
tqdm_mod.tqdm = lambda iterable, **_kw: iterable

toad_mod = types.ModuleType("toad")
toad_tf = types.ModuleType("toad.transform")
class FakeCombiner:
    def fit_transform(self, X, y, **_kw):
        vals = list(X)
        if all(is_nan(v) for v in vals):
            raise RuntimeError("all missing")
        return MiniSeries([0 if is_nan(v) else (1 if v > 50 else 2) for v in vals])
toad_tf.Combiner = FakeCombiner
toad_mod.transform = toad_tf
def _quality(df, target, iv_only=True):
    xs = list(df["x_bin"])
    iv_val = 0.34567 if any(x == 1 for x in xs) else 0.12
    return MiniDF([{"iv": iv_val}], columns=["iv"])
toad_mod.quality = _quality

joblib_mod = types.ModuleType("joblib")
joblib_mod.delayed = lambda fn: (lambda *a, **k: (fn, a, k))
joblib_mod.Parallel = lambda **_kw: (lambda tasks: [fn(*a, **k) for fn, a, k in tasks])

saved_workbooks = {}
openpyxl_mod = types.ModuleType("openpyxl")
openpyxl_styles = types.ModuleType("openpyxl.styles")
class FakeCell:
    def __init__(self, value=None):
        self.value = value
        self.fill = None
        self.font = None
        self.alignment = None
class FakeSheet:
    def __init__(self, title="Sheet"):
        self.title = title
        self.cells = {}
    def __setitem__(self, ref, val):
        self.cells[ref] = FakeCell(val)
    def cell(self, row, col, val=None):
        c = FakeCell(val)
        self.cells[(row, col)] = c
        return c
    def __getitem__(self, row_idx):
        return [c for (r, _col), c in self.cells.items() if isinstance(r, int) and r == row_idx]
class FakeWorkbook:
    def __init__(self):
        self.active = FakeSheet("Sheet")
        self.sheets = [self.active]
    def create_sheet(self, name):
        s = FakeSheet(name)
        self.sheets.append(s)
        return s
    def save(self, filepath):
        saved_workbooks[filepath] = self
def _load_workbook(filepath):
    if filepath not in saved_workbooks:
        raise FileNotFoundError(filepath)
    return saved_workbooks[filepath]
openpyxl_mod.Workbook = FakeWorkbook
openpyxl_mod.load_workbook = _load_workbook
openpyxl_styles.Font = lambda **kw: kw
openpyxl_styles.PatternFill = lambda **kw: kw
openpyxl_styles.Alignment = lambda **kw: kw

sys.modules["pandas"] = pd_mod
sys.modules["numpy"] = np_mod
sys.modules["tqdm"] = tqdm_mod
sys.modules["toad"] = toad_mod
sys.modules["toad.transform"] = toad_tf
sys.modules["joblib"] = joblib_mod
sys.modules["openpyxl"] = openpyxl_mod
sys.modules["openpyxl.styles"] = openpyxl_styles
sys.path.insert(0, ${JSON.stringify(funcDir)})

import func

csv_file = base / "credit.csv"
csv_file.write_text(
    "apply_id,apply_date,label,org,f_score,f_empty\\n"
    "1,2026-01-15,1,orgA,80,-999\\n"
    "1,2026-01-15,1,orgA,80,-999\\n"
    "2,2026-01-20,0,orgA,-1,-999\\n"
    "3,2026-02-05,0,orgB,40,-1111\\n"
    "4,2026-02-10,2,orgB,90,10\\n",  # invalid label=2 filtered out
    encoding="utf-8",
)

ds = func.get_dataset(
    str(csv_file),
    date_colName="apply_date",
    y_colName="label",
    org_colName="org",
    data_encode="utf-8",
    key_colNames=["apply_id"],
)
assert len(ds) == 3  # deduplicated apply_id=1 and filtered label=2
assert list(ds["new_date_ym"]) == ["202601", "202601", "202602"]

org_df = func.org_analysis(ds, oos_orgs=["orgB"])
assert len(org_df) == 2
sample_types = {r["机构"]: r["样本类型"] for r in org_df._rows}
assert sample_types == {"orgA": "建模", "orgB": "贷外"}

miss_detail, miss_ch = func.missing_check(ds)
assert miss_detail._rows[0]["变量"] == "f_empty"
assert miss_detail._rows[0]["整体"] == 1.0

buf = io.StringIO()
with redirect_stdout(buf):
    iv_df = func.calculate_iv(ds, ["f_score", "f_empty"], n_jobs=1)
    corr_df = func.calculate_corr(ds, ["f_score", "f_empty"])
    xlsx_path = str(base / "report.xlsx")
    func.export_report_xlsx(xlsx_path, "credit_ds", org_df, "org_stat", "OOS split")
    func.export_report_xlsx(xlsx_path, "credit_ds", miss_detail, "missing_stat")

assert len(iv_df) == 1 and iv_df._rows[0] == {"变量": "f_score", "IV": 0.3457}
assert corr_df._rows[0]["f_empty"] == 0.5
assert [s.title for s in saved_workbooks[str(base / "report.xlsx")].sheets] == ["org_stat", "missing_stat"]
print("CREDIT_RISK_FUNC_OK")
`;

  const res = runPy(["-c", driver], { cwd: dir });
  assert.equal(res.status, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /CREDIT_RISK_FUNC_OK/);
});
