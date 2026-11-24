import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import {
  AUTOPILOT_MAX_STEPS,
  currentSteps,
  isStepDone,
  makeRun,
  runAutopilot,
  selectNextStep,
  stepKey,
} from "../extensions/java-modernization-studio/autopilot.mjs";
import {
  augmentedEnv,
  buildDoctorReport,
  discoverJavaHome,
  expandJavaHomeValue,
  parseJavaHomeFromRc,
  parseToolVersion,
  probeOne,
} from "../extensions/java-modernization-studio/doctor.mjs";
import { buildPrompt } from "../extensions/java-modernization-studio/prompts.mjs";
import { scanRepo } from "../extensions/java-modernization-studio/scan.mjs";
import {
  buildDeskAgentArgv,
  isSafeQuotedWindowsCmdArg,
  isSafeWindowsCmdShim,
  isWindowsAppExecutionAlias,
  parsePluginMcpNames,
} from "../extensions/signals-dashboard/launch-profile.mjs";
import {
  LOCAL_DELEGATION_ORIENT_LINE,
  deskOrientPrompt,
  formatLocalDelegationOpenNotice,
  localDelegationPreferencePath,
  localSavingsCredit,
  resolveLocalDelegationAvailability,
  resolveLocalDelegationLaunch,
} from "../extensions/signals-dashboard/local-delegation.mjs";
import { ROOT_FOLDER } from "./constants.mjs";

