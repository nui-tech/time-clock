import {
  formatDay, formatDuration, formatWeekRange, formatWorkTime, parseWorkDateTime,
  workDate, workDateTime, workTimeInput,
} from "./time.js";
import { createDescriptionAutosave } from "./description-autosave.js";

const $ = (selector) => document.querySelector(selector);
let selectedDate = workDate();
let data = null;
let receivedAt = performance.now();
let busy = false;
let clockOutDirty = false;
let loadSequence = 0;
let editingTask = null;
let editingSession = null;
let expiryRefresh = null;
let lastCreateAttempt = null;
let descriptionRefreshPending = false;
const descriptionAutosave = createDescriptionAutosave({
  save: saveDescription,
  canSave: () => !busy,
  onChange: () => {
    if (data) renderActiveDescription();
    refreshAfterDescriptionSave();
  },
});

$("#day-picker").value = selectedDate;

function serverNow() {
  return data ? data.serverTime + performance.now() - receivedAt : Date.now();
}

function effectiveEnd(session) {
  if (session.endedAt !== null) return session.endedAt;
  const deadline = session.id === data.activeSession?.id
    ? data.activeSession.clockOutAt : data.clockOutAt;
  return Math.min(serverNow(), deadline ?? Infinity);
}

function activeIsRunning() {
  return data?.activeSession
    && (data.activeSession.clockOutAt === null || serverNow() < data.activeSession.clockOutAt);
}

async function api(path, method = "GET", body, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      ...options,
    });
  } catch {
    throw new Error("Unable to connect. Your changes are still here. Please try again.");
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The app could not load your data. Reload and try again.");
  }
  if (!response.ok) throw new Error(result.error || "Your change could not be saved.");
  return result;
}

function clearErrors() {
  $("#notice").hidden = true;
  $("#task-error").hidden = true;
  $("#session-error").hidden = true;
}

function showError(error) {
  const dialog = document.querySelector("dialog[open]");
  const target = dialog ? dialog.querySelector(".form-error") : $("#notice-text");
  target.textContent = error.message;
  target.hidden = false;
  if (!dialog) $("#notice").hidden = false;
}

function updateDisabled() {
  document.querySelectorAll("button, input").forEach((control) => {
    control.disabled = busy;
  });
  $("#active-description").disabled = false;
  $("#start-work-button").disabled = busy || !data || Boolean(activeIsRunning());
  const canStart = data && selectedDate === workDate(serverNow());
  $("#start-new-task").disabled = busy || !canStart;
  document.querySelectorAll('[data-action="start"]').forEach((button) => {
    button.disabled = busy || !canStart;
  });
}

function applyData(result) {
  data = result;
  selectedDate = result.date;
  receivedAt = performance.now();
  $("#day-picker").value = selectedDate;
  render();
}

async function loadDay(date = selectedDate) {
  if (busy) return;
  const sequence = ++loadSequence;
  const changingDate = date !== selectedDate;
  if (changingDate) {
    busy = true;
    updateDisabled();
  }
  try {
    const result = await api(`/api/days/${date}`);
    if (sequence !== loadSequence) return;
    if (date !== selectedDate) clockOutDirty = false;
    applyData(result);
  } catch (error) {
    if (sequence === loadSequence) {
      $("#day-picker").value = selectedDate;
      showError(error);
    }
  } finally {
    if (changingDate) {
      busy = false;
      updateDisabled();
    }
    refreshAfterDescriptionSave();
  }
}

async function mutate(path, method, body, onSuccess) {
  if (busy) return;
  busy = true;
  ++loadSequence;
  clearErrors();
  updateDisabled();
  const editedSession = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (method === "PATCH" && editedSession && body.description !== undefined) {
    descriptionAutosave.discard(editedSession[1]);
    await descriptionAutosave.flush();
  }
  const createsRecord = method === "POST" && (path === "/api/tasks" || path === "/api/sessions");
  if (createsRecord) {
    const key = JSON.stringify({ path, ...body, id: null });
    if (lastCreateAttempt?.key === key) {
      body = { ...body, id: lastCreateAttempt.id };
    } else {
      lastCreateAttempt = { key, id: body.id };
    }
  }
  try {
    const result = await api(path, method, body);
    if (createsRecord) lastCreateAttempt = null;
    onSuccess?.(result);
    // A stop may belong to another work date. Keep the day being viewed.
    if (result.date === selectedDate) {
      applyData(result);
    } else {
      const day = await api(`/api/days/${selectedDate}`);
      applyData(day);
    }
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    updateDisabled();
    refreshAfterDescriptionSave();
  }
}

