-- Rebuild sessions to allow an empty description while retaining existing data.
DROP TRIGGER prevent_overlapping_session_insert;
DROP TRIGGER prevent_overlapping_session_update;
DROP TRIGGER validate_clock_out;

CREATE TABLE sessions_new (
    id TEXT PRIMARY KEY,
    day TEXT NOT NULL REFERENCES days(date),
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    description TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

INSERT INTO sessions_new (id, day, task_id, description, started_at, ended_at)
SELECT id, day, task_id, description, started_at, ended_at FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE UNIQUE INDEX one_active_session
    ON sessions ((1)) WHERE ended_at IS NULL;

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