function makeTempDir(t, prefix = "awesome-copilot-mod-sig-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("flight-map-canvas TerrainFill samples viewport patches, blends noise fill textures, animates clouds, and resets cleanly", () => {
  const terrainSource = fs.readFileSync(
    path.join(ROOT_FOLDER, "extensions", "flight-map-canvas", "game", "terrainFill.js"),
    "utf8",
  );

  let nowMs = 0;
  let rngState = 12345;
  const deterministicRandom = () => {
    rngState = (rngState * 16807) % 2147483647;
    return (rngState - 1) / 2147483646;
  };

  function makeCanvasStub() {
    return {
      width: 0,
      height: 0,
      lastPutImageData: null,
      clearedRects: 0,
      fillRects: 0,
      getContext() {
        const canvas = this;
        return {
          fillStyle: "",
          fillRect() {
            canvas.fillRects += 1;
          },
          clearRect() {
            canvas.clearedRects += 1;
          },
          createImageData(w, h) {
            return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
          },
          putImageData(imgData) {
            canvas.lastPutImageData = imgData;
          },
        };
      },
    };
  }

  const fakeThree = {
    RepeatWrapping: 1000,
    WebGLRenderTarget: class {
      constructor(w, h) {
        this.width = w;
        this.height = h;
      }
    },
    CanvasTexture: class {
      constructor(canvas) {
        this.canvas = canvas;
        this.needsUpdate = false;
        this.repeat = { set() {} };
      }
    },
    PlaneGeometry: class {
      constructor(w, h) {
        this.w = w;
        this.h = h;
      }
    },
    MeshBasicMaterial: class {
      constructor(opts) {
        Object.assign(this, opts);
      }
    },
    Mesh: class {
      constructor(geo, mat) {
        this.geometry = geo;
        this.material = mat;
        this.visible = true;
        this.rotation = { x: 0, y: 0, z: 0 };
        this.position = { x: 0, y: 0, z: 0 };
      }
    },
  };

  const addedMeshes = [];
  const scene = {
    add(mesh) {
      addedMeshes.push(mesh);
    },
  };
  const camera = { position: { x: 120, y: 80, z: -340 } };

  let visibilityDuringOffscreenRender = null;
  const renderer = {
    currentTarget: null,
    setRenderTarget(target) {
      this.currentTarget = target;
    },
    render() {
      visibilityDuringOffscreenRender = {
        fill: tf.fillMesh.visible,
        cloud: tf.cloudMesh.visible,
      };
    },
    readRenderTargetPixels(_target, _x, _y, w, h, buffer) {
      // Top half = desert ochre terrain (190, 145, 85); bottom half = sky blue (135, 206, 235) skipped
      for (let py = 0; py < h; py += 1) {
        for (let px = 0; px < w; px += 1) {
          const idx = (py * w + px) * 4;
          if (py < h / 2) {
            buffer[idx] = 190 + (px % 15);
            buffer[idx + 1] = 145 + (py % 10);
            buffer[idx + 2] = 85;
            buffer[idx + 3] = 255;
          } else {
            buffer[idx] = 135;
            buffer[idx + 1] = 206;
            buffer[idx + 2] = 235;
            buffer[idx + 3] = 255;
          }
        }
      }
    },
  };

  const sandboxMath = Object.create(Math);
  sandboxMath.random = deterministicRandom;

  const ctx = {
    THREE: fakeThree,
    document: { createElement: () => makeCanvasStub() },
    performance: { now: () => nowMs },
    Math: sandboxMath,
  };
  vm.runInNewContext(terrainSource, ctx);

  const tf = new ctx.TerrainFill(renderer, scene, camera);
  assert.equal(addedMeshes.length, 2);

  // Frames 1..44 reposition meshes to camera (x, z) without sampling
  tf.update(90);
  assert.equal(tf.fillMesh.position.x, 120);
  assert.equal(tf.fillMesh.position.z, -340);
  assert.equal(tf.sampleColors.length, 0);

  // Advance to frame 45 with 15s elapsed so _collectSamples, _generateFillTexture, and _updateCloud all fire
  nowMs = 15_000;
  for (let step = 2; step <= 45; step += 1) {
    tf.update(90);
  }

  assert.deepEqual(visibilityDuringOffscreenRender, { fill: false, cloud: false });
  assert.equal(tf.fillMesh.visible, true);
  assert.equal(tf.cloudMesh.visible, true);
  assert.ok(tf.sampleColors.length > 20);
  // Every retained sample must be non-sky ochre (r >= 190, b === 85)
  assert.ok(tf.sampleColors.every((c) => c.r >= 190 && c.b === 85));

  const generatedFill = tf.fillCanvas.lastPutImageData;
  assert.ok(generatedFill);
  assert.equal(generatedFill.data[3], 255);
  assert.ok(generatedFill.data[0] >= 190 && generatedFill.data[2] === 85);
  assert.equal(tf.fillTexture.needsUpdate, true);
  assert.ok(tf.cloudCanvas.lastPutImageData);
  assert.equal(tf.cloudTexture.needsUpdate, true);

  // Disabling cloudOverlay hides cloudMesh on next sample interval
  tf.cloudOverlay.enabled = false;
  for (let step = 0; step < 45; step += 1) {
    tf.update(180);
  }
  assert.equal(tf.cloudMesh.visible, false);

  // reset() clears samples, frame counter, and cloud time
  tf.reset();
  assert.equal(tf.sampleColors.length, 0);
  assert.equal(tf.frameCount, 0);
  assert.equal(tf.cloudOverlay.time, 0);
  assert.ok(tf.cloudCanvas.clearedRects >= 1);
});

