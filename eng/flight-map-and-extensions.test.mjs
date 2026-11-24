import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { analyzeDockerImages } from "../extensions/windows-app-storage-inspector-cleanup/src/analyzers/docker-images.mjs";
import { analyzeMicrosoftScout } from "../extensions/windows-app-storage-inspector-cleanup/src/analyzers/microsoft-scout.mjs";
import { CloudFileAttributeReader } from "../extensions/windows-app-storage-inspector-cleanup/src/core/cloud-files.mjs";
import { ROOT_FOLDER } from "./constants.mjs";

const FLIGHT_GAME_DIR = path.join(ROOT_FOLDER, "extensions", "flight-map-canvas", "game");

function makeTempDir(t, prefix = "awesome-copilot-flight-ext-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readFlightScript(filename) {
  return fs.readFileSync(path.join(FLIGHT_GAME_DIR, filename), "utf8");
}

test("flight-map-canvas capitals dataset, HostBridge, and RenderConfig merge/apply/export safely offline", () => {
  // 1. Validate CAPITALS_BY_REGION dataset integrity
  const capCtx = {};
  vm.runInNewContext(readFlightScript("capitals.js"), capCtx);
  assert.equal(Array.isArray(capCtx.CAPITALS_BY_REGION), true);
  assert.equal(capCtx.CAPITALS_BY_REGION.length, 6);

  const seenCountries = new Set();
  for (const group of capCtx.CAPITALS_BY_REGION) {
    assert.ok(group.region.length > 0);
    assert.ok(group.capitals.length > 0);
    for (const entry of group.capitals) {
      assert.equal(seenCountries.has(entry.country), false, `duplicate country ${entry.country}`);
      seenCountries.add(entry.country);
      assert.ok(entry.capital.length > 0);
      assert.ok(Number.isFinite(entry.lat) && entry.lat >= -90 && entry.lat <= 90);
      assert.ok(Number.isFinite(entry.lng) && entry.lng >= -180 && entry.lng <= 180);
    }
  }

  // 2. HostBridge standalone vs VS Code webview mode + RenderConfig deep merge, prototype guards, apply, and export
  const postedMessages = [];
  let messageListener = null;
  const injectedNullProto = Object.assign(Object.create(null), {
    map: { loadRadius: 8, unloadRadius: 9 },
    cloud: { opacity: 0.6 },
  });
  Object.defineProperty(injectedNullProto, "__proto__", {
    value: { polluted: true },
    enumerable: true,
  });

  const hostedCtx = {
    window: {
      __flightMapConfig: injectedNullProto,
      innerWidth: 1600,
      innerHeight: 800,
      addEventListener(type, fn) {
        if (type === "message") messageListener = fn;
      },
    },
    acquireVsCodeApi() {
      return {
        postMessage(msg) {
          postedMessages.push(msg);
        },
      };
    },
    TILE_ZOOM: 0,
    TILE_SIZE: 0,
    LOAD_RADIUS: 0,
    UNLOAD_RADIUS: 0,
    START_ALTITUDE: 0,
    FOG_DENSITY: 0,
    RADIUS_FEATHER: 0,
    MAX_TILES: 0,
    scene: { fog: { density: 0 } },
    renderer: {
      sizeCalls: [],
      setSize(w, h, updateStyle) {
        this.sizeCalls.push([w, h, updateStyle]);
      },
    },
    camera: {
      aspect: 1,
      updated: 0,
      updateProjectionMatrix() {
        this.updated += 1;
      },
    },
    terrainFill: { cloudOverlay: {} },
    console,
  };

  vm.runInNewContext(readFlightScript("hostBridge.js"), hostedCtx);
  vm.runInNewContext(readFlightScript("renderConfig.js"), hostedCtx);

  assert.equal(hostedCtx.HostBridge.isHosted(), true);
  let receivedHostCmd = null;
  hostedCtx.HostBridge.on("reloadConfig", (msg) => {
    receivedHostCmd = msg.payload;
  });
  messageListener({ data: { command: "reloadConfig", payload: 42 } });
  assert.equal(receivedHostCmd, 42);

  let loadedCfg = null;
  hostedCtx.RenderConfig.load((cfg) => {
    loadedCfg = cfg;
  });
  assert.equal(loadedCfg.map.loadRadius, 8);
  assert.equal(loadedCfg.map.tileSize, 100); // preserved from defaults
  assert.equal( ({}).polluted, undefined); // prototype pollution blocked

  // Blocked unsafe dot-paths leave Object.prototype untouched; valid set() updates globals & notifies listeners
  const notifications = [];
  hostedCtx.RenderConfig.onChange((keyPath, val) => notifications.push([keyPath, val]));
  hostedCtx.RenderConfig.set("__proto__.polluted", "bad");
  hostedCtx.RenderConfig.set("constructor.prototype.polluted", "bad");
  assert.equal(({}).polluted, undefined);
  assert.equal(notifications.length, 0);

  hostedCtx.RenderConfig.set("map.loadRadius", 10);
  assert.deepEqual(notifications, [["map.loadRadius", 10]]);
  assert.equal(hostedCtx.LOAD_RADIUS, 10);
  // unloadRadius was 9, so apply() enforces Math.max(9, LOAD_RADIUS + 3) === 13
  assert.equal(hostedCtx.UNLOAD_RADIUS, 13);
  assert.equal(hostedCtx.camera.aspect, 2);
  assert.equal(hostedCtx.renderer.sizeCalls.length, 1);
  assert.equal(hostedCtx.terrainFill.cloudOverlay.opacity, 0.6);

  hostedCtx.RenderConfig.exportJSON();
  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].command, "exportConfig");
  assert.equal(JSON.parse(postedMessages[0].json).map.loadRadius, 10);

  // Standalone browser mode: invalid XHR JSON falls back to defaults and exportJSON triggers Blob download
  let lastXhr = null;
  let clickedDownload = null;
  let revokedUrl = null;
  const standaloneCtx = {
    window: { innerWidth: 0, innerHeight: 0 },
    XMLHttpRequest: class {
      open(method, url) {
        this.method = method;
        this.url = url;
        lastXhr = this;
      }
      send() {}
    },
    Blob: class {
      constructor(parts, opts) {
        this.parts = parts;
        this.opts = opts;
      }
    },
    URL: {
      createObjectURL: () => "blob:mock-config",
      revokeObjectURL: (u) => {
        revokedUrl = u;
      },
    },
    document: {
      createElement: () => ({
        click() {
          clickedDownload = { href: this.href, download: this.download };
        },
      }),
      body: { appendChild() {}, removeChild() {} },
    },
    TILE_ZOOM: 0,
    TILE_SIZE: 0,
    LOAD_RADIUS: 0,
    UNLOAD_RADIUS: 0,
    START_ALTITUDE: 0,
    FOG_DENSITY: 0,
    RADIUS_FEATHER: 0,
    MAX_TILES: 0,
    console: { warn() {} },
  };
  vm.runInNewContext(readFlightScript("hostBridge.js"), standaloneCtx);
  vm.runInNewContext(readFlightScript("renderConfig.js"), standaloneCtx);
  assert.equal(standaloneCtx.HostBridge.isHosted(), false);

  let fallbackConfig = null;
  standaloneCtx.RenderConfig.load((cfg) => {
    fallbackConfig = cfg;
  });
  lastXhr.readyState = 4;
  lastXhr.status = 200;
  lastXhr.responseText = "{invalid-json";
  lastXhr.onreadystatechange();
  assert.equal(fallbackConfig.map.loadRadius, 6);

  standaloneCtx.RenderConfig.exportJSON();
  assert.deepEqual(clickedDownload, { href: "blob:mock-config", download: "renderMap.json" });
  assert.equal(revokedUrl, "blob:mock-config");
});

