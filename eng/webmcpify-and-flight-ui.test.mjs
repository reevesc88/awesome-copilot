import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { analyzeNpmCache, discoverNpmCachePath } from "../extensions/windows-app-storage-inspector-cleanup/src/analyzers/npm-cache.mjs";
import { analyzeUvCache, discoverUvCachePaths } from "../extensions/windows-app-storage-inspector-cleanup/src/analyzers/uv-cache.mjs";
import { analyzeVsCodeInsiders } from "../extensions/windows-app-storage-inspector-cleanup/src/analyzers/vscode-insiders.mjs";
import {
  buildFolderExplanationPrompt,
  parseFolderExplanation,
  parseFolderExplanationCandidates,
} from "../extensions/windows-app-storage-inspector-cleanup/src/core/folder-explanation.mjs";
import { ROOT_FOLDER } from "./constants.mjs";

const webmcpifySource = fs.readFileSync(
  path.join(ROOT_FOLDER, "skills", "webmcpify", "templates", "webmcpify.js"),
  "utf8",
);
const {
  createToolScope,
  dispatchAndWait,
  getModelContext,
  isWebMCPAvailable,
  singleFlight,
} = await import(`data:text/javascript;base64,${Buffer.from(webmcpifySource, "utf8").toString("base64")}`);

const require = createRequire(import.meta.url);
const {
  captureConsoleLogs,
  captureScreenshot,
  waitForCondition,
} = require("../skills/webapp-testing/assets/test-helper.js");

const FLIGHT_GAME_DIR = path.join(ROOT_FOLDER, "extensions", "flight-map-canvas", "game");

function makeTempDir(t, prefix = "awesome-copilot-webmcp-flight-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readFlightScript(filename) {
  return fs.readFileSync(path.join(FLIGHT_GAME_DIR, filename), "utf8");
}

function createFakeThree() {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }
    clone() {
      return new Vector3(this.x, this.y, this.z);
    }
    copy(other) {
      this.x = other.x;
      this.y = other.y;
      this.z = other.z;
      return this;
    }
    addScaledVector(v, scale) {
      this.x += v.x * scale;
      this.y += v.y * scale;
      this.z += v.z * scale;
      return this;
    }
    applyQuaternion(q) {
      const { x, y, z } = this;
      const { x: qx, y: qy, z: qz, w: qw } = q;
      const ix = qw * x + qy * z - qz * y;
      const iy = qw * y + qz * x - qx * z;
      const iz = qw * z + qx * y - qy * x;
      const iw = -qx * x - qy * y - qz * z;
      this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
      this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
      this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
      return this;
    }
  }

  class Quaternion {
    constructor(x = 0, y = 0, z = 0, w = 1) {
      this.x = x;
      this.y = y;
      this.z = z;
      this.w = w;
    }
    copy(other) {
      this.x = other.x;
      this.y = other.y;
      this.z = other.z;
      this.w = other.w;
      return this;
    }
    setFromAxisAngle(axis, angle) {
      const len = Math.hypot(axis.x, axis.y, axis.z) || 1;
      const half = angle / 2;
      const s = Math.sin(half) / len;
      this.x = axis.x * s;
      this.y = axis.y * s;
      this.z = axis.z * s;
      this.w = Math.cos(half);
      return this;
    }
    premultiply(q) {
      const ax = q.x, ay = q.y, az = q.z, aw = q.w;
      const bx = this.x, by = this.y, bz = this.z, bw = this.w;
      this.x = ax * bw + aw * bx + ay * bz - az * by;
      this.y = ay * bw + aw * by + az * bx - ax * bz;
      this.z = az * bw + aw * bz + ax * by - ay * bx;
      this.w = aw * bw - ax * bx - ay * by - az * bz;
      return this;
    }
    normalize() {
      const len = Math.hypot(this.x, this.y, this.z, this.w) || 1;
      this.x /= len;
      this.y /= len;
      this.z /= len;
      this.w /= len;
      return this;
    }
    setFromUnitVectors(vFrom, vTo) {
      let r = vFrom.x * vTo.x + vFrom.y * vTo.y + vFrom.z * vTo.z + 1;
      if (r < 1e-6) {
        this.x = 1;
        this.y = 0;
        this.z = 0;
        this.w = 0;
      } else {
        this.x = vFrom.y * vTo.z - vFrom.z * vTo.y;
        this.y = vFrom.z * vTo.x - vFrom.x * vTo.z;
        this.z = vFrom.x * vTo.y - vFrom.y * vTo.x;
        this.w = r;
      }
      return this.normalize();
    }
    slerp(qb, t) {
      this.x += (qb.x - this.x) * t;
      this.y += (qb.y - this.y) * t;
      this.z += (qb.z - this.z) * t;
      this.w += (qb.w - this.w) * t;
      return this.normalize();
    }
  }

  class PerspectiveCamera {
    constructor() {
      this.position = new Vector3();
      this.quaternion = new Quaternion();
    }
    lookAt(target) {
      const dx = target.x - this.position.x;
      const dz = target.z - this.position.z;
      const yaw = Math.atan2(-dx, -dz);
      this.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), yaw);
    }
  }

  return { Vector3, Quaternion, PerspectiveCamera };
}

