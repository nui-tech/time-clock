import { WORK_TIME_ZONE, validDate, workDate, workWeekDates } from "../public/time.js";

const sessionColumns = `
  sessions.id, sessions.day AS date, sessions.task_id AS taskId,
  sessions.description, sessions.started_at AS startedAt,
  sessions.ended_at AS endedAt`;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function requireDate(value) {
  if (!validDate(value)) {
    throw new ApiError(400, "Choose a valid work date.");
  }
  return value;
}

function requireDescription(value, allowEmpty = false) {
  if (typeof value !== "string" || value.trim().length > 500 || (!allowEmpty && !value.trim())) {
    throw new ApiError(400, allowEmpty
      ? "Enter a task description of up to 500 characters."
      : "Enter a task description of 1 to 500 characters.");
  }
  return value.trim();
}

function requireTimestamp(value, optional = false) {
  if (optional && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 253402214400000) {
    throw new ApiError(400, "Enter a valid date and time.");
  }
  return value;
}

function requireId(value) {
  if (typeof value !== "string"
      || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) {
    throw new ApiError(400, "The record ID is invalid. Reload and try again.");
  }
  return value;
}

function ensureDay(db, date) {
  return db.prepare("INSERT OR IGNORE INTO days (date) VALUES (?)").bind(date);
}

function expireSessions(db, now) {
  return db.prepare(`
    UPDATE sessions
    SET ended_at = (SELECT clock_out_at FROM days WHERE date = sessions.day)
    WHERE ended_at IS NULL AND EXISTS (
      SELECT 1 FROM days
      WHERE date = sessions.day AND clock_out_at <= ?
    )`).bind(now);
}

async function dayView(db, date, now) {
  const weekDates = workWeekDates(workDate(now));
  const results = await db.batch([
    db.prepare("SELECT clock_out_at AS clockOutAt FROM days WHERE date = ?").bind(date),
    db.prepare(`
      SELECT id, description, planned_start_at AS plannedStartAt
      FROM tasks WHERE day = ? ORDER BY created_at, id`).bind(date),
    db.prepare(`
      SELECT ${sessionColumns} FROM sessions
      WHERE sessions.day = ? ORDER BY started_at DESC, id`).bind(date),
    db.prepare(`
      SELECT ${sessionColumns}, days.clock_out_at AS clockOutAt
      FROM sessions JOIN days ON days.date = sessions.day
      WHERE ended_at IS NULL`),
    db.prepare(`
      SELECT day AS date, sum(ended_at - started_at) AS totalMilliseconds
      FROM sessions
      WHERE ended_at IS NOT NULL AND day BETWEEN ? AND ?
      GROUP BY day`).bind(weekDates[0], weekDates[6]),
  ]);
  now = Math.max(now, Date.now());
  const sessions = results[2].results;
  const activeSession = results[3].results[0] ?? null;
  const activeEnd = Math.min(now, activeSession?.clockOutAt ?? Infinity);
  const activeMilliseconds = activeSession ? Math.max(0, activeEnd - activeSession.startedAt) : 0;
  const totalMilliseconds = sessions.reduce((total, session) => {
    return total + (session.endedAt ?? activeEnd) - session.startedAt;
  }, 0);
  const finishedByDate = new Map(results[4].results.map((day) => [day.date, day.totalMilliseconds]));
  const weekDays = weekDates.map((day) => ({
    date: day,
    totalMilliseconds: (finishedByDate.get(day) ?? 0) + (activeSession?.date === day ? activeMilliseconds : 0),
  }));
  return {
    date,
    timezone: WORK_TIME_ZONE,
    serverTime: now,
    clockOutAt: results[0].results[0]?.clockOutAt ?? null,
    tasks: results[1].results,
    sessions,
    activeSession,
    totalMilliseconds,
    week: {
      startDate: weekDates[0],
      endDate: weekDates[6],
      days: weekDays,
      totalMilliseconds: weekDays.reduce((total, day) => total + day.totalMilliseconds, 0),
    },
  };
}

