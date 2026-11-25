import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import {
  parseWorkDateTime, validDate, workDate, workDateTime, workWeekDates,
} from "../public/time.js";

const migrationsDirectory = new URL("../migrations/", import.meta.url);
const schema = readdirSync(migrationsDirectory)
  .filter((filename) => filename.endsWith(".sql"))
  .sort()
  .map((filename) => readFileSync(new URL(filename, migrationsDirectory), "utf8"))
  .join("\n");

// Run the actual Worker routes and SQL against SQLite, including transactions,
// foreign keys and triggers. Only the D1 transport is adapted for Node.
class LocalD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec(schema);
  }

  prepare(sql) {
    const statement = this.sqlite.prepare(sql);
    let values = [];
    const query = {
      bind(...parameters) {
        values = parameters;
        return query;
      },
      execute() {
        if (statement.columns().length) {
          return { results: statement.all(...values), success: true };
        }
        const result = statement.run(...values);
        return { results: [], success: true, meta: { changes: Number(result.changes) } };
      },
      async run() { return query.execute(); },
      async first() { return query.execute().results[0] ?? null; },
    };
    return query;
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function harness(t, initialTime = "2026-11-24T09:00") {
  const db = new LocalD1();
  let now = parseWorkDateTime(initialTime);
  t.mock.method(Date, "now", () => now);
  t.after(() => db.sqlite.close());
  return {
    db,
    setTime(value) { now = parseWorkDateTime(value); },
    async request(path, method = "GET", body, expectedStatus = 200) {
      const response = await worker.fetch(new Request(`http://localhost${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }), { DB: db });
      const result = await response.json();
      assert.equal(response.status, expectedStatus, JSON.stringify(result));
      return result;
    },
    start(id, description = id) {
      return this.request("/api/sessions", "POST", {
        id, date: workDate(now), description,
      });
    },
  };
}

test("start, atomically switch, stop and resume a task", async (t) => {
  const app = harness(t);
  let day = await app.start("first", "Design login");
  assert.equal(day.activeSession.description, "Design login");
  app.setTime("2026-11-24T10:00");
  day = await app.start("second", "Build timer");
  assert.equal(day.sessions.find((session) => session.id === "first").endedAt,
    parseWorkDateTime("2026-11-24T10:00"));
  app.setTime("2026-11-24T10:30");
  day = await app.request("/api/sessions/second/stop", "POST", {});
  assert.equal(day.activeSession, null);
  assert.equal(day.totalMilliseconds, 90 * 60_000);
  app.setTime("2026-11-24T11:00");
  day = await app.request("/api/sessions", "POST", {
    id: "resumed", date: day.date, taskId: "first",
  });
  assert.equal(day.activeSession.taskId, "first");
  assert.equal(day.sessions.length, 3);
});

test("start without a task, refresh and add a description while time keeps running", async (t) => {
  const app = harness(t);
  const date = "2026-11-24";
  let day = await app.request("/api/sessions", "POST", { id: "unnamed", date });
  const startedAt = day.activeSession.startedAt;
  assert.equal(day.activeSession.description, "");
  assert.equal(day.activeSession.taskId, null);
  assert.equal(day.tasks.length, 0);
  app.setTime("2026-11-24T09:30");
  day = await app.request(`/api/days/${date}`);
  assert.equal(day.totalMilliseconds, 30 * 60_000);
  day = await app.request("/api/sessions/unnamed", "PATCH", {
    description: "Review requirements", startedAt, endedAt: null,
  });
  assert.equal(day.activeSession.startedAt, startedAt);
  assert.equal(day.activeSession.id, "unnamed");
  assert.equal(day.activeSession.description, "Review requirements");
  assert.equal(day.activeSession.taskId, "unnamed");
  assert.equal(day.tasks[0].description, "Review requirements");
  assert.equal(day.totalMilliseconds, 30 * 60_000);
  await app.request("/api/sessions/unnamed", "PATCH", {
    description: "Review requirements", startedAt, endedAt: null,
  });
  app.setTime("2026-11-24T10:00");
  day = await app.request("/api/sessions/unnamed/stop", "POST", {});
  assert.equal(day.totalMilliseconds, 3_600_000);
  assert.equal(day.tasks.length, 1);
});

test("unnamed starts support retries, task switching and automatic clock-out", async (t) => {
  const app = harness(t);
  const date = "2026-11-24";
  await app.start("named");
  app.setTime("2026-11-24T10:00");
  let day = await app.request("/api/sessions", "POST", {
    id: "unnamed", date, description: "   ",
  });
  assert.equal(day.activeSession.description, "");
  assert.equal(day.sessions.length, 2);
  assert.equal(day.tasks.length, 1);
  day = await app.request("/api/sessions", "POST", { id: "unnamed", date });
  assert.equal(day.sessions.length, 2);
  await app.request(`/api/days/${date}`, "PUT", {
    clockOutAt: parseWorkDateTime("2026-11-24T11:00"),
  });
  app.setTime("2026-11-24T12:00");
  day = await app.request(`/api/days/${date}`);
  const unnamed = day.sessions.find((session) => session.id === "unnamed");
  assert.equal(day.activeSession, null);
  assert.equal(day.totalMilliseconds, 2 * 3_600_000);
  day = await app.request("/api/sessions/unnamed", "PATCH", {
    description: "Recorded later", startedAt: unnamed.startedAt, endedAt: unnamed.endedAt,
  });
  assert.equal(day.activeSession, null);
  assert.equal(day.sessions[0].endedAt, unnamed.endedAt);
  assert.equal(day.tasks.length, 2);
});

test("planned tasks still require a description", async (t) => {
  const app = harness(t);
  await app.request("/api/tasks", "POST", {
    id: "empty-task", date: "2026-11-24", description: "",
  }, 400);
  const day = await app.request("/api/days/2026-11-24");
  assert.equal(day.tasks.length, 0);
  assert.equal(day.sessions.length, 0);
});

test("a description-only edit names a running session without changing its timestamps", async (t) => {
  const app = harness(t);
  let day = await app.request("/api/sessions", "POST", {
    id: "inline", date: "2026-11-24",
  });
  const startedAt = day.activeSession.startedAt;
  app.setTime("2026-11-24T09:30");
  day = await app.request("/api/sessions/inline", "PATCH", {
    description: "Entered inline",
  });
  assert.equal(day.activeSession.startedAt, startedAt);
  assert.equal(day.activeSession.endedAt, null);
  assert.equal(day.activeSession.description, "Entered inline");
  assert.equal(day.tasks[0].description, "Entered inline");
  assert.equal(day.totalMilliseconds, 30 * 60_000);
  day = await app.request("/api/sessions/inline", "PATCH", { description: "" });
  assert.equal(day.activeSession.description, "");
  assert.equal(day.activeSession.startedAt, startedAt);
});

test("saving a description after clock-out preserves the recorded finish", async (t) => {
  const app = harness(t);
  await app.request("/api/sessions", "POST", {
    id: "inline", date: "2026-11-24",
  });
  const deadline = parseWorkDateTime("2026-11-24T10:00");
  await app.request("/api/days/2026-11-24", "PUT", { clockOutAt: deadline });
  app.setTime("2026-11-24T11:00");
  const day = await app.request("/api/sessions/inline", "PATCH", {
    description: "Saved after the deadline",
  });
  assert.equal(day.activeSession, null);
  assert.equal(day.sessions[0].description, "Saved after the deadline");
  assert.equal(day.sessions[0].endedAt, deadline);
  assert.equal(day.totalMilliseconds, 3_600_000);
  assert.equal(day.tasks[0].description, "Saved after the deadline");
});

test("successive autosaves update a quick-start task label without changing earlier records", async (t) => {
  const app = harness(t);
  await app.request("/api/sessions", "POST", { id: "quick", date: "2026-11-24" });
  await app.request("/api/sessions/quick", "PATCH", { description: "Write" });
  let day = await app.request("/api/sessions/quick", "PATCH", { description: "Write the full report" });
  assert.equal(day.tasks[0].description, "Write the full report");
  assert.equal(day.activeSession.description, "Write the full report");
  app.setTime("2026-11-24T10:00");
  await app.request("/api/sessions/quick/stop", "POST", {});
  app.setTime("2026-11-24T11:00");
  await app.request("/api/sessions", "POST", {
    id: "continued", date: "2026-11-24", continueSessionId: "quick",
  });
  day = await app.request("/api/sessions/continued", "PATCH", {
    description: "Work on a different section",
  });
  assert.equal(day.tasks[0].description, "Write the full report");
  assert.equal(day.sessions.find((session) => session.id === "quick").description, "Write the full report");
});

test("optional-description migration preserves existing sessions and constraints", (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(readFileSync(new URL("0001_initial.sql", migrationsDirectory), "utf8"));
  sqlite.exec(`
    INSERT INTO days (date, clock_out_at) VALUES ('2026-11-24', 30000);
    INSERT INTO tasks (id, day, description, created_at)
      VALUES ('legacy', '2026-11-24', 'Existing task', 10000);
    INSERT INTO sessions (id, day, task_id, description, started_at, ended_at)
      VALUES ('finished', '2026-11-24', 'legacy', 'Original description', 10000, 15000);
    INSERT INTO sessions (id, day, task_id, description, started_at)
      VALUES ('running', '2026-11-24', 'legacy', 'Existing task', 15000);
  `);
  const before = sqlite.prepare("SELECT * FROM sessions ORDER BY id").all();
  sqlite.exec(readFileSync(new URL("0002_optional_session_description.sql", migrationsDirectory), "utf8"));
  assert.deepEqual(sqlite.prepare("SELECT * FROM sessions ORDER BY id").all(), before);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM tasks").get().count, 1);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  assert.throws(() => sqlite.exec(`
    INSERT INTO sessions (id, day, description, started_at)
      VALUES ('another', '2026-11-24', '', 20000)
  `), /overlap|UNIQUE/);
  assert.throws(() => sqlite.exec(`
    UPDATE days SET clock_out_at = 14000 WHERE date = '2026-11-24'
  `), /Clock-out must be after/);
});

test("retrying a start and delayed stops cannot end newer work", async (t) => {
  const app = harness(t);
  await app.start("first");
  app.setTime("2026-11-24T10:00");
  await app.start("second");
  let day = await app.start("first");
  assert.equal(day.activeSession.id, "second");
  assert.equal(day.sessions.length, 2);
  day = await app.request("/api/sessions/first/stop", "POST", {});
  assert.equal(day.activeSession.id, "second");
});

test("continuing finished work starts a fresh interval and excludes the pause from totals", async (t) => {
  const app = harness(t);
  await app.start("original", "Write report");
  app.setTime("2026-11-24T10:00");
  await app.request("/api/sessions/original/stop", "POST", {});
  app.setTime("2026-11-24T11:00");
  let day = await app.request("/api/sessions", "POST", {
    id: "continued", date: "2026-11-24", continueSessionId: "original",
  });
  assert.equal(day.activeSession.description, "Write report");
  assert.equal(day.activeSession.taskId, "original");
  assert.equal(day.activeSession.startedAt, parseWorkDateTime("2026-11-24T11:00"));
  assert.equal(day.sessions.find((session) => session.id === "original").endedAt,
    parseWorkDateTime("2026-11-24T10:00"));
  app.setTime("2026-11-24T12:00");
  day = await app.request("/api/sessions/continued/stop", "POST", {});
  assert.equal(day.totalMilliseconds, 2 * 3_600_000);
  assert.equal(day.sessions.length, 2);
  assert.equal(day.tasks.length, 1);
});

test("unnamed work can be continued and retrying cannot stop newer work", async (t) => {
  const app = harness(t);
  await app.request("/api/sessions", "POST", { id: "unnamed", date: "2026-11-24" });
  app.setTime("2026-11-24T10:00");
  await app.request("/api/sessions/unnamed/stop", "POST", {});
  app.setTime("2026-11-24T11:00");
  const body = { id: "continued", date: "2026-11-24", continueSessionId: "unnamed" };
  let day = await app.request("/api/sessions", "POST", body);
  assert.equal(day.activeSession.description, "");
  assert.equal(day.activeSession.taskId, null);
  assert.equal(day.tasks.length, 0);
  await app.request("/api/sessions", "POST", body);
  app.setTime("2026-11-24T12:00");
  await app.start("other", "Different work");
  day = await app.request("/api/sessions", "POST", body);
  assert.equal(day.activeSession.id, "other");
  assert.equal(day.sessions.length, 3);
  assert.equal(day.totalMilliseconds, 2 * 3_600_000);
});

test("continuation uses the recorded description after a task is renamed or removed", async (t) => {
  const app = harness(t);
  await app.start("original", "Recorded description");
  app.setTime("2026-11-24T10:00");
  await app.request("/api/sessions/original/stop", "POST", {});
  await app.request("/api/tasks/original", "PATCH", { description: "New plan name" });
  let day = await app.request("/api/sessions", "POST", {
    id: "continued", date: "2026-11-24", continueSessionId: "original",
  });
  assert.equal(day.activeSession.description, "Recorded description");
  await app.request("/api/sessions/continued/stop", "POST", {});
  await app.request("/api/tasks/original", "DELETE", {});
  app.setTime("2026-11-24T11:00");
  day = await app.request("/api/sessions", "POST", {
    id: "after-removal", date: "2026-11-24", continueSessionId: "original",
  });
  assert.equal(day.activeSession.description, "Recorded description");
  assert.equal(day.activeSession.taskId, null);
  assert.equal(day.tasks.length, 0);
});

test("continuing a previous day's work uses today's date and clock-out time", async (t) => {
  const app = harness(t);
  await app.start("original", "Yesterday's work");
  app.setTime("2026-11-24T10:00");
  await app.request("/api/sessions/original/stop", "POST", {});
  app.setTime("2026-11-25T09:00");
  const deadline = parseWorkDateTime("2026-11-25T17:00");
  await app.request("/api/days/2026-11-25", "PUT", { clockOutAt: deadline });
  const day = await app.request("/api/sessions", "POST", {
    id: "continued", date: "2026-11-25", continueSessionId: "original",
  });
  assert.equal(day.date, "2026-11-25");
  assert.equal(day.activeSession.description, "Yesterday's work");
  assert.equal(day.activeSession.clockOutAt, deadline);
  assert.equal(day.totalMilliseconds, 0);
  const previous = await app.request("/api/days/2026-11-24");
  assert.equal(previous.totalMilliseconds, 3_600_000);
});

test("continuation rejects running, missing and past-deadline targets safely", async (t) => {
  const app = harness(t);
  await app.start("original");
  await app.request("/api/sessions", "POST", {
    id: "invalid-running", date: "2026-11-24", continueSessionId: "original",
  }, 409);
  await app.request("/api/sessions", "POST", {
    id: "invalid-missing", date: "2026-11-24", continueSessionId: "missing",
  }, 404);
  let day = await app.request("/api/days/2026-11-24");
  assert.equal(day.activeSession.id, "original");
  assert.equal(day.sessions.length, 1);
  app.setTime("2026-11-24T09:30");
  await app.request("/api/sessions/original/stop", "POST", {});
  await app.request("/api/days/2026-11-24", "PUT", {
    clockOutAt: parseWorkDateTime("2026-11-24T10:00"),
  });
  app.setTime("2026-11-24T11:00");
  await app.request("/api/sessions", "POST", {
    id: "invalid-deadline", date: "2026-11-24", continueSessionId: "original",
  }, 409);
  day = await app.request("/api/days/2026-11-24");
  assert.equal(day.activeSession, null);
  assert.equal(day.sessions.length, 1);
});

test("opening after clock-out saves the deadline, not the reopening time", async (t) => {
  const app = harness(t);
  const deadline = parseWorkDateTime("2026-11-24T17:00");
  await app.request("/api/days/2026-11-24", "PUT", { clockOutAt: deadline });
  await app.start("first");
  app.setTime("2026-11-24T19:00");
  assert.equal(app.db.sqlite.prepare("SELECT ended_at FROM sessions").get().ended_at, null);
  const day = await app.request("/api/days/2026-11-24");
  assert.equal(day.activeSession, null);
  assert.equal(day.sessions[0].endedAt, deadline);
  assert.equal(day.totalMilliseconds, 8 * 3_600_000);
});

test("clock-out applies to switches and can change before expiry", async (t) => {
  const app = harness(t);
  await app.request("/api/days/2026-11-24", "PUT", {
    clockOutAt: parseWorkDateTime("2026-11-24T16:00"),
  });
  await app.start("first");
  app.setTime("2026-11-24T12:00");
  let day = await app.start("second");
  assert.equal(day.activeSession.clockOutAt, parseWorkDateTime("2026-11-24T16:00"));
  await app.request("/api/days/2026-11-24", "PUT", {
    clockOutAt: parseWorkDateTime("2026-11-24T17:30"),
  });
  app.setTime("2026-11-24T17:00");
  day = await app.request("/api/days/2026-11-24");
  assert.equal(day.activeSession.id, "second");
  app.setTime("2026-11-24T18:00");
  day = await app.request("/api/days/2026-11-24");
  assert.equal(day.sessions[0].endedAt, parseWorkDateTime("2026-11-24T17:30"));
});

test("moving a deadline after expiry never reopens the completed session", async (t) => {
  const app = harness(t);
  await app.start("first");
  await app.request("/api/days/2026-11-24", "PUT", {
    clockOutAt: parseWorkDateTime("2026-11-24T10:00"),
  });
  app.setTime("2026-11-24T11:00");
  let day = await app.request("/api/days/2026-11-24", "PUT", {
    clockOutAt: parseWorkDateTime("2026-11-24T17:00"),
  });
  assert.equal(day.activeSession, null);
  assert.equal(day.sessions[0].endedAt, parseWorkDateTime("2026-11-24T10:00"));
  day = await app.start("second");
  assert.equal(day.activeSession.id, "second");
});

test("setting a past deadline finalizes work and starting requires changing it", async (t) => {
  const app = harness(t);
  await app.start("first");
  app.setTime("2026-11-24T12:00");
  let day = await app.request("/api/days/2026-11-24", "PUT", {
    clockOutAt: parseWorkDateTime("2026-11-24T11:00"),
  });
  assert.equal(day.sessions[0].endedAt, parseWorkDateTime("2026-11-24T11:00"));
  await app.request("/api/sessions", "POST", {
    id: "second", date: day.date, description: "More work",
  }, 409);
  assert.equal(app.db.sqlite.prepare("SELECT count(*) AS count FROM tasks").get().count, 1);
  await app.request("/api/days/2026-11-24", "PUT", { clockOutAt: null });
  day = await app.start("second");
  assert.equal(day.activeSession.id, "second");
});

test("invalid clock-out rolls back without changing the active session", async (t) => {
  const app = harness(t);
  await app.start("first");
  await app.request("/api/days/2026-11-24", "PUT", {
    clockOutAt: parseWorkDateTime("2026-11-24T08:00"),
  }, 400);
  const day = await app.request("/api/days/2026-11-24");
  assert.equal(day.clockOutAt, null);
  assert.equal(day.activeSession.id, "first");
});

test("planned start times remain reminders and actual start uses the server time", async (t) => {
  const app = harness(t);
  await app.request("/api/tasks", "POST", {
    id: "planned", date: "2026-11-24", description: "Review",
    plannedStartAt: parseWorkDateTime("2026-11-24T10:00"),
  });
  app.setTime("2026-11-24T11:00");
  let day = await app.request("/api/days/2026-11-24");
  assert.equal(day.sessions.length, 0);
  day = await app.request("/api/sessions", "POST", {
    id: "actual", date: day.date, taskId: "planned",
  });
  assert.equal(day.activeSession.startedAt, parseWorkDateTime("2026-11-24T11:00"));
});

test("task renaming and removal preserve recorded descriptions and times", async (t) => {
  const app = harness(t);
  await app.start("first", "Original task");
  await app.request("/api/tasks/first", "PATCH", { description: "Renamed task" });
  let day = await app.request("/api/tasks/first", "DELETE", {});
  assert.equal(day.tasks.length, 0);
  assert.equal(day.activeSession.description, "Original task");
  assert.equal(day.activeSession.taskId, null);
  app.setTime("2026-11-24T10:00");
  day = await app.request("/api/sessions/first/stop", "POST", {});
  assert.equal(day.sessions[0].description, "Original task");
  assert.equal(day.totalMilliseconds, 3_600_000);
});

test("correcting a previous day's session updates its date and total", async (t) => {
  const app = harness(t);
  await app.start("first");
  app.setTime("2026-11-24T10:00");
  await app.request("/api/sessions/first/stop", "POST", {});
  await app.request("/api/sessions/first", "PATCH", {
    description: "Corrected",
    startedAt: parseWorkDateTime("2026-11-23T09:00"),
    endedAt: parseWorkDateTime("2026-11-23T11:00"),
  });
  const oldDay = await app.request("/api/days/2026-11-23");
  assert.equal(oldDay.sessions[0].description, "Corrected");
  assert.equal(oldDay.totalMilliseconds, 2 * 3_600_000);
  const today = await app.request("/api/days/2026-11-24");
  assert.equal(today.sessions.length, 0);
});

test("overlapping corrections roll back, and finished sessions stay finished", async (t) => {
  const app = harness(t);
  await app.start("first");
  app.setTime("2026-11-24T10:00");
  await app.start("second");
  app.setTime("2026-11-24T11:00");
  await app.request("/api/sessions/second/stop", "POST", {});
  await app.request("/api/sessions/first", "PATCH", {
    description: "Bad correction",
    startedAt: parseWorkDateTime("2026-11-24T09:00"),
    endedAt: parseWorkDateTime("2026-11-24T10:30"),
  }, 409);
  await app.request("/api/sessions/first", "PATCH", {
    description: "Bad reopening",
    startedAt: parseWorkDateTime("2026-11-24T09:00"),
    endedAt: null,
  }, 400);
  const day = await app.request("/api/days/2026-11-24");
  assert.equal(day.sessions.find((session) => session.id === "first").description, "first");
});

test("two simultaneous starts leave one active session and consistent history", async (t) => {
  const app = harness(t);
  await Promise.all([app.start("device-one"), app.start("device-two")]);
  const day = await app.request("/api/days/2026-11-24");
  assert.equal(day.sessions.filter((session) => session.endedAt === null).length, 1);
  assert.equal(day.sessions.length, 2);
  assert.equal(day.totalMilliseconds, 0);
});

test("starting a removed task cannot stop current work", async (t) => {
  const app = harness(t);
  await app.start("first");
  app.setTime("2026-11-24T10:00");
  await app.request("/api/sessions", "POST", {
    id: "missing", date: "2026-11-24", taskId: "removed",
  }, 404);
  const day = await app.request("/api/days/2026-11-24");
  assert.equal(day.activeSession.id, "first");
});

test("an overnight session remains visible and a new day has a blank deadline", async (t) => {
  const app = harness(t, "2026-11-24T23:00");
  await app.start("overnight");
  app.setTime("2026-11-25T01:00");
  let day = await app.request("/api/days/2026-11-25");
  assert.equal(day.clockOutAt, null);
  assert.equal(day.activeSession.id, "overnight");
  assert.equal(day.sessions.length, 0);
  day = await app.start("new-day");
  assert.equal(day.activeSession.date, "2026-11-25");
  const previousDay = await app.request("/api/days/2026-11-24");
  assert.equal(previousDay.totalMilliseconds, 2 * 3_600_000);
});

test("Auckland date conversion handles UTC, summer, winter and clock changes", () => {
  assert.equal(parseWorkDateTime("2026-11-24T09:00"), Date.parse("2026-11-23T20:00:00Z"));
  assert.equal(parseWorkDateTime("2026-07-24T09:00"), Date.parse("2026-07-23T21:00:00Z"));
  assert.equal(workDateTime(Date.parse("2026-11-23T20:00:00Z")), "2026-11-24T09:00:00");
  assert.throws(() => parseWorkDateTime("2026-09-27T02:30"), /does not exist/);
  assert.equal(parseWorkDateTime("2026-04-05T02:30"), Date.parse("2026-04-04T13:30:00Z"));
  assert.equal(validDate("2026-02-30"), false);
  assert.equal(validDate("2028-02-29"), true);
});

test("this week's summary includes completed days and the running session", async (t) => {
  const app = harness(t, "2026-11-23T09:00");
  await app.start("monday");
  app.setTime("2026-11-23T10:00");
  await app.request("/api/sessions/monday/stop", "POST", {});
  app.setTime("2026-11-24T09:00");
  await app.start("tuesday");
  app.setTime("2026-11-24T10:00");
  await app.request("/api/sessions/tuesday/stop", "POST", {});
  app.setTime("2026-11-25T09:00");
  await app.start("wednesday");
  app.setTime("2026-11-25T11:00");
  const day = await app.request("/api/days/2026-11-25");
  assert.equal(day.week.startDate, "2026-11-23");
  assert.equal(day.week.endDate, "2026-11-29");
  assert.equal(day.week.totalMilliseconds, 4 * 3_600_000);
  assert.deepEqual(day.week.days.map((entry) => entry.totalMilliseconds),
    [3_600_000, 3_600_000, 2 * 3_600_000, 0, 0, 0, 0]);
});

test("the weekly summary stays on this week when reviewing an older day", async (t) => {
  const app = harness(t, "2026-11-22T09:00");
  await app.start("previous-week");
  app.setTime("2026-11-22T10:00");
  await app.request("/api/sessions/previous-week/stop", "POST", {});
  app.setTime("2026-11-25T09:00");
  await app.start("current-week");
  app.setTime("2026-11-25T10:00");
  await app.request("/api/sessions/current-week/stop", "POST", {});
  const oldDay = await app.request("/api/days/2026-11-22");
  assert.equal(oldDay.totalMilliseconds, 3_600_000);
  assert.equal(oldDay.week.totalMilliseconds, 3_600_000);
  assert.equal(oldDay.week.startDate, "2026-11-23");
});

test("planned tasks add no weekly hours and corrections update the weekly summary", async (t) => {
  const app = harness(t);
  await app.request("/api/tasks", "POST", {
    id: "planned", date: "2026-11-24", description: "Future work",
    plannedStartAt: parseWorkDateTime("2026-11-24T12:00"),
  });
  let day = await app.request("/api/days/2026-11-24");
  assert.equal(day.week.totalMilliseconds, 0);
  await app.start("actual");
  app.setTime("2026-11-24T10:00");
  await app.request("/api/sessions/actual/stop", "POST", {});
  await app.request("/api/sessions/actual", "PATCH", {
    description: "Corrected",
    startedAt: parseWorkDateTime("2026-11-23T09:00"),
    endedAt: parseWorkDateTime("2026-11-23T11:00"),
  });
  day = await app.request("/api/days/2026-11-24");
  assert.equal(day.week.totalMilliseconds, 2 * 3_600_000);
  assert.equal(day.week.days[0].totalMilliseconds, 2 * 3_600_000);
  assert.equal(day.week.days[1].totalMilliseconds, 0);
});

test("weekly hours stop at the automatic clock-out deadline", async (t) => {
  const app = harness(t);
  await app.start("work");
  await app.request("/api/days/2026-11-24", "PUT", {
    clockOutAt: parseWorkDateTime("2026-11-24T10:00"),
  });
  app.setTime("2026-11-24T12:00");
  const day = await app.request("/api/days/2026-11-24");
  assert.equal(day.week.totalMilliseconds, 3_600_000);
  assert.equal(day.week.days[1].totalMilliseconds, 3_600_000);
});

test("work weeks run Monday through Sunday across year boundaries", () => {
  assert.deepEqual(workWeekDates("2026-11-29"), [
    "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29",
  ]);
  assert.deepEqual(workWeekDates("2027-01-01"), [
    "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03",
  ]);
});