test("java-modernization-studio doctor statically parses shell JAVA_HOME, augments PATH, filters stub exits, and grades readiness", async () => {
  // 1. Version parsing across Java, Node, generic semver, and non-semver single-line fallback
  assert.equal(parseToolVersion("java", 'openjdk version "21.0.4" 2024-07-16 LTS'), "21.0.4");
  assert.equal(parseToolVersion("node", "v22.11.0\n"), "22.11.0");
  assert.equal(parseToolVersion("mvn", "Apache Maven 3.9.9 (8e8579a9e76f7d015ee5ec7bfcdc97d260186937)"), "3.9.9");
  assert.equal(parseToolVersion("custom", "custom-build-snapshot\nextra"), "custom-build-snapshot");
  assert.equal(parseToolVersion("java", ""), null);

  // 2. Static shell rc JAVA_HOME expansion without command execution
  const env = { HOME: "/Users/alice" };
  assert.equal(expandJavaHomeValue("~/.sdkman/java # pinned LTS", env), "/Users/alice/.sdkman/java");
  assert.equal(expandJavaHomeValue('"${HOME}/jdk#21"', env), "/Users/alice/jdk#21"); // '#' inside quotes preserved
  assert.equal(expandJavaHomeValue("'$HOME/temurin'", env), "/Users/alice/temurin");
  assert.equal(expandJavaHomeValue("$(/usr/libexec/java_home)", env), null);
  assert.equal(expandJavaHomeValue("`/usr/libexec/java_home`", env), null);
  assert.equal(expandJavaHomeValue("$OTHER_ROOT/jdk", env), null);

  const rcText = [
    "export JAVA_HOME=$(/usr/libexec/java_home) # dynamic ignored",
    "JAVA_HOME=~/jdk-17",
    "  export JAVA_HOME=\"$HOME/jdk-21\"  ",
  ].join("\n");
  assert.equal(parseJavaHomeFromRc(rcText, env), "/Users/alice/jdk-21");

  // discoverJavaHome respects explicit env, Windows short-circuit, and zsh rc file precedence
  assert.equal(await discoverJavaHome({ JAVA_HOME: "/explicit/jdk" }, "darwin"), "/explicit/jdk");
  assert.equal(await discoverJavaHome({ HOME: "C:\\Users\\alice" }, "win32"), null);
  const discoveredZsh = await discoverJavaHome(
    { HOME: "/Users/alice", SHELL: "/bin/zsh" },
    "darwin",
    async (rcPath) => {
      if (rcPath.endsWith(".zshenv")) return "export JAVA_HOME=/opt/jdk-17\n";
      if (rcPath.endsWith(".zshrc")) return "export JAVA_HOME=~/jdk-21\n";
      return null;
    },
  );
  assert.equal(discoveredZsh, "/Users/alice/jdk-21");

  // 3. augmentedEnv prepends SDKMAN, JAVA_HOME, and keg-only Homebrew OpenJDKs on POSIX while leaving win32 untouched
  const winEnv = augmentedEnv({ PATH: "C:\\Windows\\System32" }, "win32");
  assert.equal(winEnv.PATH, "C:\\Windows\\System32");

  const posixEnv = augmentedEnv(
    { HOME: "/Users/alice", JAVA_HOME: "/custom/jdk", PATH: "/usr/bin" },
    "darwin",
    (optDir) => (optDir === "/opt/homebrew/opt" ? ["openjdk@21", "sqlite"] : []),
  );
  assert.match(posixEnv.PATH, /\/opt\/homebrew\/opt\/openjdk@21\/libexec\/openjdk\.jdk\/Contents\/Home\/bin/);
  assert.match(posixEnv.PATH, /\/custom\/jdk\/bin/);
  assert.match(posixEnv.PATH, /\/Users\/alice\/\.sdkman\/candidates\/java\/current\/bin/);

  // 4. probeOne rejects macOS /usr/bin/java stub (exit 1 without digits) and ENOENT, while accepting stderr versions
  const macStubProbe = await probeOne(
    { key: "java", cmd: "java", args: ["-version"] },
    async () => ({
      error: Object.assign(new Error("exit 1"), { code: 1 }),
      stdout: "",
      stderr: "The operation couldn't be completed. Unable to locate a Java Runtime.",
    }),
  );
  assert.deepEqual(macStubProbe, { key: "java", found: false, version: null });

  const enoentProbe = await probeOne(
    { key: "mvn", cmd: "mvn", args: ["-v"] },
    async () => ({ error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), stdout: "", stderr: "" }),
  );
  assert.equal(enoentProbe.found, false);

  const stderrJavaProbe = await probeOne(
    { key: "java", cmd: "java", args: ["-version"] },
    async () => ({ error: null, stdout: "", stderr: 'openjdk version "17.0.12" 2024-07-16' }),
  );
  assert.deepEqual(stderrJavaProbe, { key: "java", found: true, version: "17.0.12" });

  // 5. buildDoctorReport: Gradle wrapper satisfies missing gradle CLI; Dockerfile without docker yields caution
  const cautionReport = buildDoctorReport({
    probes: {
      java: { found: true, version: "21.0.4" },
      gradle: { found: false, version: null },
      git: { found: true, version: "2.46.0" },
      docker: { found: false, version: null },
    },
    scan: {
      assessment: { buildTool: "Gradle", hasGradleWrapper: true, hasDockerfile: true },
      git: { branch: "appmod/java-21", isMigrationBranch: true },
      plan: { exists: true },
      skills: [{ name: "s1" }, { name: "s2" }],
    },
  });
  assert.equal(cautionReport.overall, "caution");
  const buildCheck = cautionReport.groups[0].checks.find((c) => c.id === "build");
  assert.equal(buildCheck.status, "ok");
  assert.match(buildCheck.detail, /gradlew/);
  const dockerCheck = cautionReport.groups[1].checks.find((c) => c.id === "docker");
  assert.equal(dockerCheck.status, "warn");
});