async function saveDescription(draft) {
  const sequence = ++loadSequence;
  const result = await api(`/api/sessions/${draft.id}`, "PATCH", {
    description: draft.value,
  }, { keepalive: true });
  if (sequence === loadSequence && result.date === selectedDate) {
    applyData(result);
  } else {
    const saved = result.sessions.find((session) => session.id === draft.id);
    const current = data?.sessions.find((session) => session.id === draft.id);
    if (current && saved) current.description = saved.description;
    if (saved && data?.activeSession?.id === draft.id) {
      data.activeSession.description = saved.description;
    }
    descriptionRefreshPending = true;
  }
}

function refreshAfterDescriptionSave() {
  if (descriptionRefreshPending && !busy && !descriptionAutosave.saving) {
    descriptionRefreshPending = false;
    loadDay();
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionButton(text, action, id, className = "text-button") {
  const button = element("button", className, text);
  button.type = "button";
  button.dataset.action = action;
  button.dataset.id = id;
  return button;
}

function renderTasks() {
  const list = $("#tasks");
  list.replaceChildren();
  $("#tasks-empty").hidden = data.tasks.length > 0;
  for (const task of data.tasks) {
    const running = activeIsRunning() && data.activeSession.taskId === task.id;
    const row = element("div", `task-row${running ? " is-running" : ""}`);
    const info = element("div");
    info.append(element("p", "task-name", task.description));
    if (task.plannedStartAt !== null) {
      info.append(element("p", "task-meta", `Planned ${formatWorkTime(task.plannedStartAt)}`));
    }
    const actions = element("div", "task-actions");
    actions.append(
      actionButton("Edit", "edit-task", task.id),
      actionButton("Remove", "remove-task", task.id),
      actionButton(running ? "Stop" : "Start", running ? "stop-task" : "start",
        task.id, "button secondary"),
    );
    row.append(info, actions);
    list.append(row);
  }
}

function sessionTimeRange(session) {
  const finish = session.endedAt === null ? "Running" : formatWorkTime(session.endedAt);
  const crossesDay = session.endedAt !== null && workDate(session.endedAt) !== session.date;
  const finishText = crossesDay ? `${finish} · ${workDate(session.endedAt)}` : finish;
  return `${formatWorkTime(session.startedAt)} – ${finishText}`;
}

function renderSessions() {
  const list = $("#sessions");
  list.replaceChildren();
  $("#sessions-empty").hidden = data.sessions.length > 0;
  for (const session of data.sessions) {
    const row = element("div", "session-row");
    const info = element("div", "session-info");
    info.append(
      element("p", "session-description", session.description || "Task not added yet"),
      element("p", "session-times", sessionTimeRange(session)),
    );
    const duration = element("span", "session-duration");
    duration.dataset.durationId = session.id;
    const actions = element("div", "session-actions");
    actions.append(actionButton("Edit", "edit-session", session.id));
    if (session.endedAt !== null) {
      actions.append(actionButton("Continue", "continue-session", session.id, "button secondary"));
    }
    row.append(info, duration, actions);
    list.append(row);
  }
}

function renderWeek() {
  if (!data.week) return;
  $("#week-range").textContent = formatWeekRange(data.week.startDate, data.week.endDate);
  const list = $("#week-days");
  list.replaceChildren();
  const today = workDate(serverNow());
  const formatter = new Intl.DateTimeFormat("en-NZ", { timeZone: "UTC", weekday: "short" });
  for (const day of data.week.days) {
    const button = element("button", `week-day${day.date === today ? " is-today" : ""}`);
    button.type = "button";
    button.dataset.date = day.date;
    button.setAttribute("aria-label", `View ${formatDay(day.date)}`);
    const duration = element("strong");
    duration.dataset.weekDate = day.date;
    button.append(element("span", "", formatter.format(Date.parse(`${day.date}T12:00:00Z`))), duration);
    list.append(button);
  }
}

function renderActiveDescription() {
  const active = data.activeSession;
  const input = $("#active-description");
  const draft = descriptionAutosave.draft;
  const focused = document.activeElement === input;
  const id = draft?.id || (focused && input.dataset.sessionId) || active?.id || "";
  $("#active-description-form").hidden = !id;
  if (!draft && (!focused || input.dataset.sessionId !== id)) {
    const session = active?.id === id ? active : data.sessions.find((item) => item.id === id);
    input.value = session?.description ?? "";
  }
  input.dataset.sessionId = id;
  $("#description-context").hidden = !id || id === active?.id;
  const status = $("#description-save-status");
  if (status.textContent !== descriptionAutosave.status) {
    status.textContent = descriptionAutosave.status;
  }
  status.hidden = !descriptionAutosave.status;
}

function render() {
  const today = workDate(serverNow());
  $("#day-title").textContent = selectedDate === today ? "Today" : "Your workday";
  $("#day-subtitle").textContent = formatDay(selectedDate);
  $("#total-label").textContent = selectedDate === today ? "Total worked today" : "Total worked";
  const active = data.activeSession;
  $("#timer-heading").textContent = activeIsRunning()
    ? active.description ? "Working on" : "Tracking time"
    : "Ready to start";
  renderActiveDescription();
  $("#start-work-button").hidden = Boolean(activeIsRunning());
  $("#running-status").hidden = !activeIsRunning();
  $("#stop-button").hidden = !activeIsRunning();
  $("#active-started").textContent = active
    ? `Started ${active.date === today ? "" : `${active.date} · `}${formatWorkTime(active.startedAt)}`
    : "Your timer stays saved when you close this page.";
  if (!clockOutDirty) {
    $("#clock-out-time").value = data.clockOutAt === null ? "" : workTimeInput(data.clockOutAt);
  }
  $("#clear-clock-out").hidden = data.clockOutAt === null;
  $("#clock-out-help").textContent = data.clockOutAt === null
    ? "Set a finish time for this day."
    : `All tasks finish by ${formatWorkTime(data.clockOutAt)}.`;
  renderTasks();
  renderSessions();
  renderWeek();
  tick();
  updateDisabled();
}

function tick() {
  if (!data) return;
  const active = data.activeSession;
  $("#timer").textContent = active
    ? formatDuration(effectiveEnd(active) - active.startedAt, true) : "00:00:00";
  let total = 0;
  for (const session of data.sessions) {
    const duration = effectiveEnd(session) - session.startedAt;
    total += duration;
    const target = document.querySelector(`[data-duration-id="${session.id}"]`);
    if (target) target.textContent = formatDuration(duration);
  }
  $("#day-total").textContent = formatDuration(total);
  if (data.week) {
    const activeBaselineEnd = Math.min(data.serverTime, active?.clockOutAt ?? Infinity);
    const liveMilliseconds = active ? Math.max(0, effectiveEnd(active) - activeBaselineEnd) : 0;
    let weekTotal = 0;
    for (const day of data.week.days) {
      const duration = day.totalMilliseconds + (active?.date === day.date ? liveMilliseconds : 0);
      weekTotal += duration;
      const target = document.querySelector(`[data-week-date="${day.date}"]`);
      if (target) target.textContent = formatDuration(duration);
    }
    $("#week-total").textContent = formatDuration(weekTotal);
  }
  if (active && !activeIsRunning()) {
    $("#timer-heading").textContent = "Clocked out";
    $("#running-status").hidden = true;
    $("#stop-button").hidden = true;
    $("#start-work-button").hidden = false;
    if (expiryRefresh !== active.id && !busy) {
      expiryRefresh = active.id;
      loadDay();
    }
  }
}

$("#day-picker").addEventListener("change", () => {
  if ($("#day-picker").value) loadDay($("#day-picker").value);
});
$("#today-button").addEventListener("click", () => loadDay(workDate(serverNow())));
$("#week-days").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-date]");
  if (button && !busy) loadDay(button.dataset.date);
});
$("#reload-button").addEventListener("click", () => {
  clearErrors();
  loadDay();
});
$("#dismiss-notice").addEventListener("click", clearErrors);
$("#clock-out-time").addEventListener("input", () => { clockOutDirty = true; });

