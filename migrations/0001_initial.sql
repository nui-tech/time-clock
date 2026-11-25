CREATE TABLE days (
    date TEXT PRIMARY KEY,
    clock_out_at INTEGER
);

CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    day TEXT NOT NULL REFERENCES days(date),
    description TEXT NOT NULL CHECK (length(trim(description)) > 0),
    planned_start_at INTEGER,
    created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    day TEXT NOT NULL REFERENCES days(date),
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    description TEXT NOT NULL CHECK (length(trim(description)) > 0),
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE UNIQUE INDEX one_active_session
    ON sessions ((1)) WHERE ended_at IS NULL;

CREATE INDEX tasks_by_day ON tasks(day, created_at);
CREATE INDEX sessions_by_day ON sessions(day, started_at);

CREATE TRIGGER prevent_overlapping_session_insert
BEFORE INSERT ON sessions
WHEN EXISTS (
    SELECT 1 FROM sessions
    WHERE started_at < coalesce(NEW.ended_at, 9223372036854775807)
      AND coalesce(ended_at, 9223372036854775807) > NEW.started_at
)
BEGIN
    SELECT RAISE(ABORT, 'Work sessions cannot overlap');
END;

CREATE TRIGGER prevent_overlapping_session_update
BEFORE UPDATE OF started_at, ended_at ON sessions
WHEN EXISTS (
    SELECT 1 FROM sessions
    WHERE id <> NEW.id
      AND started_at < coalesce(NEW.ended_at, 9223372036854775807)
      AND coalesce(ended_at, 9223372036854775807) > NEW.started_at
)
BEGIN
    SELECT RAISE(ABORT, 'Work sessions cannot overlap');
END;

CREATE TRIGGER validate_clock_out
BEFORE UPDATE OF clock_out_at ON days
WHEN NEW.clock_out_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM sessions
    WHERE day = NEW.date AND ended_at IS NULL
      AND started_at > NEW.clock_out_at
)
BEGIN
    SELECT RAISE(ABORT, 'Clock-out must be after the active session starts');
END;
