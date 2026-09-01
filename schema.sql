-- LostTracker D1 schema
-- Live in Cloudflare D1: losttracker-db (55ddd07a-8180-42f2-ae61-b39c0e4096be)
--
-- Single-user by design: there are no accounts, so there is exactly one row.
-- Writes are gated by a shared key checked in the Worker, not by a login.

CREATE TABLE IF NOT EXISTS state (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
