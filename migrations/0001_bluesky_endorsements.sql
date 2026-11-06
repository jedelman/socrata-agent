-- Siren's Bluesky endorsements, their rate counters and the sign-in
-- single-use markers (docs/bluesky-endorsements.md). Applied with
--   npx wrangler d1 migrations apply SIREN_DB --env siren --remote
--
-- Nothing here holds a DID, a handle, an authorization server, a token or a
-- network address: only keyed, domain-separated HMACs, a request's public id,
-- a one-bit age flag and expiry times. Every table is WITHOUT ROWID, so none
-- keeps an insertion order that could pair rows written together. No counter
-- row carries a request id or any part of an endorsement id, so the counter
-- table can't be joined to the endorsement tables. Rows past `exp` are never
-- read and are deleted by endorsements.js purgeExpired (daily by the cron,
-- and where the counts are computed).

-- One row per (request, Bluesky account). eh = HMAC(INVITE_SECRET,
-- 'endorsement:' || request_id || ':' || eid), 32 hex, where eid =
-- HMAC(INVITE_SECRET, 'endorser:' || DID) lives only in the sealed session
-- cookie. One account's rows on different requests share nothing.
CREATE TABLE endorsements (
  eh TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  y INTEGER,
  exp INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX endorsements_request ON endorsements (request_id);
CREATE INDEX endorsements_exp ON endorsements (exp);

-- Per-request tallies, kept exact by the triggers below, so a count reads
-- one row per request instead of every endorsement. young counts y = 1,
-- unknown counts y IS NULL (did:web, or an age lookup that failed).
CREATE TABLE endorsement_counts (
  request_id TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  young INTEGER NOT NULL,
  unknown INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TRIGGER endorsements_count_insert AFTER INSERT ON endorsements
BEGIN
  INSERT INTO endorsement_counts (request_id, n, young, unknown)
  VALUES (NEW.request_id, 1, NEW.y IS 1, NEW.y IS NULL)
  ON CONFLICT (request_id) DO UPDATE SET
    n = n + 1,
    young = young + (NEW.y IS 1),
    unknown = unknown + (NEW.y IS NULL);
END;

CREATE TRIGGER endorsements_count_delete AFTER DELETE ON endorsements
BEGIN
  UPDATE endorsement_counts SET
    n = n - 1,
    young = young - (OLD.y IS 1),
    unknown = unknown - (OLD.y IS NULL)
  WHERE request_id = OLD.request_id;
  DELETE FROM endorsement_counts WHERE request_id = OLD.request_id AND n <= 0;
END;

CREATE TRIGGER endorsements_count_update AFTER UPDATE OF y ON endorsements
BEGIN
  UPDATE endorsement_counts SET
    young = young - (OLD.y IS 1) + (NEW.y IS 1),
    unknown = unknown - (OLD.y IS NULL) + (NEW.y IS NULL)
  WHERE request_id = OLD.request_id;
END;

-- Rate counters, one row per (kind, period, keyed hash), incremented in
-- place (D1 writes are serialized, so an increment is never lost). k is
-- '<kind>:<period>:<hash32>': ed, ev, ei, er for endorse and unendorse
-- actions per account, per visitor, and new endorsements per server and per
-- domain (day-scoped HMACs, each in its own domain); bl for login starts per
-- visitor (hour). exp is shared by every row of a kind and period.
CREATE TABLE bsky_rate_counts (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  exp INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX bsky_rate_counts_exp ON bsky_rate_counts (exp);

-- Single-use markers for finished sign-ins: the first 32 hex of
-- sha256(state). A replayed callback finds its marker and is refused.
CREATE TABLE bsky_flows_used (
  sh TEXT PRIMARY KEY,
  exp INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX bsky_flows_used_exp ON bsky_flows_used (exp);