async function readBody(request) {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
    throw new ApiError(415, "Send changes as JSON.");
  }
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new ApiError(403, "Changes must come from this app.");
  }
  try {
    const body = await request.json();
    if (!body || Array.isArray(body) || typeof body !== "object") {
      throw new Error();
    }
    return body;
  } catch {
    throw new ApiError(400, "The submitted data is invalid.");
  }
}

async function saveDay(db, date, body, now) {
  const clockOutAt = requireTimestamp(body.clockOutAt, true);
  if (clockOutAt !== null && workDate(clockOutAt) !== date) {
    throw new ApiError(400, "Choose a clock-out time on the selected day.");
  }
  await db.batch([
    ensureDay(db, date),
    expireSessions(db, now),
    db.prepare("UPDATE days SET clock_out_at = ? WHERE date = ?").bind(clockOutAt, date),
    expireSessions(db, now),
  ]);
}

async function createTask(db, body, now) {
  const date = requireDate(body.date);
  const id = requireId(body.id);
  const description = requireDescription(body.description);
  const plannedStartAt = requireTimestamp(body.plannedStartAt ?? null, true);
  if (plannedStartAt !== null && workDate(plannedStartAt) !== date) {
    throw new ApiError(400, "Choose a planned start time on the selected day.");
  }
  await db.batch([
    ensureDay(db, date),
    db.prepare(`
      INSERT INTO tasks (id, day, description, planned_start_at, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`).bind(id, date, description, plannedStartAt, now),
  ]);
  return date;
}

async function updateTask(db, id, body) {
  const task = await db.prepare("SELECT day FROM tasks WHERE id = ?").bind(id).first();
  if (!task) throw new ApiError(404, "This task has already been removed.");
  const description = requireDescription(body.description);
  const plannedStartAt = requireTimestamp(body.plannedStartAt ?? null, true);
  if (plannedStartAt !== null && workDate(plannedStartAt) !== task.day) {
    throw new ApiError(400, "Choose a planned start time on the task's day.");
  }
  await db.prepare(`
    UPDATE tasks SET description = ?, planned_start_at = ? WHERE id = ?
  `).bind(description, plannedStartAt, id).run();
  return task.day;
}

async function removeTask(db, id) {
  const task = await db.prepare("SELECT day FROM tasks WHERE id = ?").bind(id).first();
  if (!task) throw new ApiError(404, "This task has already been removed.");
  await db.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
  return task.day;
}