test("flight-map-canvas Geocoder throttles reverse lookups, spaces shared queue requests, abandons reset generations, and formats search results", () => {
  let nowMs = 10_000;
  const timers = [];
  const xhrs = [];

  const ctx = {
    encodeURIComponent,
    parseFloat,
    isNaN,
    Math,
    JSON,
    performance: { now: () => nowMs },
    setTimeout(fn, delay) {
      timers.push({ fn, delay });
      return timers.length;
    },
    XMLHttpRequest: class {
      open(method, url) {
        this.method = method;
        this.url = url;
      }
      send() {
        xhrs.push(this);
      }
    },
  };
  vm.runInNewContext(readFlightScript("geocoder.js"), ctx);
  const { Geocoder } = ctx;

  const labels = [];
  Geocoder.update(-35.2809, 149.13, (label) => labels.push(label));
  assert.equal(xhrs.length, 1);
  assert.match(xhrs[0].url, /reverse\?format=jsonv2/);

  // While pending or within 5000ms / 0.005 deg, extra update() calls do not enqueue
  Geocoder.update(-35.281, 149.13, (label) => labels.push(label));
  assert.equal(xhrs.length, 1);

  xhrs[0].readyState = 4;
  xhrs[0].status = 200;
  xhrs[0].responseText = JSON.stringify({
    address: { city: "Canberra", state: "Australian Capital Territory", country: "Australia" },
  });
  xhrs[0].onreadystatechange();
  assert.deepEqual(labels, ["Canberra, Australian Capital Territory, Australia"]);

  // Move >0.005 deg after 5000ms -> rural fallback ("Rural <state>, <country>")
  nowMs += 6_000;
  Geocoder.update(-35.5, 149.5, (label) => labels.push(label));
  assert.equal(xhrs.length, 2);
  xhrs[1].readyState = 4;
  xhrs[1].status = 200;
  xhrs[1].responseText = JSON.stringify({
    address: { village: "Small Crossing", state: "New South Wales", country: "Australia" },
  });
  xhrs[1].onreadystatechange();
  assert.equal(labels[1], "Rural New South Wales, Australia");

  // Reset while a lookup is in flight abandons the stale response
  nowMs += 6_000;
  Geocoder.update(35.6762, 139.6503, (label) => labels.push(label));
  assert.equal(xhrs.length, 3);
  Geocoder.reset();
  xhrs[2].readyState = 4;
  xhrs[2].status = 200;
  xhrs[2].responseText = JSON.stringify({ address: { city: "Stale Tokyo", country: "Japan" } });
  xhrs[2].onreadystatechange();
  assert.equal(labels.length, 2);

  // Search within 1000ms of last send waits on rate-limit timer before dispatching
  let emptyErr = null;
  Geocoder.search({ state: "  ", city: "", country: "" }, (err) => {
    emptyErr = err;
  });
  assert.match(emptyErr, /Enter a state\/region/);

  let searchOut = null;
  Geocoder.search({ city: "Singapore", country: "Singapore" }, (err, found) => {
    searchOut = { err, found };
  });
  assert.equal(xhrs.length, 3); // held in queue until 1s spacing elapses
  assert.equal(timers.length, 1);
  nowMs += 1_000;
  timers.shift().fn();
  assert.equal(xhrs.length, 4);
  assert.match(xhrs[3].url, /city=Singapore&country=Singapore/);

  xhrs[3].readyState = 4;
  xhrs[3].status = 200;
  xhrs[3].responseText = JSON.stringify([
    {
      lat: "1.3521",
      lon: "103.8198",
      address: { city: "Singapore", state: "Singapore", country: "Singapore", country_code: "sg" },
    },
    {
      lat: "48.8566",
      lon: "2.3522",
      display_name: "Paris Fallback Display",
      address: {},
    },
    { lat: "not-a-number", lon: "10" },
  ]);
  xhrs[3].onreadystatechange();

  assert.equal(searchOut.err, null);
  assert.equal(searchOut.found.length, 2);
  // Deduplicates city === state ("Singapore, SG" instead of "Singapore, Singapore, SG")
  assert.equal(searchOut.found[0].label, "Singapore, SG");
  assert.equal(searchOut.found[1].label, "Paris Fallback Display");

  // Malformed JSON and network failure surface clean error messages
  nowMs += 1_500;
  let malformedErr = null;
  Geocoder.search({ city: "Broken" }, (err) => {
    malformedErr = err;
  });
  xhrs[4].readyState = 4;
  xhrs[4].status = 200;
  xhrs[4].responseText = "{bad";
  xhrs[4].onreadystatechange();
  assert.equal(malformedErr, "Search returned a malformed response.");

  nowMs += 1_500;
  let netErr = null;
  Geocoder.search({ city: "Offline" }, (err) => {
    netErr = err;
  });
  xhrs[5].onerror();
  assert.equal(netErr, "Search could not reach the geocoding service.");
});

