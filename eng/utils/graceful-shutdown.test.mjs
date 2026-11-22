import assert from "node:assert/strict";
import { test } from "node:test";
import { setupGracefulShutdown } from "./graceful-shutdown.mjs";

const SIGNALS_AND_EVENTS = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "uncaughtException",
  "unhandledRejection",
];

test("setupGracefulShutdown registers handlers and teardown removes all listeners cleanly", () => {
  const before = Object.fromEntries(
    SIGNALS_AND_EVENTS.map((ev) => [ev, process.listenerCount(ev)]),
  );

  const teardown = setupGracefulShutdown("test-script", { exitCode: 3 });

  for (const ev of SIGNALS_AND_EVENTS) {
    assert.equal(process.listenerCount(ev), before[ev] + 1);
  }

  teardown();

  for (const ev of SIGNALS_AND_EVENTS) {
    assert.equal(process.listenerCount(ev), before[ev]);
  }
});

test("setupGracefulShutdown invokes process.exit once with configured exitCode and surfaces exit errors", () => {
  const originalExit = process.exit;
  const exitCalls = [];
  process.exit = (code) => {
    exitCalls.push(code);
  };

  const sigintBefore = process.listeners("SIGINT");
  const teardown = setupGracefulShutdown("demo-worker", { exitCode: 7 });

  try {
    const addedHandler = process
      .listeners("SIGINT")
      .find((fn) => !sigintBefore.includes(fn));
    assert.equal(typeof addedHandler, "function");

    addedHandler();
    // Second signal while already shutting down is a no-op
    addedHandler();
    assert.deepEqual(exitCalls, [7]);
  } finally {
    teardown();
    process.exit = originalExit;
  }

  // Rethrows when stubbed process.exit throws
  process.exit = () => {
    throw new Error("stubbed exit");
  };
  const beforeTerm = process.listeners("SIGTERM");
  const teardownThrow = setupGracefulShutdown("throwing-worker");
  try {
    const termHandler = process
      .listeners("SIGTERM")
      .find((fn) => !beforeTerm.includes(fn));
    assert.throws(() => termHandler(), /stubbed exit/);
  } finally {
    teardownThrow();
    process.exit = originalExit;
  }
});