$("#clock-out-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const value = $("#clock-out-time").value;
    const clockOutAt = value ? parseWorkDateTime(`${selectedDate}T${value}`) : null;
    mutate(`/api/days/${selectedDate}`, "PUT", { clockOutAt }, () => {
      clockOutDirty = false;
    });
  } catch (error) {
    showError(error);
  }
});
$("#clear-clock-out").addEventListener("click", () => {
  mutate(`/api/days/${selectedDate}`, "PUT", { clockOutAt: null }, () => {
    clockOutDirty = false;
  });
});

$("#start-work-button").addEventListener("click", () => {
  if (busy || !data || activeIsRunning()) return;
  mutate("/api/sessions", "POST", {
    id: crypto.randomUUID(),
    date: workDate(serverNow()),
  }, (result) => {
    if (selectedDate !== result.date) clockOutDirty = false;
    selectedDate = result.date;
  });
});

$("#new-task-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const description = $("#new-task-description").value.trim();
    const start = event.submitter?.value === "start";
    if (!start && !description) throw new Error("Enter a task description.");
    const id = crypto.randomUUID();
    const plannedTime = $("#new-task-time").value;
    const body = {
      id, date: selectedDate, description,
      plannedStartAt: plannedTime ? parseWorkDateTime(`${selectedDate}T${plannedTime}`) : null,
    };
    mutate(start ? "/api/sessions" : "/api/tasks", "POST", body, () => {
      $("#new-task-form").reset();
      $("#new-task-description").focus();
    });
  } catch (error) {
    showError(error);
  }
});