test("webmcpify runtime manages tool scopes, rollback on sync/async/unmount races, fail-closed completions, and singleFlight locks", async (t) => {
  const hadDoc = "document" in globalThis;
  const origDoc = globalThis.document;
  const hadWin = "window" in globalThis;
  const origWin = globalThis.window;
  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  t.after(() => {
    if (hadDoc) globalThis.document = origDoc;
    else delete globalThis.document;
    if (hadWin) globalThis.window = origWin;
    else delete globalThis.window;
    if (origNavDesc) Object.defineProperty(globalThis, "navigator", origNavDesc);
    else delete globalThis.navigator;
  });

  delete globalThis.document;
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });

  // 1. Unavailable WebMCP returns no-op handles
  assert.equal(getModelContext(), undefined);
  assert.equal(isWebMCPAvailable(), false);
  const noopScope = createToolScope("noop-scope", [{ name: "ping", description: "Ping" }]);
  assert.equal(await noopScope.ready, false);
  noopScope();

  // Fallback to navigator.modelContext, while document.modelContext wins when present
  const navMc = { registerTool: async () => {} };
  globalThis.navigator = { modelContext: navMc };
  assert.equal(getModelContext(), navMc);

  const registeredCalls = [];
  const docMc = {
    registerTool(tool, opts) {
      registeredCalls.push({ tool, opts });
      return tool._impl ? tool._impl() : Promise.resolve();
    },
  };
  globalThis.document = { modelContext: docMc };
  assert.equal(getModelContext(), docMc);
  assert.equal(isWebMCPAvailable(), true);

  // 2. Contract validation rejects bad names and missing/oversized descriptions before registering or locking key
  assert.throws(
    () => createToolScope("valid-key", [{ name: "bad space", description: "ok" }], { validate: true }),
    /1-30 chars/,
  );
  assert.throws(
    () => createToolScope("valid-key", [{ name: "good_name", description: "" }], { validate: true }),
    /missing a description/,
  );
  assert.throws(
    () =>
      createToolScope(
        "valid-key",
        [{ name: "good_name", description: "x".repeat(501) }],
        { validate: true },
      ),
    /exceeds 500 chars/,
  );
  assert.equal(registeredCalls.length, 0);

  // 3. Active scope commits, forwards exposedTo + signal, blocks duplicate key, and frees key on dispose
  const activeHandle = createToolScope(
    "valid-key",
    [{ name: "search.tickets", description: "Search tickets" }],
    { validate: true, exposedTo: ["agent"] },
  );
  assert.equal(await activeHandle.ready, true);
  assert.equal(registeredCalls.length, 1);
  assert.deepEqual(registeredCalls[0].opts.exposedTo, ["agent"]);
  assert.equal(registeredCalls[0].opts.signal.aborted, false);

  const dupHandle = createToolScope("valid-key", [{ name: "other", description: "Other" }]);
  assert.equal(await dupHandle.ready, false);
  assert.equal(registeredCalls[0].opts.signal.aborted, false);

  activeHandle();
  assert.equal(registeredCalls[0].opts.signal.aborted, true);

  // 4. Synchronous throw AND async rejection roll back, report to onError, and free scope key
  const capturedErrors = [];
  const syncFail = createToolScope(
    "valid-key",
    [
      {
        name: "legacy_sync",
        description: "Throws sync",
        _impl() {
          throw new Error("sync boom");
        },
      },
    ],
    { validate: true, onError: (err) => capturedErrors.push(err.message) },
  );
  assert.equal(await syncFail.ready, false);
  assert.deepEqual(capturedErrors, ["sync boom"]);

  // Disposing before async registration settles rolls back silently WITHOUT calling onError
  let rejectPending;
  const unmountHandle = createToolScope(
    "valid-key",
    [
      {
        name: "slow_tool",
        description: "Unmounted early",
        _impl: () =>
          new Promise((_, rej) => {
            rejectPending = rej;
          }),
      },
    ],
    { validate: true, onError: () => capturedErrors.push("should-not-fire") },
  );
  unmountHandle();
  rejectPending(new Error("late failure"));
  assert.equal(await unmountHandle.ready, false);
  assert.deepEqual(capturedErrors, ["sync boom"]);

  // 5. dispatchAndWait: ok:true, ok:false, malformed completion without boolean ok, and timeout abort
  const winTarget = new EventTarget();
  globalThis.window = winTarget;

  winTarget.addEventListener("webmcp:save", (ev) => {
    const { requestId, mode } = ev.detail;
    if (mode === "success") {
      winTarget.dispatchEvent(
        new CustomEvent(`tool-completion-${requestId}`, {
          detail: { ok: true, message: "Saved record #7." },
        }),
      );
    } else if (mode === "fail") {
      winTarget.dispatchEvent(
        new CustomEvent(`tool-completion-${requestId}`, {
          detail: { ok: false, error: "Validation failed." },
        }),
      );
    } else if (mode === "ambiguous") {
      winTarget.dispatchEvent(
        new CustomEvent(`tool-completion-${requestId}`, {
          detail: { ok: "yes" },
        }),
      );
    }
  });

  assert.equal(await dispatchAndWait("webmcp:save", { mode: "success" }), "Saved record #7.");
  assert.equal(await dispatchAndWait("webmcp:save", { mode: "fail" }), "ERROR: Validation failed.");
  assert.match(
    await dispatchAndWait("webmcp:save", { mode: "ambiguous" }),
    /^ERROR:.*without a boolean `ok`/,
  );

  let observedTimeoutSignal = null;
  winTarget.addEventListener("webmcp:stall", (ev) => {
    observedTimeoutSignal = ev.detail.signal;
  });
  const timeoutMsg = await dispatchAndWait("webmcp:stall", {}, 15);
  assert.match(timeoutMsg, /^ERROR: The interface did not confirm this action in time\./);
  assert.equal(observedTimeoutSignal?.aborted, true);

  // 6. singleFlight serializes concurrent executions and unlocks even after thrown errors
  let releaseFirst;
  const guarded = singleFlight(async (val) => {
    if (val === "throw") throw new Error("handler error");
    await new Promise((r) => {
      releaseFirst = r;
    });
    return `done:${val}`;
  }, "ERROR: Busy.");

  const firstCall = guarded("one");
  assert.equal(await guarded("two"), "ERROR: Busy.");
  releaseFirst();
  assert.equal(await firstCall, "done:one");
  await assert.rejects(() => guarded("throw"), /handler error/);
  // Lock is released in finally block after rejection
  const afterThrow = guarded("three");
  releaseFirst();
  assert.equal(await afterThrow, "done:three");
});

