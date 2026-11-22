import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyExternalPluginIntakeEvaluation,
  EXTERNAL_PLUGIN_INTAKE_LABELS,
  syncExternalPluginIntakeLabels,
  upsertExternalPluginIntakeComment,
} from "./external-plugin-intake-state.mjs";

function createMockGitHub({
  initialLabels = [],
  initialComments = [],
  removeErrorStatus = null,
} = {}) {
  const addedLabels = [];
  const removedLabels = [];
  const createdComments = [];
  const updatedComments = [];

  const github = {
    paginate: async () => initialLabels.map((name) => ({ name })),
    rest: {
      issues: {
        listLabelsOnIssue: async () => ({ data: [] }),
        addLabels: async ({ labels }) => {
          addedLabels.push(...labels);
        },
        removeLabel: async ({ name }) => {
          if (removeErrorStatus) {
            const err = new Error(`HTTP ${removeErrorStatus}`);
            err.status = removeErrorStatus;
            throw err;
          }
          removedLabels.push(name);
        },
        listComments: async () => ({ data: initialComments }),
        updateComment: async ({ comment_id, body }) => {
          updatedComments.push({ id: comment_id, body });
        },
        createComment: async ({ body }) => {
          createdComments.push({ body });
        },
      },
    },
  };

  return {
    github,
    addedLabels,
    removedLabels,
    createdComments,
    updatedComments,
  };
}

test("syncExternalPluginIntakeLabels adds missing managed labels, removes stale ones, preserves unmanaged labels, and tolerates 404", async () => {
  assert.ok("ready-for-review" in EXTERNAL_PLUGIN_INTAKE_LABELS);

  const mock = createMockGitHub({
    initialLabels: ["external-plugin", "awaiting-review", "approved", "custom-note"],
  });

  await syncExternalPluginIntakeLabels({
    github: mock.github,
    owner: "reevesc88",
    repo: "awesome-copilot",
    issueNumber: 12,
    desiredLabels: new Set(["external-plugin", "ready-for-review"]),
  });

  assert.deepEqual(mock.addedLabels, ["ready-for-review"]);
  assert.deepEqual(mock.removedLabels, ["awaiting-review"]);

  // 404 on removeLabel is ignored
  const mock404 = createMockGitHub({
    initialLabels: ["awaiting-review"],
    removeErrorStatus: 404,
  });
  await syncExternalPluginIntakeLabels({
    github: mock404.github,
    owner: "reevesc88",
    repo: "awesome-copilot",
    issueNumber: 12,
    desiredLabels: new Set(["external-plugin"]),
  });

  // Non-404 error propagates
  const mock500 = createMockGitHub({
    initialLabels: ["awaiting-review"],
    removeErrorStatus: 500,
  });
  await assert.rejects(
    () =>
      syncExternalPluginIntakeLabels({
        github: mock500.github,
        owner: "reevesc88",
        repo: "awesome-copilot",
        issueNumber: 12,
        desiredLabels: new Set(["external-plugin"]),
      }),
    /HTTP 500/,
  );
});

test("upsertExternalPluginIntakeComment updates existing bot comment with marker or creates a new one", async () => {
  const marker = "<!-- external-plugin-intake -->";

  // Ignores human comment quoting marker, creates new bot comment
  const createMock = createMockGitHub({
    initialComments: [
      { id: 101, user: { login: "contributor" }, body: `Quoted ${marker}` },
    ],
  });
  await upsertExternalPluginIntakeComment({
    github: createMock.github,
    owner: "reevesc88",
    repo: "awesome-copilot",
    issueNumber: 5,
    marker,
    body: `${marker}\nFresh report`,
  });
  assert.equal(createMock.createdComments.length, 1);
  assert.equal(createMock.updatedComments.length, 0);

  // Updates existing github-actions[bot] comment containing marker
  const updateMock = createMockGitHub({
    initialComments: [
      { id: 202, user: { login: "github-actions[bot]" }, body: `${marker}\nOld report` },
    ],
  });
  await upsertExternalPluginIntakeComment({
    github: updateMock.github,
    owner: "reevesc88",
    repo: "awesome-copilot",
    issueNumber: 5,
    marker,
    body: `${marker}\nUpdated report`,
  });
  assert.equal(updateMock.createdComments.length, 0);
  assert.deepEqual(updateMock.updatedComments, [
    { id: 202, body: `${marker}\nUpdated report` },
  ]);
});

test("applyExternalPluginIntakeEvaluation maps intake states and adds canvas label when applicable", async () => {
  const mock = createMockGitHub({
    initialLabels: ["external-plugin", "requires-submitter-fixes"],
  });

  const { desiredLabels } = await applyExternalPluginIntakeEvaluation({
    github: mock.github,
    owner: "reevesc88",
    repo: "awesome-copilot",
    issueNumber: 9,
    evaluation: {
      valid: true,
      intakeState: "ready-for-review",
      isCanvasPlugin: true,
      commentMarker: "<!-- external-plugin-intake -->",
      commentBody: "<!-- external-plugin-intake -->\nPassed",
    },
  });

  assert.deepEqual(
    [...desiredLabels].sort(),
    ["external-plugin", "external-plugin-canvas", "ready-for-review"],
  );
  assert.deepEqual(mock.addedLabels.sort(), ["external-plugin-canvas", "ready-for-review"]);
  assert.deepEqual(mock.removedLabels, ["requires-submitter-fixes"]);
  assert.equal(mock.createdComments.length, 1);
});
