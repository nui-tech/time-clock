import test from "node:test";
import assert from "node:assert/strict";
import { createDescriptionAutosave } from "../public/description-autosave.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("saves only the latest description after a half-second pause", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = [];
  const autosave = createDescriptionAutosave({
    save: async (draft) => { saved.push(draft); },
    onChange() {},
  });
  autosave.update("session", "First");
  t.mock.timers.tick(300);
  autosave.update("session", "Latest");
  t.mock.timers.tick(499);
  await settle();
  assert.equal(saved.length, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(saved, [{ id: "session", value: "Latest" }]);
  assert.equal(autosave.draft, null);
  assert.equal(autosave.status, "Saved");
});

test("serializes saves and preserves edits made while a request is in flight", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const autosave = createDescriptionAutosave({
    save: (draft) => new Promise((resolve) => { calls.push({ draft, resolve }); }),
    onChange() {},
  });
  autosave.update("session", "Earlier text");
  t.mock.timers.tick(500);
  await settle();
  autosave.update("session", "Newest text");
  t.mock.timers.tick(500);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(autosave.draft.value, "Newest text");
  calls[0].resolve();
  await settle();
  assert.equal(autosave.draft.value, "Newest text");
  t.mock.timers.tick(0);
  await settle();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].draft, { id: "session", value: "Newest text" });
  calls[1].resolve();
  await settle();
  assert.equal(autosave.draft, null);
});

test("failed saves retain the draft and retry automatically", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const autosave = createDescriptionAutosave({
    save: async () => {
      attempts++;
      if (attempts === 1) throw new Error("Disconnected");
    },
    onChange() {},
  });
  autosave.update("session", "Keep this text");
  t.mock.timers.tick(500);
  await settle();
  assert.equal(autosave.draft.value, "Keep this text");
  assert.match(autosave.status, /Retrying/);
  t.mock.timers.tick(1999);
  await settle();
  assert.equal(attempts, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(attempts, 2);
  assert.equal(autosave.draft, null);
});

test("new edits replace a failed draft before the retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = [];
  const autosave = createDescriptionAutosave({
    save: async (draft) => {
      saved.push(draft);
      if (saved.length === 1) throw new Error("Disconnected");
    },
    onChange() {},
  });
  autosave.update("session", "Old text");
  t.mock.timers.tick(500);
  await settle();
  autosave.update("session", "Updated during disconnection");
  t.mock.timers.tick(500);
  await settle();
  assert.equal(saved[1].value, "Updated during disconnection");
  assert.equal(autosave.draft, null);
});

test("flush saves immediately and retains the session ID captured during editing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = [];
  const autosave = createDescriptionAutosave({
    save: async (draft) => { saved.push(draft); },
    onChange() {},
  });
  autosave.update("previous-session", "Description entered before stopping");
  await autosave.flush();
  assert.deepEqual(saved, [{
    id: "previous-session", value: "Description entered before stopping",
  }]);
  t.mock.timers.tick(500);
  await settle();
  assert.equal(saved.length, 1);
});

test("defers saves while another app action is busy", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let busy = true;
  const saved = [];
  const autosave = createDescriptionAutosave({
    save: async (draft) => { saved.push(draft); },
    canSave: () => !busy,
    onChange() {},
  });
  autosave.update("session", "Pending text");
  t.mock.timers.tick(500);
  await settle();
  assert.equal(saved.length, 0);
  busy = false;
  t.mock.timers.tick(100);
  await settle();
  assert.equal(saved[0].value, "Pending text");
});

test("waits for input composition to finish", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = [];
  const autosave = createDescriptionAutosave({
    save: async (draft) => { saved.push(draft); },
    onChange() {},
  });
  autosave.update("session", "Unfinished input");
  autosave.pause();
  autosave.update("session", "งาน", true);
  t.mock.timers.tick(2000);
  await autosave.flush();
  assert.equal(saved.length, 0);
  autosave.update("session", "งานวันนี้");
  t.mock.timers.tick(500);
  await settle();
  assert.equal(saved[0].value, "งานวันนี้");
});

test("explicit session edits can supersede a pending autosave", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = [];
  const autosave = createDescriptionAutosave({
    save: async (draft) => { saved.push(draft); },
    onChange() {},
  });
  autosave.update("session", "Superseded text");
  autosave.discard("session");
  await autosave.flush();
  t.mock.timers.tick(500);
  await settle();
  assert.equal(saved.length, 0);
});