async function startSession(db, body, now) {
  const date = requireDate(body.date);
  if (date !== workDate(now)) {
    throw new ApiError(400, "Switch to today to start tracking work.");
  }
  const id = requireId(body.id);
  const continuedSessionId = body.continueSessionId === undefined
    ? null : requireId(body.continueSessionId);
  const description = body.taskId || continuedSessionId
    ? "" : requireDescription(body.description ?? "", true);
  const taskId = body.taskId ? requireId(body.taskId) : description ? id : null;
  const statements = [ensureDay(db, date), expireSessions(db, now)];

  if (!body.taskId && !continuedSessionId && description) {
    const plannedStartAt = requireTimestamp(body.plannedStartAt ?? null, true);
    if (plannedStartAt !== null && workDate(plannedStartAt) !== date) {
      throw new ApiError(400, "Choose a planned start time on the selected day.");
    }
    statements.push(db.prepare(`
      INSERT INTO tasks (id, day, description, planned_start_at, created_at)
      SELECT ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM days WHERE date = ? AND clock_out_at <= ?
        )
      ON CONFLICT(id) DO NOTHING`).bind(id, date, description, plannedStartAt, now, id, date, now));
  }

  // Guard both writes with the same target and request ID. Retrying a start
  // cannot stop a newer session, and a removed task cannot stop current work.
  let target;
  let targetValues;
  if (continuedSessionId) {
    target = `
      SELECT days.date AS day, previous.task_id, previous.description
      FROM sessions AS previous JOIN days ON days.date = ?
      WHERE previous.id = ? AND previous.ended_at IS NOT NULL
        AND (days.clock_out_at IS NULL OR days.clock_out_at > ?)
    `;
    targetValues = [date, continuedSessionId, now];
  } else if (taskId === null) {
    target = `
      SELECT date AS day, NULL AS task_id, '' AS description FROM days
      WHERE date = ? AND (clock_out_at IS NULL OR clock_out_at > ?)
    `;
    targetValues = [date, now];
  } else {
    target = `
      SELECT tasks.day, tasks.id AS task_id, tasks.description
      FROM tasks JOIN days ON days.date = tasks.day
      WHERE tasks.id = ? AND tasks.day = ?
        AND (days.clock_out_at IS NULL OR days.clock_out_at > ?)
    `;
    targetValues = [taskId, date, now];
  }
  statements.push(
    db.prepare(`
      UPDATE sessions SET ended_at = ?
      WHERE ended_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM sessions WHERE id = ?)
        AND EXISTS (${target})`).bind(now, id, ...targetValues),
    db.prepare(`
      INSERT INTO sessions (id, day, task_id, description, started_at)
      SELECT ?, target.day, target.task_id, target.description, ?
      FROM (${target}) AS target
      WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM sessions WHERE ended_at IS NULL)
    `).bind(id, now, ...targetValues, id),
  );
  await db.batch(statements);

  const session = await db.prepare("SELECT id FROM sessions WHERE id = ?").bind(id).first();
  if (session) return date;

  const day = await db.prepare("SELECT clock_out_at FROM days WHERE date = ?").bind(date).first();
  if (day.clock_out_at !== null && day.clock_out_at <= now) {
    throw new ApiError(409, "Today's clock-out time has passed. Change or clear it to start again.");
  }
  if (continuedSessionId) {
    const previous = await db.prepare("SELECT id FROM sessions WHERE id = ?").bind(continuedSessionId).first();
    if (!previous) throw new ApiError(404, "This session could not be found.");
    throw new ApiError(409, "This session is still running. Stop it before continuing.");
  }
  throw new ApiError(404, "This task has already been removed.");
}

async function stopSession(db, id, now) {
  const session = await db.prepare("SELECT day FROM sessions WHERE id = ?").bind(id).first();
  if (!session) throw new ApiError(404, "This session could not be found.");
  await db.prepare(`
    UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL
  `).bind(now, id).run();
  return session.day;
}

