import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { ROOT_FOLDER } from "./constants.mjs";

const SUBPROCESS_TIMEOUT_MS = 10_000;
const SKILLS_ROOT = path.join(ROOT_FOLDER, "skills");

function makeTempDir(t, prefix = "awesome-copilot-nc-metrics-") {
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

test("namecheap CLI parses multi-part domains, manages 0600 config files, formats MX/non-MX host params, and executes commands offline", (t) => {
  if (runPy(["--version"]).status !== 0) {
    t.skip("python3 is not available");
    return;
  }

  const dir = makeTempDir(t, "namecheap-skill-");
  const namecheapDir = path.join(SKILLS_ROOT, "namecheap");

  const pyDriver = `
import io, json, os, pathlib, stat, sys, urllib.error, urllib.parse
from contextlib import redirect_stdout, redirect_stderr
sys.path.insert(0, ${JSON.stringify(namecheapDir)})

import namecheap as nc

base = pathlib.Path(${JSON.stringify(dir)})

# 1. parse_domain: single-label TLDs, subdomains, multi-part public suffixes, trailing dots, bare hosts
assert nc.parse_domain("Example.COM.") == ("example", "com")
assert nc.parse_domain("api.staging.acme.io") == ("api.staging.acme", "io")
assert nc.parse_domain("shop.co.uk") == ("shop", "co.uk")
assert nc.parse_domain("portal.edu.sg") == ("portal", "edu.sg")
assert nc.parse_domain("sub.brand.com.au") == ("sub.brand", "com.au")
assert nc.parse_domain("intranet") == ("intranet", "")

# 2. save_config + load_config precedence (env vars override config file)
cfg_file = base / ".namecheap-test-cfg"
nc.CONFIG_FILE = str(cfg_file)
os.environ.pop("NAMECHEAP_API_USER", None)
os.environ.pop("NAMECHEAP_API_KEY", None)

nc.save_config("cfg-user", "test-cfg-key")
if os.name != "nt":
    mode = stat.S_IMODE(cfg_file.stat().st_mode)
    assert mode == 0o600, f"expected 0600, got {oct(mode)}"
assert nc.load_config() == ("cfg-user", "test-cfg-key")

os.environ["NAMECHEAP_API_USER"] = "env-user"
os.environ["NAMECHEAP_API_KEY"] = "test-env-key"
assert nc.load_config() == ("env-user", "test-env-key")

# 3. _hosts_to_params: skips incomplete entries, defaults TTL, preserves MXPref=0 only for MX records
params, count = nc._hosts_to_params("acme", "co.uk", [
    {"name": "@", "type": "A", "address": "198.51.100.10", "ttl": "", "mxpref": "0"},
    {"name": "@", "type": "MX", "address": "mail.acme.co.uk.", "ttl": "3600", "mxpref": "0"},
    {"name": "cname-incomplete", "type": "CNAME", "address": ""},
])
assert count == 2
assert params["SLD"] == "acme" and params["TLD"] == "co.uk"
assert params["TTL1"] == "1800"
assert "MXPref1" not in params  # non-MX with mxpref "0" omitted
assert params["MXPref2"] == "0"  # MX priority 0 preserved!

# 4. Offline end-to-end CLI dispatch with stubbed _http_get & cached _public_ip
nc._public_ip = "198.51.100.42"
recorded_urls = []

def fake_http_get(url, timeout=15):
    recorded_urls.append(url)
    parsed = urllib.parse.urlparse(url)
    qs = urllib.parse.parse_qs(parsed.query)
    cmd = qs.get("Command", [""])[0]

    if cmd == "namecheap.domains.getList":
        if qs.get("SearchTerm") == ["trigger-api-error"]:
            return '''<?xml version="1.0" encoding="utf-8"?>
            <ApiResponse Status="ERROR" xmlns="http://api.namecheap.com/xml.response">
              <Errors><Error Number="2019166">Domain not found</Error><Err Number="1011150">Invalid request IP</Err></Errors>
            </ApiResponse>'''
        return '''<?xml version="1.0" encoding="utf-8"?>
        <ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
          <CommandResponse>
            <DomainGetListResult>
              <Domain Name="acme.co.uk" Expires="12/31/2027" IsLocked="true" AutoRenew="true" />
            </DomainGetListResult>
          </CommandResponse>
        </ApiResponse>'''

    if cmd == "namecheap.domains.dns.getHosts":
        sld = qs.get("SLD", [""])[0]
        if sld == "single":
            return '''<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
              <CommandResponse><DomainDNSGetHostsResult>
                <host Name="@" Type="A" Address="198.51.100.1" TTL="1800" />
              </DomainDNSGetHostsResult></CommandResponse>
            </ApiResponse>'''
        return '''<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
          <CommandResponse><DomainDNSGetHostsResult>
            <host Name="@" Type="A" Address="198.51.100.1" TTL="1800" />
            <host Name="www" Type="CNAME" Address="acme.co.uk." TTL="1800" />
          </DomainDNSGetHostsResult></CommandResponse>
        </ApiResponse>'''

    if cmd == "namecheap.domains.dns.setHosts":
        return '''<ApiResponse Status="OK"><CommandResponse>
          <DomainDNSSetHostsResult Domain="acme.co.uk" IsSuccess="true" />
        </CommandResponse></ApiResponse>'''

    if cmd == "namecheap.domains.dns.setEmailForwarding":
        return '''<ApiResponse Status="OK"><CommandResponse>
          <DomainDNSSetEmailForwardingResult Domain="acme.co.uk" IsSuccess="true" />
        </CommandResponse></ApiResponse>'''

    if cmd == "namecheap.domains.ns.getInfo":
        return '''<ApiResponse Status="OK"><CommandResponse>
          <DomainNSInfoResult Nameserver="ns1.acme.co.uk" IP="198.51.100.53">
            <NameserverStatuses><Status>OK</Status><Status>Linked</Status></NameserverStatuses>
          </DomainNSInfoResult>
        </CommandResponse></ApiResponse>'''

    raise urllib.error.URLError("unexpected command: " + cmd)

nc._http_get = fake_http_get

def run_cli(argv):
    out, err_buf = io.StringIO(), io.StringIO()
    code = None
    with redirect_stdout(out), redirect_stderr(err_buf):
        try:
            code = nc.main(argv)
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else 1
    return code, out.getvalue(), err_buf.getvalue()

# Missing subcommand -> exit 1
code, out, _ = run_cli([])
assert code == 1 and "usage:" in out.lower()

# public-ip & domains.getList
code, out, _ = run_cli(["public-ip"])
assert code == 0 and out.strip() == "198.51.100.42"

code, out, _ = run_cli(["domains.getList"])
assert code == 0 and "acme.co.uk" in out

# API Status="ERROR" surfaces NamecheapError cleanly -> exit 1
code, _, err_out = run_cli(["domains.getList", "--search", "trigger-api-error"])
assert code == 1 and "[1011150] Invalid request IP" in err_out

# dns.addHost preserves existing 2 hosts and sends 3 hosts to setHosts
code, out, _ = run_cli([
    "dns.addHost", "--domain", "acme.co.uk", "--type", "txt", "--name", "_verify", "--address", "v=test"
])
assert code == 0
last_qs = urllib.parse.parse_qs(urllib.parse.urlparse(recorded_urls[-1]).query)
assert last_qs["SLD"] == ["acme"] and last_qs["TLD"] == ["co.uk"]
assert last_qs["HostName3"] == ["_verify"] and last_qs["RecordType3"] == ["TXT"]

# dns.removeHost: succeeds when >1 record, fails when record missing, and refuses removing last record
code, _, _ = run_cli(["dns.removeHost", "--domain", "acme.co.uk", "--type", "CNAME", "--name", "www"])
assert code == 0

code, _, err_out = run_cli(["dns.removeHost", "--domain", "acme.co.uk", "--type", "TXT", "--name", "nope"])
assert code == 1 and "No matching record found" in err_out

code, _, err_out = run_cli(["dns.removeHost", "--domain", "single.com", "--type", "A", "--name", "@"])
assert code == 1 and "Cannot remove the last DNS record" in err_out

# domains.dns.setHosts: empty valid records exits 1; valid JSON file succeeds
empty_hosts = base / "empty-hosts.json"
empty_hosts.write_text(json.dumps([{"HostName": "", "RecordType": "A", "Address": ""}]), encoding="utf-8")
code, _, err_out = run_cli(["domains.dns.setHosts", "--domain", "acme.co.uk", "--hosts", str(empty_hosts)])
assert code == 1 and "No valid host records" in err_out

valid_hosts = base / "valid-hosts.json"
valid_hosts.write_text(json.dumps([{"HostName": "@", "RecordType": "A", "Address": "198.51.100.9"}]), encoding="utf-8")
code, _, _ = run_cli(["domains.dns.setHosts", "--domain", "acme.co.uk", "--hosts", str(valid_hosts)])
assert code == 0

# domains.dns.setEmailForwarding: requires flags or --forwards file
code, _, _ = run_cli(["domains.dns.setEmailForwarding", "--domain", "acme.co.uk"])
assert code == 1
forwards_file = base / "forwards.json"
forwards_file.write_text(json.dumps([{"MailBox": "hello", "ForwardTo": "team@example.com"}]), encoding="utf-8")
code, _, _ = run_cli(["domains.dns.setEmailForwarding", "--domain", "acme.co.uk", "--forwards", str(forwards_file)])
assert code == 0

# domains.ns.getInfo prints IP and joined statuses
code, out, _ = run_cli(["domains.ns.getInfo", "--domain", "acme.co.uk", "--nameserver", "ns1.acme.co.uk"])
assert code == 0 and "198.51.100.53" in out and "OK, Linked" in out
print("OK")
`;

  const res = runPy(["-c", pyDriver], { cwd: dir });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stdout.trim(), "OK");
});