test("java-modernization-studio autopilot caps maxSteps, surfaces turn/snapshot errors, and scanRepo guards untrusted root plans", async (t) => {
  // 1. currentSteps & selectNextStep fall back to plan.steps and across phases when active phase is complete
  assert.deepEqual(currentSteps(null), []);
  const planFallbackState = {
    progress: { steps: [] },
    plan: {
      steps: [
        { title: "Done in P0", section: "P0", rank: 0, status: "done" },
        { title: "Next in P1", section: "P1", rank: 1, status: "pending" },
      ],
    },
    ordering: { activeRank: 0 },
  };
  assert.equal(selectNextStep(planFallbackState)?.title, "Next in P1");
  assert.equal(stepKey(null), "");
  assert.equal(isStepDone(planFallbackState, { title: "Done in P0", section: "P0" }), true);

  // 2. runAutopilot stops with status="capped" when maxSteps is reached
  const steps = [
    { title: "S1", section: "P0", rank: 0, status: "pending" },
    { title: "S2", section: "P0", rank: 0, status: "pending" },
    { title: "S3", section: "P0", rank: 0, status: "pending" },
  ];
  const cappedRun = makeRun({ scope: "all", maxSteps: 2 });
  assert.equal(makeRun().maxSteps, AUTOPILOT_MAX_STEPS);
  const logs = [];
  await runAutopilot(cappedRun, {
    snapshot: async () => ({ progress: { steps: steps.map((s) => ({ ...s })) }, ordering: { activeRank: 0 } }),
    runTurn: async () => {
      const next = steps.find((s) => s.status !== "done");
      if (next) next.status = "done";
    },
    buildStepPrompt: (s) => `Run ${s.title}`,
    onProgress: () => {},
    log: (msg) => logs.push(msg),
  });
  assert.equal(cappedRun.status, "capped");
  assert.equal(cappedRun.completed.length, 2);
  assert.equal(logs.length, 2);

  // 3. runAutopilot records runTurn failure and halts with status="error"
  const errRun = makeRun({ scope: "all", maxSteps: 5 });
  await runAutopilot(errRun, {
    snapshot: async () => ({
      progress: { steps: [{ title: "Broken step", section: "P0", rank: 0, status: "pending" }] },
      ordering: { activeRank: 0 },
    }),
    runTurn: async () => {
      throw new Error("turn timed out");
    },
    buildStepPrompt: (s) => s.title,
    onProgress: () => {},
  });
  assert.equal(errRun.status, "error");
  assert.equal(errRun.error, "turn timed out");
  assert.equal(errRun.completed[0].error, "turn timed out");

  // 4. Outer snapshot() exception sets status="error" cleanly
  const snapErrorRecord = makeRun({ scope: "all" });
  await runAutopilot(snapErrorRecord, {
    snapshot: async () => {
      throw new Error("disk read failed");
    },
    runTurn: async () => {},
    buildStepPrompt: () => "",
  });
  assert.equal(snapErrorRecord.status, "error");
  assert.equal(snapErrorRecord.running, false);

  // 5. buildPrompt null guards + scanRepo ignores unrelated root plan.md without .appmod provenance
  assert.equal(buildPrompt("unknown_action", {}, "/repo"), null);
  assert.match(buildPrompt("fix_env", { tool: "Maven", detail: "missing", fix: "brew install maven" }, "/repo"), /Maven/);

  const repoDir = makeTempDir(t, "untrusted-plan-");
  fs.writeFileSync(path.join(repoDir, "plan.md"), "- [x] Unrelated project checklist\n", "utf8");
  const untrustedScan = await scanRepo(repoDir, { includeGit: false });
  assert.equal(untrustedScan.plan.exists, false);

  fs.mkdirSync(path.join(repoDir, ".appmod"));
  fs.writeFileSync(path.join(repoDir, ".appmod", "assessment.json"), "{}", "utf8");
  const trustedScan = await scanRepo(repoDir, { includeGit: false });
  assert.equal(trustedScan.plan.exists, true);
  assert.equal(trustedScan.plan.steps.length, 1);
});

