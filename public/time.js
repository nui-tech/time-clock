export const WORK_TIME_ZONE = "Pacific/Auckland";

const workFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: WORK_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function workParts(timestamp) {
  return Object.fromEntries(
    workFormatter.formatToParts(timestamp)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

export function workDate(timestamp = Date.now()) {
  const parts = workParts(timestamp);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function workDateTime(timestamp) {
  const parts = workParts(timestamp);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function workTimeInput(timestamp) {
  return workDateTime(timestamp).slice(11, 16);
}

export function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function parseWorkDateTime(value) {
  if (typeof value !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) {
    throw new Error("Enter a valid date and time.");
  }

  const normalized = value.length === 16 ? `${value}:00` : value;
  const wallTimestamp = Date.parse(`${normalized}Z`);
  if (!Number.isFinite(wallTimestamp)
      || new Date(wallTimestamp).toISOString().slice(0, 19) !== normalized) {
    throw new Error("Enter a valid date and time.");
  }

  // Sample both sides of a daylight-saving transition to find the UTC offset.
  const probes = [-36, 0, 36].map((hours) => wallTimestamp + hours * 3_600_000);
  const offsets = new Set(probes.map((timestamp) => {
    const displayed = Date.parse(`${workDateTime(timestamp)}Z`);
    return displayed - timestamp;
  }));
  const candidates = [...offsets]
    .map((offset) => wallTimestamp - offset)
    .filter((timestamp) => workDateTime(timestamp) === normalized);

  if (candidates.length === 0) {
    throw new Error("That time does not exist in Auckland because the clocks change. Choose another time.");
  }
  return Math.min(...candidates);
}

export function formatWorkTime(timestamp) {
  return new Intl.DateTimeFormat("en-NZ", {
    timeZone: WORK_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

export function formatDay(date) {
  return new Intl.DateTimeFormat("en-NZ", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(Date.parse(`${date}T12:00:00Z`));
}

export function workWeekDates(date) {
  const timestamp = Date.parse(`${date}T12:00:00Z`);
  const weekday = new Date(timestamp).getUTCDay();
  const monday = timestamp - ((weekday + 6) % 7) * 86_400_000;
  return Array.from({ length: 7 }, (_, offset) => {
    return new Date(monday + offset * 86_400_000).toISOString().slice(0, 10);
  });
}

export function formatWeekRange(start, end) {
  return new Intl.DateTimeFormat("en-NZ", {
    timeZone: "UTC", day: "numeric", month: "short", year: "numeric",
  }).formatRange(Date.parse(`${start}T12:00:00Z`), Date.parse(`${end}T12:00:00Z`));
}

export function formatDuration(milliseconds, showSeconds = false) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  if (showSeconds) {
    return [hours, minutes, seconds % 60]
      .map((value) => String(value).padStart(2, "0"))
      .join(":");
  }
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}