test("copilot-usage-metrics and publish-to-pages shell scripts validate arguments, route REST endpoints, and push local git pages offline", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX bash stub test");
    return;
  }

  const dir = makeTempDir(t, "metrics-publish-sh-");
  const fakeBin = path.join(dir, "bin");
  fs.mkdirSync(fakeBin, { recursive: true });

  const ghCallsFile = path.join(dir, "gh-calls.log");
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${ghCallsFile}"
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  printf 'octopublisher\\n'
  exit 0
fi
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  if [ "$3" = "octopublisher/existing-site" ]; then
    exit 0
  fi
  exit 1
fi
printf '{"ok":true}\\n'
`,
    { mode: 0o755 },
  );

  const envWithStubGh = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
  };

  // 1. All 4 copilot-usage-metrics scripts: missing arg fails, optional [day] selects /day?day=...
  const metricsDir = path.join(SKILLS_ROOT, "copilot-usage-metrics");
  const cases = [
    ["get-org-metrics.sh", "acme-org", "/orgs/acme-org/copilot/usage", "/orgs/acme-org/copilot/usage/day?day=2026-03-15"],
    ["get-org-user-metrics.sh", "acme-org", "/orgs/acme-org/copilot/usage/users", "/orgs/acme-org/copilot/usage/users/day?day=2026-03-15"],
    ["get-enterprise-metrics.sh", "acme-ent", "/enterprises/acme-ent/copilot/usage", "/enterprises/acme-ent/copilot/usage/day?day=2026-03-15"],
    ["get-enterprise-user-metrics.sh", "acme-ent", "/enterprises/acme-ent/copilot/usage/users", "/enterprises/acme-ent/copilot/usage/users/day?day=2026-03-15"],
  ];

  for (const [scriptName, targetSlug, summaryEndpoint, dayEndpoint] of cases) {
    const scriptPath = path.join(metricsDir, scriptName);
    const missingArg = spawnSync("bash", [scriptPath], {
      cwd: dir,
      env: envWithStubGh,
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    assert.notEqual(missingArg.status, 0);
    assert.match(missingArg.stderr, /Usage:/);

    fs.writeFileSync(ghCallsFile, "", "utf8");
    assert.equal(
      spawnSync("bash", [scriptPath, targetSlug], {
        cwd: dir,
        env: envWithStubGh,
        encoding: "utf8",
        timeout: SUBPROCESS_TIMEOUT_MS,
      }).status,
      0,
    );
    assert.equal(
      spawnSync("bash", [scriptPath, targetSlug, "2026-03-15"], {
        cwd: dir,
        env: envWithStubGh,
        encoding: "utf8",
        timeout: SUBPROCESS_TIMEOUT_MS,
      }).status,
      0,
    );

    const logged = fs.readFileSync(ghCallsFile, "utf8").trim().split("\n");
    assert.equal(logged.length, 2);
    assert.match(logged[0], /X-GitHub-Api-Version: 2022-11-28/);
    assert.ok(logged[0].endsWith(summaryEndpoint), `expected ${summaryEndpoint}, got ${logged[0]}`);
    assert.ok(logged[1].endsWith(dayEndpoint), `expected ${dayEndpoint}, got ${logged[1]}`);
  }

  // 2. publish-to-pages/scripts/publish.sh: existing repo refusal + fresh publish with sibling assets/
  const publishSh = path.join(SKILLS_ROOT, "publish-to-pages", "scripts", "publish.sh");
  const siteSrcDir = path.join(dir, "site-src");
  fs.mkdirSync(path.join(siteSrcDir, "assets"), { recursive: true });
  const htmlFile = path.join(siteSrcDir, "deck.html");
  fs.writeFileSync(htmlFile, "<!doctype html><h1>Deck</h1>\n", "utf8");
  fs.writeFileSync(path.join(siteSrcDir, "assets", "chart.svg"), "<svg/>\n", "utf8");

  const dupRepoRun = spawnSync("bash", [publishSh, htmlFile, "existing-site"], {
    cwd: dir,
    env: envWithStubGh,
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(dupRepoRun.status, 1);
  assert.match(dupRepoRun.stdout, /ERROR: Repository octopublisher\/existing-site already exists/);

  // Create local bare repository and rewrite https://github.com/octopublisher/fresh-site.git -> file://...
  const bareParent = path.join(dir, "remotes", "octopublisher");
  const bareRepo = path.join(bareParent, "fresh-site.git");
  fs.mkdirSync(bareRepo, { recursive: true });
  assert.equal(
    spawnSync("git", ["init", "--bare", "--quiet"], { cwd: bareRepo, encoding: "utf8" }).status,
    0,
  );
  assert.equal(
    spawnSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: bareRepo, encoding: "utf8" }).status,
    0,
  );

  const remoteBaseHref = `${pathToFileURL(path.join(dir, "remotes")).href}/`;
  const publishEnv = {
    ...envWithStubGh,
    GIT_AUTHOR_NAME: "Test Publisher",
    GIT_AUTHOR_EMAIL: "publisher@example.com",
    GIT_COMMITTER_NAME: "Test Publisher",
    GIT_COMMITTER_EMAIL: "publisher@example.com",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `url.${remoteBaseHref}.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/",
    GIT_CONFIG_KEY_1: "commit.gpgSign",
    GIT_CONFIG_VALUE_1: "false",
  };

  const okPublish = spawnSync(
    "bash",
    [publishSh, htmlFile, "fresh-site", "private", "Architecture slides"],
    {
      cwd: dir,
      env: publishEnv,
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT_MS,
    },
  );
  assert.equal(okPublish.status, 0, okPublish.stdout + okPublish.stderr);
  assert.match(okPublish.stdout, /Copied assets\/ directory \( *1 files\)/);
  assert.match(okPublish.stdout, /REPO_URL=https:\/\/github\.com\/octopublisher\/fresh-site/);
  assert.match(okPublish.stdout, /PAGES_URL=https:\/\/octopublisher\.github\.io\/fresh-site\//);

  const treeFiles = spawnSync("git", ["ls-tree", "-r", "--name-only", "main"], {
    cwd: bareRepo,
    encoding: "utf8",
  });
  assert.equal(treeFiles.status, 0, treeFiles.stderr);
  assert.deepEqual(treeFiles.stdout.trim().split("\n").sort(), ["assets/chart.svg", "index.html"]);
});