test("webapp-testing test-helper polls async conditions, records console logs, and names screenshots deterministically", async () => {
  let checks = 0;
  const ok = await waitForCondition(async () => {
    checks += 1;
    return checks >= 2;
  }, 500, 5);
  assert.equal(ok, true);
  assert.equal(checks, 2);

  await assert.rejects(
    () => waitForCondition(() => false, 20, 5),
    /Condition not met within timeout/,
  );

  const handlers = new Map();
  const shots = [];
  const fakePage = {
    on(event, fn) {
      handlers.set(event, fn);
    },
    async screenshot(opts) {
      shots.push(opts);
    },
  };

  const logs = captureConsoleLogs(fakePage);
  handlers.get("console")({ type: () => "warning", text: () => "Deprecated API" });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].type, "warning");
  assert.equal(logs[0].text, "Deprecated API");

  const origLog = console.log;
  console.log = () => {};
  try {
    const filename = await captureScreenshot(fakePage, "checkout-flow");
    assert.match(filename, /^checkout-flow-\d{4}-\d{2}-\d{2}T.*Z\.png$/);
    assert.deepEqual(shots, [{ path: filename, fullPage: true }]);
  } finally {
    console.log = origLog;
  }
});

test("flight-map-canvas DestinationInput dialog and FlightControls 3D physics/drag fallback work offline", () => {
  // 1. DestinationInput: country menu population, search error/empty/results, keyboard navigation, and commit
  function makeClassList(initial = []) {
    const set = new Set(initial);
    return {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      toggle: (c, force) => {
        const shouldHave = force === undefined ? !set.has(c) : Boolean(force);
        if (shouldHave) set.add(c);
        else set.delete(c);
        return shouldHave;
      },
      contains: (c) => set.has(c),
    };
  }

  function makeDomElement(id, initialClasses = []) {
    const listeners = new Map();
    const attrs = new Map();
    const el = {
      id,
      value: "",
      textContent: "",
      disabled: false,
      dataset: {},
      className: "",
      classList: makeClassList(initialClasses),
      children: [],
      focused: false,
      selectedText: false,
      set innerHTML(val) {
        if (val === "") this.children = [];
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
      },
      getAttribute(k) {
        return attrs.get(k) ?? null;
      },
      removeAttribute(k) {
        attrs.delete(k);
      },
      addEventListener(type, fn) {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      dispatch(type, eventProps = {}) {
        for (const fn of listeners.get(type) ?? []) {
          fn({
            target: el,
            preventDefault() {},
            stopPropagation() {},
            ...eventProps,
          });
        }
      },
      focus() {
        this.focused = true;
      },
      select() {
        this.selectedText = true;
      },
      scrollIntoView() {},
      closest(sel) {
        return sel === ".dest-result" && this.className === "dest-result" ? this : null;
      },
    };
    return el;
  }

  const elementsById = new Map([
    ["destination-dialog", makeDomElement("destination-dialog", ["hidden"])],
    ["destination-form", makeDomElement("destination-form")],
    ["destination-results", makeDomElement("destination-results", ["hidden"])],
    ["dest-state", makeDomElement("dest-state")],
    ["dest-city", makeDomElement("dest-city")],
    ["dest-country", makeDomElement("dest-country")],
    ["dest-form-message", makeDomElement("dest-form-message")],
    ["dest-results-message", makeDomElement("dest-results-message")],
    ["dest-result-list", makeDomElement("dest-result-list")],
    ["dest-search", makeDomElement("dest-search")],
    ["dest-select", makeDomElement("dest-select")],
    ["dest-cancel", makeDomElement("dest-cancel")],
    ["dest-results-cancel", makeDomElement("dest-results-cancel")],
  ]);

  let geocoderResponder = null;
  const destCtx = {
    parseInt,
    String,
    CAPITALS_BY_REGION: [
      { capitals: [{ country: "Japan" }, { country: "Australia" }, { country: "Japan" }] },
      { capitals: [{ country: "Brazil" }] },
    ],
    Geocoder: {
      search(query, cb) {
        geocoderResponder(query, cb);
      },
    },
    document: {
      getElementById: (id) => elementsById.get(id) ?? null,
      createElement: (tag) => makeDomElement(tag),
    },
  };

  vm.runInNewContext(readFlightScript("destinationInput.js"), destCtx);
  const { DestinationInput } = destCtx;

  const events = [];
  let selectedDest = null;
  DestinationInput.init({
    onOpen: () => events.push("open"),
    onClose: () => events.push("close"),
    onSelect: (dest) => {
      selectedDest = dest;
      events.push(`select:${dest.label}`);
    },
  });

  // Countries sorted alphabetically and deduplicated
  assert.deepEqual(
    elementsById.get("dest-country").children.map((o) => o.value),
    ["Australia", "Brazil", "Japan"],
  );

  DestinationInput.open();
  assert.equal(DestinationInput.isOpen(), true);
  assert.equal(elementsById.get("dest-state").focused, true);

  // Error from Geocoder stays on form stage and displays message
  geocoderResponder = (_q, cb) => cb("Enter a destination.", null);
  elementsById.get("dest-search").dispatch("click");
  assert.equal(elementsById.get("dest-form-message").textContent, "Enter a destination.");
  assert.equal(elementsById.get("destination-results").classList.contains("hidden"), true);

  // Empty result list displays no-match message with disabled Select button
  geocoderResponder = (_q, cb) => cb(null, []);
  elementsById.get("destination-form").dispatch("keydown", { key: "Enter" });
  assert.match(elementsById.get("dest-results-message").textContent, /No matching destination/);
  assert.equal(elementsById.get("dest-select").disabled, true);

  // Reopen via Escape -> open(), search 2 matches, arrow down, Enter commits selection
  elementsById.get("destination-dialog").dispatch("keydown", { key: "Escape" });
  assert.equal(DestinationInput.isOpen(), false);

  DestinationInput.open();
  elementsById.get("dest-city").value = "Kyoto";
  elementsById.get("dest-country").value = "Japan";
  geocoderResponder = (q, cb) => {
    assert.equal(q.city, "Kyoto");
    assert.equal(q.country, "Japan");
    cb(null, [
      { label: "Kyoto North, JP", lat: 35.05, lng: 135.75 },
      { label: "Kyoto Station, JP", lat: 34.9858, lng: 135.7588 },
    ]);
  };
  elementsById.get("dest-search").dispatch("click");

  const resultList = elementsById.get("dest-result-list");
  assert.equal(resultList.children.length, 2);
  assert.equal(resultList.getAttribute("aria-activedescendant"), "dest-result-0");

  resultList.dispatch("keydown", { key: "ArrowDown" });
  resultList.dispatch("keydown", { key: "ArrowDown" }); // clamps at last item
  assert.equal(resultList.getAttribute("aria-activedescendant"), "dest-result-1");
  assert.equal(resultList.children[1].getAttribute("aria-selected"), "true");

  resultList.dispatch("keydown", { key: "Enter" });
  assert.equal(DestinationInput.isOpen(), false);
  assert.equal(selectedDest?.label, "Kyoto Station, JP");
  assert.deepEqual(events, ["open", "close", "open", "close", "select:Kyoto Station, JP"]);

  // 2. FlightControls: pointer-lock refusal -> drag fallback, mouse look, throttle+boost, altitude floor, auto-level, resetTo, and release
  const THREE = createFakeThree();
  const docListeners = new Map();
  const domListeners = new Map();
  const flightEvents = [];
  const timers = [];

  const canvasEl = {
    tagName: "CANVAS",
    addEventListener(type, fn) {
      domListeners.set(type, fn);
    },
    requestPointerLock() {
      throw new Error("Pointer lock denied by sandboxed iframe");
    },
  };

  const fcCtx = {
    THREE,
    Math,
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    setTimeout(fn, ms) {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout() {},
    document: {
      pointerLockElement: null,
      addEventListener(type, fn) {
        docListeners.set(type, fn);
      },
      dispatchEvent(ev) {
        flightEvents.push(ev.detail);
      },
      exitPointerLock() {},
    },
  };

  vm.runInNewContext(readFlightScript("flightControls.js"), fcCtx);
  const camera = new THREE.PerspectiveCamera();
  camera.position.copy(new THREE.Vector3(0, 50, 0));
  const controls = new fcCtx.FlightControls(camera, canvasEl);

  // Clicking canvas when requestPointerLock throws falls back to drag mode and engages immediately
  domListeners.get("click")();
  assert.equal(controls.lookMode, "drag");
  assert.equal(controls.isEnabled, true);
  assert.deepEqual({ ...flightEvents.at(-1) }, { locked: true, mode: "drag" });

  // Dragging updates mouse deltas and pitches/yaws quaternion on update()
  domListeners.get("mousedown")({ button: 0, preventDefault() {} });
  assert.equal(controls.isDragging, true);
  docListeners.get("mousemove")({ movementX: 50, movementY: -25 });
  controls.update(0.05);
  assert.ok(controls.getPitch() > 0);
  assert.notEqual(controls.getHeading(), 0);
  docListeners.get("mouseup")();
  assert.equal(controls.isDragging, false);

  // Throttle + Shift boost accelerates above normal maxSpeed (12), while F descend clamps at minAltitude (8)
  const canvasTarget = { tagName: "CANVAS", closest: () => null };
  docListeners.get("keydown")({ code: "KeyW", target: canvasTarget });
  docListeners.get("keydown")({ code: "ShiftLeft", target: canvasTarget });
  docListeners.get("keydown")({ code: "KeyA", target: canvasTarget });
  docListeners.get("keydown")({ code: "KeyQ", target: canvasTarget });
  for (let step = 0; step < 60; step++) {
    controls.update(0.1);
  }
  assert.ok(controls.getSpeed() > 12, `expected boosted speed > 12, got ${controls.getSpeed()}`);
  assert.notEqual(controls.getRoll(), 0);

  // Space auto-levels roll back toward 0
  docListeners.get("keyup")({ code: "KeyA", target: canvasTarget });
  docListeners.get("keyup")({ code: "KeyQ", target: canvasTarget });
  const rollBeforeLevel = Math.abs(controls.getRoll());
  docListeners.get("keydown")({ code: "Space", target: canvasTarget, preventDefault() {} });
  for (let step = 0; step < 20; step++) {
    controls.update(0.1);
  }
  assert.ok(Math.abs(controls.getRoll()) < rollBeforeLevel);

  // Descending past minAltitude from a level hover clamps altitude at 8
  docListeners.get("keyup")({ code: "Space", target: canvasTarget });
  docListeners.get("keyup")({ code: "KeyW", target: canvasTarget });
  docListeners.get("keyup")({ code: "ShiftLeft", target: canvasTarget });
  controls.resetTo(new THREE.Vector3(0, 20, 0), new THREE.Vector3(0, 20, -10));
  docListeners.get("keydown")({ code: "KeyF", target: canvasTarget });
  for (let step = 0; step < 60; step++) {
    controls.update(0.1);
  }
  assert.equal(controls.getAltitude(), controls.minAltitude);
  docListeners.get("keyup")({ code: "KeyF", target: canvasTarget });

  // resetTo zeroes velocities and points toward target; Escape in drag mode releases and clears keys
  controls.resetTo(new THREE.Vector3(10, 100, 10), new THREE.Vector3(10, 100, 0));
  assert.equal(controls.getSpeed(), 0);
  assert.equal(controls.getAltitude(), 100);
  docListeners.get("keydown")({ code: "Escape", target: canvasTarget });
  assert.equal(controls.isEnabled, false);
  assert.deepEqual({ ...controls.keys }, {});
});

test("storage-inspector folder-explanation, npm-cache, uv-cache, and vscode-insiders analyzers handle edge cases offline", async (t) => {
  const dir = makeTempDir(t, "storage-inspector-analyzers-");
  const savedEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  // 1. folder-explanation: BOM + surrounding prose, unsafe URL filtering, command defaults, and empty candidate errors
  const prompt = buildFolderExplanationPrompt({ path: "C:\\Users\\Ada\\AppData\\Local\\Temp" });
  assert.match(prompt, /"path":"C:\\\\Users\\\\Ada\\\\AppData\\\\Local\\\\Temp"/);

  assert.throws(
    () => parseFolderExplanationCandidates(["", "   "]),
    { code: "folder_explanation_empty" },
  );
  assert.throws(
    () =>
      parseFolderExplanation(
        JSON.stringify({
          version: 1,
          title: "Cache",
          summary: "Summary",
          cleanup: { recommendation: "reckless", summary: "s", risk: "r", impact: "i" },
        }),
      ),
    { code: "folder_explanation_invalid" },
  );

  const parsedExplanation = parseFolderExplanation(
    `\uFEFFHere is the analysis:\n${JSON.stringify({
      version: 1,
      title: "  Package Cache  ",
      application: "",
      summary: "Cached tarballs.",
      contents: [
        { name: "Tarballs", description: "Compressed packages" },
        { name: "   " },
        null,
      ],
      typicalUses: ["Offline installs", "", 42],
      bestPractices: ["Use cache verify"],
      cleanup: {
        recommendation: "safe",
        summary: "Safe to clear when idle.",
        risk: "Re-download on next install.",
        impact: "Slower cold install.",
        commands: [
          { command: "  npm cache clean --force  ", requiresElevation: "yes" },
          { command: "   " },
        ],
        steps: ["Close active builds"],
        warnings: ["Wait for installs to finish"],
      },
      sources: [
        { title: "", url: "https://docs.npmjs.com/cli/cache" },
        { title: "XSS", url: "javascript:alert(1)" },
        { title: "FTP", url: "ftp://files.example.com/doc" },
        { title: "Bad", url: "::not-a-url" },
      ],
    })}\nDone.`,
  );
  assert.equal(parsedExplanation.application, "Unknown");
  assert.equal(parsedExplanation.contents.length, 1);
  assert.equal(parsedExplanation.cleanup.commands.length, 1);
  assert.equal(parsedExplanation.cleanup.commands[0].label, "Cleanup command");
  assert.equal(parsedExplanation.cleanup.commands[0].shell, "Terminal");
  assert.equal(parsedExplanation.cleanup.commands[0].requiresElevation, false);
  assert.deepEqual(parsedExplanation.sources, [
    { title: "docs.npmjs.com", url: "https://docs.npmjs.com/cli/cache" },
  ]);

  // 2. npm-cache and uv-cache fallback paths + byte deduplication when PATH has no npm.cmd / uv.exe
  const localAppData = path.join(dir, "LocalAppData");
  const emptyBin = path.join(dir, "empty-bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  process.env.LOCALAPPDATA = localAppData;
  process.env.PATH = emptyBin;

  const npmCacheDir = path.resolve(localAppData, "npm-cache");
  const npmFile = path.join(npmCacheDir, "_cacache", "blob.bin");
  fs.mkdirSync(path.dirname(npmFile), { recursive: true });
  fs.writeFileSync(npmFile, "blob", "utf8");

  const discoveredNpm = await discoverNpmCachePath();
  assert.equal(discoveredNpm.path, npmCacheDir);
  const npmResult = await analyzeNpmCache({
    directories: [{ path: npmCacheDir, bytes: 8192, files: 3 }],
    largestFiles: [
      { path: npmFile, bytes: 8192 },
      { path: path.join(dir, "other.bin"), bytes: 99999 },
    ],
  });
  assert.equal(npmResult.status, "available");
  assert.equal(npmResult.totalBytes, 8192);
  assert.deepEqual(npmResult.topFiles.map((f) => f.path), [npmFile]);

  const uvRoot = path.resolve(localAppData, "uv");
  const uvCacheSubdir = path.join(uvRoot, "cache");
  const uvWheel = path.join(uvCacheSubdir, "pkg.whl");
  fs.mkdirSync(uvCacheSubdir, { recursive: true });
  fs.writeFileSync(uvWheel, "wheel", "utf8");

  const uvPaths = await discoverUvCachePaths();
  assert.equal(uvPaths.includes(uvRoot), true);
  assert.equal(uvPaths.includes(uvCacheSubdir), true);

  // Because uv/cache is inside uv/, totalBytes must NOT double-count cache.bytes on top of root.bytes!
  const uvResult = await analyzeUvCache({
    directories: [
      { path: uvRoot, bytes: 10_000, files: 5 },
      { path: uvCacheSubdir, bytes: 7_000, files: 4 },
    ],
    largestFiles: [{ path: uvWheel, bytes: 7_000 }],
  });
  assert.equal(uvResult.status, "available");
  assert.equal(uvResult.totalBytes, 10_000);
  assert.equal(uvResult.cacheBytes, 7_000);
  assert.equal(uvResult.locations.length, 2);

  // 3. vscode-insiders: parses 10-hex-char commit folders, skips incomplete/non-hex folders, and groups versions
  const vscodeRoot = path.resolve(localAppData, "Programs", "Microsoft VS Code Insiders");
  const commitA = path.join(vscodeRoot, "a1b2c3d4e5");
  const commitB = path.join(vscodeRoot, "f6e5d4c3b2");
  const incompleteCommit = path.join(vscodeRoot, "0123456789");
  const nonHexFolder = path.join(vscodeRoot, "bin");
  fs.mkdirSync(path.join(commitA, "resources", "app"), { recursive: true });
  fs.mkdirSync(path.join(commitB, "resources", "app"), { recursive: true });
  fs.mkdirSync(incompleteCommit, { recursive: true });
  fs.mkdirSync(nonHexFolder, { recursive: true });

  fs.writeFileSync(
    path.join(commitA, "resources", "app", "package.json"),
    JSON.stringify({ version: "1.99.0-insider" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(commitB, "resources", "app", "package.json"),
    JSON.stringify({ version: "1.99.0-insider" }),
    "utf8",
  );
  const appAsar = path.join(commitA, "resources", "app.asar");
  fs.writeFileSync(appAsar, "asar", "utf8");

  const vscodeResult = await analyzeVsCodeInsiders({
    directories: [
      { path: vscodeRoot, bytes: 350_000, files: 20 },
      { path: commitA, bytes: 200_000, files: 10 },
      { path: commitB, bytes: 120_000, files: 8 },
    ],
    largestFiles: [{ path: appAsar, bytes: 200_000 }],
  });
  assert.equal(vscodeResult.folderCount, 2);
  assert.equal(vscodeResult.versionBytes, 320_000);
  assert.equal(vscodeResult.nonVersionBytes, 30_000);
  assert.equal(vscodeResult.versions.length, 1);
  assert.equal(vscodeResult.versions[0].version, "1.99.0-insider");
  assert.equal(vscodeResult.versions[0].folders, 2);
  assert.equal(vscodeResult.versions[0].bytes, 320_000);
  assert.deepEqual(vscodeResult.topFiles.map((f) => f.path), [appAsar]);
});
