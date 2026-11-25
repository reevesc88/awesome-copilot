import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import {
  JAVA_UPGRADE_TARGETS,
  PREDEFINED_TASKS,
  VALIDATION_GATES,
  catalogWithRelevance,
} from "../extensions/java-modernization-studio/catalog.mjs";
import { renderHtml as renderCockpitHtml } from "../extensions/java-modernization-studio/renderer.mjs";
import {
  broadcast,
  buildState,
  dispatchAction,
  makeHandler,
  pushState,
  resolveRepoPath,
  startAutopilot,
} from "../extensions/java-modernization-studio/server.mjs";
import { ROOT_FOLDER } from "./constants.mjs";

function makeTempDir(t, prefix = "awesome-copilot-flight-mod-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("flight-map-canvas Geocoder throttles reverse lookups, paces shared Nominatim queue, abandons stale generations, and formats search results", () => {
  const geocoderSource = fs.readFileSync(
    path.join(ROOT_FOLDER, "extensions", "flight-map-canvas", "game", "geocoder.js"),
    "utf8",
  );

  let nowMs = 10_000;
  const timers = [];
  const xhrs = [];

  class FakeXHR {
    constructor() {
      this.method = null;
      this.url = null;
      this.readyState = 0;
      this.status = 0;
      this.responseText = "";
      this.onreadystatechange = null;
      this.onerror = null;
      this.sent = false;
      xhrs.push(this);
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    send() {
      this.sent = true;
    }
    respond(status, body) {
      this.status = status;
      this.responseText = typeof body === "string" ? body : JSON.stringify(body);
      this.readyState = 4;
      if (this.onreadystatechange) this.onreadystatechange();
    }
    failNetwork() {
      if (this.onerror) this.onerror();
      // Real browsers also fire readystatechange(4, status=0); Geocoder.send must settle once
      this.status = 0;
      this.readyState = 4;
      if (this.onreadystatechange) this.onreadystatechange();
    }
  }

  const sandbox = {
    performance: { now: () => nowMs },
    XMLHttpRequest: FakeXHR,
    setTimeout(fn, delay) {
      const entry = { fn, due: nowMs + delay, cleared: false };
      timers.push(entry);
      return entry;
    },
    clearTimeout(entry) {
      if (entry) entry.cleared = true;
    },
    encodeURIComponent,
    parseFloat,
    isNaN,
    Math,
    JSON,
  };

  vm.runInNewContext(geocoderSource, sandbox);
  const { Geocoder } = sandbox;

  const advanceTime = (ms) => {
    nowMs += ms;
    for (const timer of [...timers]) {
      if (!timer.cleared && timer.due <= nowMs) {
        timer.cleared = true;
        timer.fn();
      }
    }
  };

  // 1. Reverse lookup within city boundary + interval & movement throttling
  const labels = [];
  Geocoder.update(40.7128, -74.006, (lbl) => labels.push(lbl));
  assert.equal(xhrs.length, 1);
  assert.match(xhrs[0].url, /reverse\?format=jsonv2&zoom=10&lat=40\.7128&lon=-74\.006/);

  // While pending, duplicate calls are ignored
  Geocoder.update(41.0, -75.0, (lbl) => labels.push(lbl));
  assert.equal(xhrs.length, 1);

  xhrs[0].respond(200, {
    address: { city: "New York", state: "New York", country: "United States" },
  });
  assert.deepEqual(labels, ["New York, New York, United States"]);

  // Within 5000ms interval -> throttled
  advanceTime(2_000);
  Geocoder.update(41.5, -75.5, (lbl) => labels.push(lbl));
  assert.equal(xhrs.length, 1);

  // Past 5000ms but moved < 0.005 deg -> throttled
  advanceTime(4_000);
  Geocoder.update(40.714, -74.008, (lbl) => labels.push(lbl));
  assert.equal(xhrs.length, 1);

  // Moved >= 0.005 deg into a village (counts as Rural) + same label suppression
  Geocoder.update(42.1, -75.2, (lbl) => labels.push(lbl));
  assert.equal(xhrs.length, 2);
  xhrs[1].respond(200, {
    address: { village: "Town of Delhi", county: "Delaware County", country: "United States" },
  });
  assert.deepEqual(labels, [
    "New York, New York, United States",
    "Rural Delaware County, United States",
  ]);

  advanceTime(6_000);
  Geocoder.update(42.2, -75.3, (lbl) => labels.push(lbl));
  assert.equal(xhrs.length, 3);
  xhrs[2].respond(200, {
    address: { hamlet: "Bovina", county: "Delaware County", country: "United States" },
  });
  assert.equal(labels.length, 2); // identical Rural label is not re-emitted

  // 2. Shared Nominatim 1 req/s rate limit + reset() abandoning in-flight and queued stale jobs
  advanceTime(6_000);
  Geocoder.update(35.0, 139.0, (lbl) => labels.push(`stale-inflight:${lbl}`));
  assert.equal(xhrs.length, 4); // sent immediately at t = nowMs

  // Enqueue a search 100ms later while xhrs[3] is still in flight, then reset() and queue a new reverse lookup
  advanceTime(100);
  const searchOutcomes = [];
  Geocoder.search({ city: "  Tokyo ", country: "Japan" }, (err, res) =>
    searchOutcomes.push({ err, res }),
  );
  Geocoder.reset();
  Geocoder.update(-33.8688, 151.2093, (lbl) => labels.push(lbl));

  // Stale in-flight reverse response arrives after reset() -> ignored; drain waits for remaining 900ms window
  xhrs[3].respond(200, { address: { city: "Tokyo", country: "Japan" } });
  assert.equal(labels.some((l) => l.startsWith("stale-inflight:")), false);
  assert.equal(xhrs.length, 4); // paced by MIN_REQUEST_INTERVAL_MS (1000ms)

  advanceTime(950);
  assert.equal(xhrs.length, 5); // search job sent
  assert.match(xhrs[4].url, /search\?format=jsonv2&addressdetails=1&limit=10&city=Tokyo&country=Japan/);
  xhrs[4].respond(200, [
    {
      lat: "35.6762",
      lon: "139.6503",
      address: { state: "Tokyo", city: "Tokyo", country_code: "jp", country: "Japan" },
    },
    {
      lat: "invalid",
      lon: "139.0",
      address: { city: "Skipped" },
    },
    {
      lat: "34.6937",
      lon: "135.5023",
      display_name: "Osaka Prefecture, Japan",
      address: {},
    },
  ]);
  assert.equal(searchOutcomes.length, 1);
  assert.equal(searchOutcomes[0].err, null);
  assert.deepEqual(
    Array.from(searchOutcomes[0].res, (r) => ({ label: r.label, city: r.city })),
    [
      { label: "Tokyo, JP", city: "Tokyo" }, // deduplicates city === state
      { label: "Osaka Prefecture, Japan", city: "Destination" },
    ],
  );

  // Next queued reverse lookup for Sydney drains after another 1000ms
  advanceTime(1_000);
  assert.equal(xhrs.length, 6);
  xhrs[5].respond(200, { address: { town: "Sydney", state: "NSW", country: "Australia" } });
  assert.equal(labels.at(-1), "Sydney, NSW, Australia");

  // 3. Search validation and error branches (empty fields, malformed JSON, network failure, HTTP status)
  const errors = [];
  Geocoder.search({ state: "   ", city: "", country: "" }, (err, res) =>
    errors.push({ err, count: res.length }),
  );
  assert.match(errors[0].err, /Enter a state\/region/);

  advanceTime(1_100);
  Geocoder.search({ country: "Atlantis" }, (err) => errors.push({ err }));
  xhrs.at(-1).respond(200, "{corrupt-json");
  assert.equal(errors[1].err, "Search returned a malformed response.");

  advanceTime(1_100);
  Geocoder.search({ country: "Offline" }, (err) => errors.push({ err }));
  xhrs.at(-1).failNetwork();
  assert.equal(errors.length, 3); // settled once despite both onerror + readystatechange
  assert.equal(errors[2].err, "Search could not reach the geocoding service.");

  advanceTime(1_100);
  Geocoder.search({ country: "RateLimited" }, (err) => errors.push({ err }));
  xhrs.at(-1).respond(503, "Service Unavailable");
  assert.equal(errors[3].err, "Search failed (503).");
});