test("signals-dashboard local-delegation and launch-profile enforce fail-closed receipts, prompt caps, and cmd safety", () => {
  const skillDir = "/home/.copilot/skills/local-agent-delegation";

  // 1. Kill-switch WORKSHOP_LOCAL_DELEGATION_AVAILABLE forces unavailable even when skill & env route exist
  for (const flag of ["0", "false", "UNAVAILABLE"]) {
    const forcedOff = resolveLocalDelegationAvailability({
      env: {
        WORKSHOP_LOCAL_DELEGATION_AVAILABLE: flag,
        WORKSHOP_LOCAL_DELEGATION_ROUTE_ID: "safe-route-1",
      },
      findSkill: () => skillDir,
    });
    assert.equal(forcedOff.available, false);
    assert.match(forcedOff.reason, /Forced unavailable/);
  }

  // 2. Unsafe route_id in env or receipt is rejected fail-closed
  const badEnvRoute = resolveLocalDelegationAvailability({
    env: { WORKSHOP_LOCAL_DELEGATION_ROUTE_ID: "unsafe;route id" },
    findSkill: () => skillDir,
  });
  assert.equal(badEnvRoute.available, false);
  assert.match(badEnvRoute.reason, /not a safe route id/);

  const badJsonReceipt = resolveLocalDelegationAvailability({
    env: { WORKSHOP_LOCAL_DELEGATION_RECEIPT: "/tmp/receipt.json" },
    findSkill: () => skillDir,
    exists: () => true,
    readFile: () => "{corrupt",
  });
  assert.equal(badJsonReceipt.available, false);
  assert.match(badJsonReceipt.reason, /unreadable/);

  const nonQualifiedUnsafeRoute = resolveLocalDelegationAvailability({
    env: { WORKSHOP_LOCAL_DELEGATION_RECEIPT: "/tmp/receipt.json" },
    findSkill: () => skillDir,
    exists: () => true,
    readFile: () => JSON.stringify({ status: "pending", route_id: "bad|route" }),
  });
  assert.equal(nonQualifiedUnsafeRoute.available, false);
  assert.equal(nonQualifiedUnsafeRoute.routeId, null);

  const qualifiedMissingRoute = resolveLocalDelegationAvailability({
    env: { WORKSHOP_LOCAL_DELEGATION_RECEIPT: "/tmp/receipt.json" },
    findSkill: () => skillDir,
    exists: () => true,
    readFile: () => JSON.stringify({ status: "qualified", route_id: "-leading-dash-invalid" }),
  });
  assert.equal(qualifiedMissingRoute.available, false);
  assert.match(qualifiedMissingRoute.reason, /missing a safe route_id/);

  const invalidExpiryReceipt = resolveLocalDelegationAvailability({
    env: { WORKSHOP_LOCAL_DELEGATION_RECEIPT: "/tmp/receipt.json" },
    findSkill: () => skillDir,
    exists: () => true,
    readFile: () => JSON.stringify({ status: "qualified", routeId: "local-qwen", expiresAt: "not-a-date" }),
  });
  assert.equal(invalidExpiryReceipt.available, false);
  assert.match(invalidExpiryReceipt.reason, /expired/);

  // 3. deskOrientPrompt omits notice if deskName makes combined prompt exceed 280-char cmd safety cap
  const longDesk = "x".repeat(90);
  const cappedPrompt = deskOrientPrompt(longDesk, { localDelegationEffective: true });
  assert.equal(cappedPrompt.includes(LOCAL_DELEGATION_ORIENT_LINE), false);

  // 4. localSavingsCredit reason precedence + notice & preference-path edge cases
  assert.equal(localSavingsCredit({ attempted: false, escalated: true }).reason, "not_attempted");
  assert.equal(
    localSavingsCredit({ attempted: true, gateAccepted: true, redone: true, escalated: true }).reason,
    "escalated",
  );
  assert.equal(
    localSavingsCredit({ attempted: true, gateAccepted: true, redone: true, escalated: false }).reason,
    "redone",
  );
  assert.equal(
    localSavingsCredit({ attempted: true, gateAccepted: false, redone: false, escalated: false }).reason,
    "gate_not_accepted",
  );

  assert.deepEqual(formatLocalDelegationOpenNotice(null), { titleSuffix: "", detail: "" });
  assert.equal(
    resolveLocalDelegationLaunch({ preference: "on", availability: null }).warning,
    "Local Delegation unavailable",
  );
  assert.throws(() => localDelegationPreferencePath(""), /workshopDir is required/);
  const fallbackHashedPath = localDelegationPreferencePath("/work/demo", {
    home: "/home/dev",
    resolvePath: () => {
      throw new Error("realpath failed");
    },
  });
  assert.match(fallbackHashedPath, /workshop-local-delegation/);

  // 5. launch-profile Windows alias & shim guards + prefixed JSON extraction
  assert.equal(isWindowsAppExecutionAlias(null, "C:\\Users\\a\\AppData\\Local"), false);
  assert.equal(isWindowsAppExecutionAlias("C:\\Users\\a\\wt.exe", null), false);
  assert.equal(
    isWindowsAppExecutionAlias(
      "C:/Users/a/AppData/Local/Microsoft/WindowsApps/copilot.EXE",
      "C:/Users/a/AppData/Local/",
    ),
    true,
  );
  assert.equal(isSafeWindowsCmdShim("C:\\Tools\\agency.cmd\nmalicious"), false);
  assert.equal(isSafeQuotedWindowsCmdArg("C:\\Work\\!EXPANDED!\\repo"), false);
  assert.equal(isSafeQuotedWindowsCmdArg("C:\\Work\\line\rbreak"), false);

  const prefixedOutput = [
    "Agency wrapper: warming up {not-valid-json",
    JSON.stringify({
      plugins: [
        { kind: "mcp", name: "github.mcp_srv:1", scope: "plugin", enabled: true },
        { kind: "mcp", name: "source-plugin-mcp", source: "plugin" },
        { kind: "mcp", name: "unsafe space", scope: "plugin", enabled: true },
      ],
    }),
  ].join("\n");
  assert.deepEqual(parsePluginMcpNames(prefixedOutput), ["github.mcp_srv:1", "source-plugin-mcp"]);
  assert.equal(parsePluginMcpNames(""), null);

  assert.deepEqual(
    buildDeskAgentArgv({
      deskName: "ops-desk",
      workshopDir: "/w",
      useAgency: false,
      profile: "repo",
      pluginMcpNames: ["valid-mcp", "invalid;mcp"],
      discoverySucceeded: true,
    }),
    ["copilot", "--name", "ops-desk", "--disable-mcp-server", "valid-mcp", "--add-dir", "/w"],
  );
});