async function updateSession(db, id, body, now) {
  const session = await db.prepare(`
    SELECT day, started_at, ended_at, task_id, description FROM sessions WHERE id = ?
  `).bind(id).first();
  if (!session) throw new ApiError(404, "This session could not be found.");
  const description = requireDescription(body.description, true);
  const descriptionOnly = body.startedAt === undefined && body.endedAt === undefined;
  const startedAt = descriptionOnly ? session.started_at : requireTimestamp(body.startedAt);
  const endedAt = descriptionOnly ? session.ended_at : requireTimestamp(body.endedAt, true);
  if (!descriptionOnly && (startedAt > now || (endedAt !== null && (endedAt < startedAt || endedAt > now)))) {
    throw new ApiError(400, "Start and finish must be in the past, with finish after start.");
  }
  if (!descriptionOnly && session.ended_at !== null && endedAt === null) {
    throw new ApiError(400, "A finished session needs a finish time.");
  }
  const date = descriptionOnly ? session.day : workDate(startedAt);
  const statements = [ensureDay(db, date)];
  let taskId = session.task_id;
  if (taskId === null && session.description === "" && description) {
    taskId = id;
    statements.push(db.prepare(`
      INSERT INTO tasks (id, day, description, created_at)
      SELECT ?, CASE WHEN ? = 1 THEN day ELSE ? END, ?, ? FROM sessions
      WHERE id = ? AND description = '' AND task_id IS NULL
        AND (? = 1 OR ended_at IS NULL OR ? IS NOT NULL)
      ON CONFLICT(id) DO NOTHING
    `).bind(taskId, Number(descriptionOnly), date, description, now, id, Number(descriptionOnly), endedAt));
  }
  const update = descriptionOnly ? db.prepare(`
      UPDATE sessions
      SET description = ?, task_id = coalesce(task_id, (SELECT id FROM tasks WHERE id = ?))
      WHERE id = ?
    `).bind(description, taskId, id) : db.prepare(`
      UPDATE sessions
      SET description = ?, started_at = ?, ended_at = ?, day = ?,
        task_id = coalesce(task_id, (SELECT id FROM tasks WHERE id = ?))
      WHERE id = ? AND (ended_at IS NULL OR ? IS NOT NULL)
    `).bind(description, startedAt, endedAt, date, taskId, id, endedAt);
  statements.push(update);
  if (descriptionOnly && description) {
    statements.push(db.prepare(`
      UPDATE tasks SET description = ?
      WHERE id = ? AND EXISTS (
        SELECT 1 FROM sessions WHERE id = ? AND task_id = tasks.id
      )
    `).bind(description, id, id));
  }
  statements.push(expireSessions(db, now));
  const results = await db.batch(statements);
  const updateIndex = statements.indexOf(update);
  if (results[updateIndex].meta.changes === 0) {
    throw new ApiError(409, "This session has finished on another device. Reload before editing it.");
  }
  return date;
}

async function dispatch(request, db, now) {
  const url = new URL(request.url);
  const dayRoute = /^\/api\/days\/(\d{4}-\d{2}-\d{2})$/.exec(url.pathname);
  const taskRoute = /^\/api\/tasks\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
  const sessionRoute = /^\/api\/sessions\/([a-zA-Z0-9_-]+)(\/stop)?$/.exec(url.pathname);
  const method = request.method;

  if (method === "GET" && dayRoute) {
    return json(await dayView(db, requireDate(dayRoute[1]), now));
  }
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    throw new ApiError(404, "This API endpoint does not exist.");
  }

  const body = await readBody(request);
  let date;
  if (method === "PUT" && dayRoute) {
    date = requireDate(dayRoute[1]);
    await saveDay(db, date, body, now);
  } else if (method === "POST" && url.pathname === "/api/tasks") {
    date = await createTask(db, body, now);
  } else if (method === "PATCH" && taskRoute) {
    date = await updateTask(db, requireId(taskRoute[1]), body);
  } else if (method === "DELETE" && taskRoute) {
    date = await removeTask(db, requireId(taskRoute[1]));
  } else if (method === "POST" && url.pathname === "/api/sessions") {
    date = await startSession(db, body, now);
  } else if (method === "POST" && sessionRoute?.[2]) {
    date = await stopSession(db, requireId(sessionRoute[1]), now);
  } else if (method === "PATCH" && sessionRoute && !sessionRoute[2]) {
    date = await updateSession(db, requireId(sessionRoute[1]), body, now);
  } else {
    throw new ApiError(404, "This API endpoint does not exist.");
  }
  return json(await dayView(db, date, now));
}

export async function handleApi(request, db) {
  try {
    const now = Date.now();
    await expireSessions(db, now).run();
    return await dispatch(request, db, now);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    if (error.message.includes("Work sessions cannot overlap")) {
      return json({ error: "These times overlap another session. Adjust the start or finish." }, 409);
    }
    if (error.message.includes("Clock-out must be after")) {
      return json({ error: "Clock-out must be after the active session starts." }, 400);
    }
    if (error.message.includes("UNIQUE constraint") || error.message.includes("CHECK constraint")) {
      return json({ error: "Work changed on another device. Reload and try again." }, 409);
    }
    console.error(error);
    return json({ error: "Your change could not be saved. Please try again." }, 500);
  }
}