test("arcade-canvas BaseScene manages high scores, top-10 leaderboards, backdrop alpha, ready/pause bridges, and shutdown cleanup", () => {
  const rawBaseScene = fs.readFileSync(
    path.join(ROOT_FOLDER, "extensions", "arcade-canvas", "game", "scenes", "BaseScene.js"),
    "utf8",
  );
  const transformed =
    rawBaseScene
      .replace(/^export\s+let\s+/gm, "let ")
      .replace(/^export\s+function\s+/gm, "function ")
      .replace(/^export\s+class\s+/gm, "class ") +
    "\nglobalThis.__BaseSceneExports = { BaseScene, refreshDimensions, getWH: () => [W, H] };";

  const storage = new Map([
    ["agentBreak_board_cosmic-rocks", "[999]"],
    ["agentBreak_hi_cosmic-rocks", "999"],
    ["agentArcade_hi_cosmic-rocks", "250"],
    ["agentArcade_bgTransparency", "250"], // clamped to 1.0
  ]);

  const docListeners = new Map();
  const elementsById = new Map();
  const makeDomElement = (tag, id = "") => {
    const classes = new Set();
    const listeners = new Map();
    const el = {
      tagName: tag.toUpperCase(),
      id,
      textContent: "",
      innerHTML: "",
      offsetWidth: 100,
      style: { cssText: "", filter: "", animation: "" },
      children: [],
      classList: {
        add: (...names) => names.forEach((n) => classes.add(n)),
        remove: (...names) => names.forEach((n) => classes.delete(n)),
        contains: (n) => classes.has(n),
        toggle: (n, force) => {
          const next = force === undefined ? !classes.has(n) : Boolean(force);
          if (next) classes.add(n);
          else classes.delete(n);
          return next;
        },
      },
      appendChild(child) {
        this.children.push(child);
        if (child.id) elementsById.set(child.id, child);
        return child;
      },
      remove() {
        if (this.id && elementsById.get(this.id) === this) {
          elementsById.delete(this.id);
        }
      },
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
      dispatch(type, ev = {}) {
        listeners.get(type)?.(ev);
      },
    };
    if (id) elementsById.set(id, el);
    return el;
  };

  for (const id of ["score-value", "hi-value", "lives-value", "level-value", "hud"]) {
    makeDomElement("div", id);
  }
  elementsById.get("hud").classList.add("paused");

  const tauriCalls = [];
  const bridgeCalls = [];
  let resumeRequestCb = null;
  const delayedCallbacks = [];

  const windowObj = {
    innerWidth: 1280,
    innerHeight: 720,
    __TAURI_INTERNALS__: {
      invoke(cmd, args) {
        tauriCalls.push({ cmd, args: args ? { ...args } : undefined });
      },
    },
    agentArcade: {
      setClickThrough: (val) => bridgeCalls.push(["clickThrough", val]),
      setPaused: (val) => bridgeCalls.push(["paused", val]),
      onResumeRequest: (cb) => {
        resumeRequestCb = cb;
      },
    },
    setInterval: () => 77,
  };

  const sandbox = {
    window: windowObj,
    performance: { now: () => 0 },
    clearInterval() {},
    setTimeout() {
      return 1;
    },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    document: {
      head: makeDomElement("head"),
      body: makeDomElement("body"),
      createElement: (tag) => makeDomElement(tag),
      getElementById: (id) => elementsById.get(id) ?? null,
      addEventListener(type, fn) {
        docListeners.set(type, fn);
      },
      removeEventListener(type, fn) {
        if (docListeners.get(type) === fn) docListeners.delete(type);
      },
    },
    Phaser: {
      Scene: class {
        constructor(key) {
          this.scene = {
            key,
            paused: false,
            isActive: () => true,
            pause() {
              this.paused = true;
            },
            resume() {
              this.paused = false;
            },
          };
          this.sound = {
            paused: false,
            stopAll() {},
            pauseAll() {
              this.paused = true;
            },
            resumeAll() {
              this.paused = false;
            },
          };
          this.events = { once: (ev, fn) => (this._onShutdown = { ev, fn }) };
          this.time = {
            delayedCall: (_ms, fn) => {
              const handle = { removed: false, fn, remove() { this.removed = true; } };
              delayedCallbacks.push(handle);
              return handle;
            },
            removeAllEvents: () => {
              this._allTimeEventsCleared = true;
            },
          };
          this.tweens = { add: ({ onComplete }) => onComplete?.() };
          this.textures = { exists: () => false };
          this.add = {
            graphics: () => ({
              alpha: 1,
              x: 0,
              y: 0,
              setDepth() {
                return this;
              },
              fillStyle() {
                return this;
              },
              fillRect() {
                return this;
              },
              fillCircle() {
                return this;
              },
              setScrollFactor() {
                return this;
              },
              setAlpha(a) {
                this.alpha = a;
                return this;
              },
              setPosition(x, y) {
                this.x = x;
                this.y = y;
                return this;
              },
              generateTexture() {},
              destroy() {
                this.destroyed = true;
              },
            }),
            particles: () => ({
              destroyed: false,
              setDepth() {
                return this;
              },
              explode() {},
              destroy() {
                this.destroyed = true;
              },
            }),
            text: () => ({
              setOrigin() {
                return this;
              },
              setDepth() {
                return this;
              },
              destroy() {},
            }),
          };
        }
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(transformed, sandbox);

  const { BaseScene, refreshDimensions, getWH } = sandbox.__BaseSceneExports;
  windowObj.innerWidth = 1920;
  windowObj.innerHeight = 1080;
  refreshDimensions();
  assert.deepEqual([...getWH()], [1920, 1080]);

  const scene = new BaseScene("cosmic-rocks");
  scene.displayName = "Cosmic Rocks";
  scene.initBase();
  scene.loadHighScore();

  // Legacy agentBreak_* keys removed; existing high score loaded and backdrop clamped
  assert.equal(storage.has("agentBreak_hi_cosmic-rocks"), false);
  assert.equal(scene.highScore, 250);
  assert.equal(elementsById.get("hi-value").textContent, "250");
  assert.equal(scene._backdrop.alpha, 1);
  scene.setBackdropAlpha(0);
  assert.equal(scene._backdrop.alpha, 0.01);
  scene.setBackdropAlpha(45);
  assert.equal(scene._backdrop.alpha, 0.45);

  // Leaderboard caps at top 10, ignores <= 0, and updates high score
  assert.equal(scene.addToLeaderboard(0), 0);
  assert.equal(scene.addToLeaderboard(-10), 0);
  for (const pts of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]) {
    scene.score = pts;
    scene.addToLeaderboard(pts);
  }
  assert.equal(scene.highScore, 1000);
  assert.equal(scene.addToLeaderboard(50), 0); // 11th place -> rank 0
  assert.equal(scene.addToLeaderboard(950), 2); // 2nd place -> rank 2
  assert.equal(scene.getLeaderboard().length, 10);

  // Ready screen ignores modifier keys, defers Escape to _wasOnReadyScreen, then starts on Enter
  let startedCount = 0;
  scene.startWithReadyScreen(() => {
    startedCount += 1;
  });
  assert.equal(scene.scene.paused, true);
  assert.ok(elementsById.get("ready-overlay"));

  docListeners.get("keydown")({ key: "Shift", preventDefault() {} });
  assert.ok(elementsById.get("ready-overlay")); // still waiting

  docListeners.get("keydown")({ key: "Escape", preventDefault() {} });
  assert.equal(scene._wasOnReadyScreen, true);
  assert.equal(sandbox.document.getElementById("ready-overlay"), null);

  // Resuming via bridge after Escape on ready screen re-shows ready screen rather than starting gameplay
  resumeRequestCb();
  assert.equal(elementsById.get("hud").classList.contains("paused"), false);
  assert.ok(elementsById.get("ready-overlay"));
  assert.equal(startedCount, 0);

  docListeners.get("keydown")({ key: "Enter", preventDefault() {} });
  assert.equal(scene.scene.paused, false);
  assert.equal(startedCount, 1);

  // Pause bridge notifies agentArcade whereas PauseScene only pauses scene
  windowObj.__agentArcadePause(true);
  assert.equal(scene.scene.paused, true);
  assert.deepEqual(bridgeCalls, [
    ["clickThrough", true],
    ["paused", true],
  ]);
  windowObj.__agentArcadePauseScene(false);
  assert.equal(scene.scene.paused, false);
  assert.equal(bridgeCalls.length, 2);

  // Starfield wrap + showGameOver + shutdown cleanup
  const stars = scene.createStarfield([{ count: 2, speed: 500, size: 2, alpha: 0.8 }]);
  stars[0].y = 1070;
  scene.updateStarfield(stars, 100); // +50 -> 1120 -> wraps to 40
  assert.equal(Math.round(stars[0].y), 40);

  scene.spawnParticleExplosion(10, 20, 0xffffff, 5, 300);
  assert.equal(scene.activeEmitters.length, 1);
  const emitterRef = scene.activeEmitters[0];

  let restarted = 0;
  scene.showGameOver(1200, () => {
    restarted += 1;
  });
  assert.ok(elementsById.get("gameover-overlay"));
  assert.deepEqual(tauriCalls.at(-1), { cmd: "set_click_through", args: { enabled: false } });
  delayedCallbacks.at(-1).fn(); // arm keydown listener after 500ms guard
  docListeners.get("keydown")({ code: "Space", preventDefault() {} });
  assert.equal(restarted, 1);
  assert.deepEqual(tauriCalls.at(-1), { cmd: "set_click_through", args: { enabled: true } });

  scene.showGameOver(800, () => {});
  scene.shutdown();
  assert.equal(emitterRef.destroyed, true);
  assert.equal(scene.activeEmitters.length, 0);
  assert.equal(sandbox.document.getElementById("gameover-overlay"), null);
  assert.equal(scene._allTimeEventsCleared, true);
});

test("java-modernization-studio catalog, renderer, and server routes enforce token auth, doctor caching, body caps, and autopilot gates offline", async (t) => {
  // 1. catalogWithRelevance does not mutate PREDEFINED_TASKS and flags matching signatures
  assert.deepEqual(JAVA_UPGRADE_TARGETS, [11, 17, 21, 25]);
  assert.equal(VALIDATION_GATES.length, 5);
  const relevant = catalogWithRelevance(["awsS3", "ldap"]);
  assert.equal(relevant.find((item) => item.id === "aws-s3-to-blob")?.relevant, true);
  assert.equal(relevant.find((item) => item.id === "entra-id-auth")?.relevant, true);
  assert.equal(relevant.find((item) => item.id === "file-io-to-fileshare")?.relevant, false);
  assert.equal("relevant" in PREDEFINED_TASKS[0], false);

  // 2. resolveRepoPath precedence without process.cwd() fallback
  assert.equal(
    resolveRepoPath({ input: { repoPath: "/from-input" }, session: { workingDirectory: "/from-session" } }, "/last"),
    "/from-input",
  );
  assert.equal(
    resolveRepoPath({ input: {}, session: { workingDirectory: "/from-session" } }, "/last"),
    "/from-session",
  );
  assert.equal(resolveRepoPath({}, "/last"), "/last");
  assert.equal(resolveRepoPath({}, null), null);

  // 3. Renderer embeds instance metadata and action token cleanly
  const html = renderCockpitHtml({
    instanceId: "inst-42",
    initialTab: "readiness",
    token: "dummy-cockpit-token",
  });
  assert.match(html, /Java Modernization Studio/i);
  assert.equal(html.includes("dummy-cockpit-token"), true);

  // 4. buildState doctor caching, dead SSE client pruning, autopilot blocked gate, and HTTP handler
  const repoDir = makeTempDir(t, "jms-server-repo-");
  fs.mkdirSync(path.join(repoDir, ".appmod"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, ".appmod", "assessment.json"), "{}", "utf8");
  fs.writeFileSync(
    path.join(repoDir, "pom.xml"),
    "<project><properties><java.version>8</java.version></properties></project>",
    "utf8",
  );
  fs.writeFileSync(path.join(repoDir, "progress.md"), "- [ ] Upgrade Java 8 to 17\n", "utf8");

  let doctorCalls = 0;
  let doctorOverall = "blocked";
  const ssePayloads = [];
  const deadClient = {
    write() {
      throw new Error("broken pipe");
    },
  };
  const liveClient = {
    write(chunk) {
      ssePayloads.push(chunk);
    },
  };

  const rec = {
    repoPath: repoDir,
    token: "dummy-token",
    doctor: null,
    autopilot: null,
    sseClients: new Set([deadClient, liveClient]),
    async runDoctor() {
      doctorCalls += 1;
      return { overall: doctorOverall, tools: [] };
    },
  };

  const firstState = await buildState(rec);
  assert.equal(firstState.ok, true);
  assert.equal(doctorCalls, 1);
  assert.equal(firstState.doctor.overall, "blocked");

  // Cached on subsequent refresh; recomputed on recheckEnv:true
  await pushState(rec);
  assert.equal(doctorCalls, 1);
  assert.equal(rec.sseClients.has(deadClient), false); // dead client pruned on broadcast
  assert.equal(ssePayloads.length, 1);

  doctorOverall = "ready";
  const rechecked = await dispatchAction(rec, "recheck_env", {}, {});
  assert.equal(doctorCalls, 2);
  assert.equal(rechecked.state.doctor.overall, "ready");

  // Blocked doctor prevents autopilot unless force:true
  rec.doctor = { overall: "blocked", tools: [] };
  const blockedStart = await startAutopilot(rec, {}, { runTurn: async () => {} });
  assert.equal(blockedStart.ok, false);
  assert.match(blockedStart.error, /environment isn't ready/);

  let turnPrompts = [];
  const forcedStart = await startAutopilot(
    rec,
    { force: true, maxSteps: 999, scope: "all" },
    {
      async runTurn(prompt) {
        turnPrompts.push(prompt);
        // Mark step done so autopilot finishes deterministically in 1 turn
        fs.writeFileSync(path.join(repoDir, "progress.md"), "- [x] Upgrade Java 8 to 17\n", "utf8");
      },
    },
  );
  assert.equal(forcedStart.ok, true);
  assert.equal(forcedStart.autopilot.maxSteps, 50); // clamped to 50
  await rec.autopilotPromise;
  assert.equal(turnPrompts.length, 1);
  assert.equal(rec.autopilot.running, false);

  const stopWhenIdle = await dispatchAction(rec, "autopilot_stop", {}, {});
  assert.equal(stopWhenIdle.ok, false);
  const dismissed = await dispatchAction(rec, "autopilot_dismiss", {}, {});
  assert.equal(dismissed.ok, true);
  assert.equal(rec.autopilot, null);

  // HTTP handler: 403 token check, GET /state, GET /events, POST /action (valid, invalid JSON 400, >256KB 413), and 404
  const sentPrompts = [];
  const handler = makeHandler(rec, {
    instanceId: "inst-1",
    initialTab: "overview",
    sendPrompt: async (p) => sentPrompts.push(p),
    runTurn: async () => {},
  });

  const makeFakeRes = () => ({
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    writeHead(code, hdrs = {}) {
      this.statusCode = code;
      for (const [k, v] of Object.entries(hdrs)) this.headers[k.toLowerCase()] = v;
    },
    write(chunk) {
      this.body += chunk;
    },
    end(chunk = "") {
      this.body += chunk;
    },
  });

  // Missing token -> 403
  {
    const req = new EventEmitter();
    req.method = "GET";
    req.url = "/state";
    const res = makeFakeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
  }

  // Valid token GET /state -> 200
  {
    const req = new EventEmitter();
    req.method = "GET";
    req.url = "/state?token=dummy-token";
    const res = makeFakeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).assessment.javaVersion, "8");
  }

  // Invalid JSON POST /action -> 400
  {
    const req = new EventEmitter();
    req.method = "POST";
    req.url = "/action?token=dummy-token";
    const res = makeFakeRes();
    const p = handler(req, res);
    req.emit("data", "{not-json");
    req.emit("end");
    await p;
    assert.equal(res.statusCode, 400);
  }

  // Oversized POST /action (> 256 KiB) -> 413 and destroys request stream
  {
    const req = new EventEmitter();
    req.method = "POST";
    req.url = "/action?token=dummy-token";
    let destroyed = false;
    req.destroy = () => {
      destroyed = true;
    };
    const res = makeFakeRes();
    const p = handler(req, res);
    req.emit("data", "x".repeat(260 * 1024));
    await p;
    assert.equal(res.statusCode, 413);
    assert.equal(destroyed, true);
  }

  // Valid prompt action + 404 fallback
  {
    const req = new EventEmitter();
    req.method = "POST";
    req.url = "/action?token=dummy-token";
    const res = makeFakeRes();
    const p = handler(req, res);
    req.emit("data", JSON.stringify({ kind: "generate_plan", payload: { targetJava: 21 } }));
    req.emit("end");
    await p;
    assert.equal(res.statusCode, 200);
    assert.equal(sentPrompts.length, 1);
  }
  {
    const req = new EventEmitter();
    req.method = "GET";
    req.url = "/unknown?token=dummy-token";
    const res = makeFakeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
  }
});