test("flight-map-canvas FlightControls.isTextEntryTarget and TerrainFill color filter + value noise obey invariants", () => {
  const fcCtx = { THREE: {} };
  vm.runInNewContext(readFlightScript("flightControls.js"), fcCtx);
  const { isTextEntryTarget } = fcCtx.FlightControls;

  assert.equal(isTextEntryTarget(null), false);
  assert.equal(isTextEntryTarget({}), false);
  assert.equal(isTextEntryTarget({ tagName: "INPUT" }), true);
  assert.equal(isTextEntryTarget({ tagName: "textarea" }), true);
  assert.equal(isTextEntryTarget({ tagName: "SELECT" }), true);
  assert.equal(isTextEntryTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(
    isTextEntryTarget({
      tagName: "BUTTON",
      closest: (sel) => (sel === '[role="dialog"]' ? {} : null),
    }),
    true,
  );
  assert.equal(isTextEntryTarget({ tagName: "CANVAS", closest: () => null }), false);

  const tfCtx = { Math, Float32Array, Uint8Array, Array };
  vm.runInNewContext(readFlightScript("terrainFill.js"), tfCtx);
  const proto = tfCtx.TerrainFill.prototype;

  // Placeholder green, sky blue, water blue, near-black, and dark fill plane are skipped
  assert.equal(proto._isSkipColor(42, 58, 42), true);
  assert.equal(proto._isSkipColor(135, 206, 235), true);
  assert.equal(proto._isSkipColor(26, 74, 122), true);
  assert.equal(proto._isSkipColor(3, 3, 3), true);
  assert.equal(proto._isSkipColor(40, 50, 44), true);
  // Warm desert / forest canopy colors are retained
  assert.equal(proto._isSkipColor(168, 132, 84), false);
  assert.equal(proto._isSkipColor(76, 128, 52), false);

  const perm = Array.from({ length: 512 }, (_, i) => (i * 37) & 255);
  const fakeInstance = { perm };
  const sampleA = proto._noise2d.call(fakeInstance, 12.34, 56.78);
  const sampleB = proto._noise2d.call(fakeInstance, 12.34, 56.78);
  assert.equal(sampleA, sampleB);
  assert.ok(sampleA >= 0 && sampleA <= 1);
});

test("windows-app-storage-inspector docker-images, microsoft-scout, and cloud-files modules handle offline CLI stubs and path rules", async (t) => {
  const dir = makeTempDir(t, "storage-inspector-ext-");
  const localAppData = path.join(dir, "LocalAppData");
  const programData = path.join(dir, "ProgramData");
  const userProfile = path.join(dir, "UserProfile");
  const fakeBin = path.join(dir, "bin");
  fs.mkdirSync(fakeBin, { recursive: true });

  const savedEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  process.env.LOCALAPPDATA = localAppData;
  process.env.PROGRAMDATA = programData;
  process.env.USERPROFILE = userProfile;
  process.env.OneDrive = "C:\\Users\\Ada\\OneDrive";
  process.env.OneDriveCommercial = "C:\\Users\\Ada\\OneDrive - Acme";

  // 1. CloudFileAttributeReader path detection + safe non-win32 read()
  const cloudReader = new CloudFileAttributeReader();
  assert.equal(cloudReader.isPotentialCloudPath("c:/users/ada/onedrive/docs/report.docx"), true);
  assert.equal(cloudReader.isPotentialCloudPath("C:\\Users\\Ada\\OneDrive - Acme\\deck.pptx"), true);
  assert.equal(cloudReader.isPotentialCloudPath("D:\\Work\\OneDrive - Contoso\\spec.md"), true);
  assert.equal(cloudReader.isPotentialCloudPath("C:\\Users\\Ada\\Documents\\local.txt"), false);
  if (process.platform !== "win32") {
    assert.deepEqual(
      await cloudReader.read("C:\\Users\\Ada\\OneDrive\\docs\\report.docx"),
      { cloudOnly: false },
    );
  }
  await cloudReader.close();

  // 2. analyzeDockerImages when absent vs when docker.exe is stubbed on PATH
  process.env.PATH = fakeBin;
  const emptyScan = { directories: [], largestFiles: [] };
  const missingDocker = await analyzeDockerImages(emptyScan);
  assert.equal(missingDocker.status, "not-found");
  assert.match(missingDocker.message, /Docker CLI was not found/);

  const dockerDesktopDir = path.resolve(localAppData, "Docker");
  const vhdxPath = path.join(dockerDesktopDir, "wsl", "ext4.vhdx");
  fs.mkdirSync(path.dirname(vhdxPath), { recursive: true });
  fs.writeFileSync(vhdxPath, "stub", "utf8");

  fs.writeFileSync(
    path.join(fakeBin, "docker.exe"),
    `#!/bin/sh
printf '%s\\n' '{"ID":"sha256:111","Repository":"node","Tag":"22-alpine","Size":"150MB","CreatedAt":"2026-03-01","Containers":"2"}'
printf '%s\\n' '{"ID":"sha256:222","Repository":"<none>","Tag":"<none>","Size":"512KB","CreatedAt":"2026-02-01","Containers":"N/A"}'
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${fakeBin}${path.delimiter}${savedEnv.PATH ?? ""}`;

  const dockerResult = await analyzeDockerImages({
    directories: [{ path: dockerDesktopDir, bytes: 4096, files: 2 }],
    largestFiles: [
      { path: vhdxPath, bytes: 4096 },
      { path: path.join(dir, "unrelated.bin"), bytes: 99999 },
    ],
  });
  assert.equal(dockerResult.status, "available");
  assert.equal(dockerResult.images.length, 2);
  assert.equal(dockerResult.danglingImages, 1);
  assert.equal(dockerResult.imageBytes, 150 * 1024 * 1024 + 512 * 1024);
  assert.equal(dockerResult.images[0].containers, 2);
  assert.equal(dockerResult.images[1].containers, undefined);
  assert.equal(dockerResult.totalBytes, 4096);
  assert.deepEqual(dockerResult.topFiles.map((f) => f.path), [vhdxPath]);

  // 3. analyzeMicrosoftScout when absent vs when .scout folders exist
  const missingScout = await analyzeMicrosoftScout(emptyScan);
  assert.equal(missingScout.status, "not-found");

  const scoutRoot = path.resolve(userProfile, ".scout");
  const scoutLogs = path.join(scoutRoot, "logs");
  const scoutTemp = path.join(scoutRoot, "temp");
  const scoutLogFile = path.join(scoutLogs, "app.log");
  fs.mkdirSync(scoutLogs, { recursive: true });
  fs.mkdirSync(scoutTemp, { recursive: true });
  fs.writeFileSync(scoutLogFile, "log", "utf8");

  const scoutResult = await analyzeMicrosoftScout({
    directories: [
      { path: scoutRoot, bytes: 3000, files: 4 },
      { path: scoutLogs, bytes: 2000, files: 2 },
      { path: scoutTemp, bytes: 500, files: 1 },
    ],
    largestFiles: [{ path: scoutLogFile, bytes: 2000 }],
  });
  assert.equal(scoutResult.locations.length, 1);
  assert.equal(scoutResult.cleanupItems.length, 2);
  assert.equal(scoutResult.totalBytes, 3000);
  assert.equal(scoutResult.cleanupBytes, 2500);
  if (process.platform !== "win32") {
    assert.equal(scoutResult.status, "unsupported");
    assert.equal(scoutResult.cleanupItems.every((item) => item.cleanupEligible === false), true);
  }
});