function stopActive() {
  const active = data?.activeSession;
  if (active) mutate(`/api/sessions/${active.id}/stop`, "POST", {});
}
$("#stop-button").addEventListener("click", stopActive);

$("#active-description").addEventListener("input", (event) => {
  const input = $("#active-description");
  const id = descriptionAutosave.draft?.id || input.dataset.sessionId || data?.activeSession?.id;
  if (id) {
    descriptionAutosave.update(id, input.value, event.isComposing);
  }
});
$("#active-description").addEventListener("compositionstart", () => descriptionAutosave.pause());
$("#active-description").addEventListener("compositionend", () => {
  const input = $("#active-description");
  const id = descriptionAutosave.draft?.id || input.dataset.sessionId;
  if (id) descriptionAutosave.update(id, input.value);
});
$("#active-description").addEventListener("blur", () => {
  descriptionAutosave.flush();
  renderActiveDescription();
});
$("#active-description-form").addEventListener("submit", (event) => {
  event.preventDefault();
  descriptionAutosave.flush();
});

$("#tasks").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || busy) return;
  const task = data.tasks.find((item) => item.id === button.dataset.id);
  if (!task) return;
  switch (button.dataset.action) {
    case "start":
      mutate("/api/sessions", "POST", {
        id: crypto.randomUUID(), date: selectedDate, taskId: task.id,
      });
      break;
    case "stop-task":
      stopActive();
      break;
    case "remove-task":
      mutate(`/api/tasks/${task.id}`, "DELETE", {});
      break;
    case "edit-task":
      editingTask = task;
      $("#edit-task-description").value = task.description;
      $("#edit-task-time").value = task.plannedStartAt === null ? "" : workTimeInput(task.plannedStartAt);
      clearErrors();
      $("#task-dialog").showModal();
      break;
  }
});

$("#edit-task-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const value = $("#edit-task-time").value;
    const plannedStartAt = value ? parseWorkDateTime(`${selectedDate}T${value}`) : null;
    mutate(`/api/tasks/${editingTask.id}`, "PATCH", {
      description: $("#edit-task-description").value,
      plannedStartAt,
    }, () => $("#task-dialog").close());
  } catch (error) {
    showError(error);
  }
});

function openSessionEditor(session) {
  editingSession = { ...session };
  if (descriptionAutosave.draft?.id === session.id) {
    editingSession.description = descriptionAutosave.draft.value;
  }
  $("#edit-session-description").value = editingSession.description;
  $("#edit-session-start").value = workDateTime(editingSession.startedAt);
  $("#edit-session-finish").value = editingSession.endedAt === null
    ? "" : workDateTime(editingSession.endedAt);
  editingSession.initialStartValue = $("#edit-session-start").value;
  editingSession.initialFinishValue = $("#edit-session-finish").value;
  $("#edit-session-finish").required = editingSession.endedAt !== null;
  $("#session-finish-help").hidden = editingSession.endedAt !== null;
  clearErrors();
  $("#session-dialog").showModal();
}

$("#sessions").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || busy) return;
  const session = data.sessions.find((item) => item.id === button.dataset.id);
  if (!session) return;
  if (button.dataset.action === "continue-session") {
    mutate("/api/sessions", "POST", {
      id: crypto.randomUUID(),
      date: workDate(serverNow()),
      continueSessionId: session.id,
    }, (result) => {
      if (selectedDate !== result.date) clockOutDirty = false;
      selectedDate = result.date;
    });
  } else if (button.dataset.action === "edit-session") {
    openSessionEditor(session);
  }
});

$("#edit-session-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const startValue = $("#edit-session-start").value;
    const finishValue = $("#edit-session-finish").value;
    const startedAt = startValue === editingSession.initialStartValue
      ? editingSession.startedAt : parseWorkDateTime(startValue);
    let endedAt = null;
    if (finishValue) {
      endedAt = editingSession.endedAt !== null
        && finishValue === editingSession.initialFinishValue
        ? editingSession.endedAt : parseWorkDateTime(finishValue);
    }
    mutate(`/api/sessions/${editingSession.id}`, "PATCH", {
      description: $("#edit-session-description").value,
      startedAt,
      endedAt,
    }, () => $("#session-dialog").close());
  } catch (error) {
    showError(error);
  }
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
});
window.addEventListener("focus", () => loadDay());
window.addEventListener("online", () => {
  descriptionAutosave.flush();
  loadDay();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) descriptionAutosave.flush();
});
window.addEventListener("pagehide", () => descriptionAutosave.flush());
setInterval(tick, 1000);
setInterval(() => {
  if (!document.hidden) loadDay();
}, 30_000);
loadDay();
