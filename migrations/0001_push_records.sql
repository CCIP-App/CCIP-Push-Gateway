CREATE TABLE push_records (
    push_id TEXT PRIMARY KEY NOT NULL,
    event_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    content_json TEXT NOT NULL CHECK (json_valid(content_json)),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json))
);

CREATE INDEX push_records_event_created ON push_records (event_id, created_at);
