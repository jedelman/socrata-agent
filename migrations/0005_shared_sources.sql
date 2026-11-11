-- Shared research (docs/research-memory.md; Jason, 2026-11-11: research
-- counts from "Public, shared, and within the account"). One row per source
-- someone shared from a private answer with the "Share these sources" button.
-- NOT applied yet: SHARED_RESEARCH stays off until it is (wrangler.toml).
--
-- A row holds the source only: its title, its link, its kind and the city,
-- the newest day an answer read it, the days it was first and last shared,
-- and how many times it was shared. Never who shared it (no account, invite,
-- visitor or Bluesky identity), the question, the answer, or any time finer
-- than a day. Sources that could point at an address are dropped before a
-- row is written (src/prior-research.js topicSources).
--
-- A source is keyed by its normalized URL (url_key: src/answer-links.js
-- normalizeUrl, one trailing slash off the path), so "…/page" and "…/page/"
-- are one row; url keeps the link as first shared. A steward removing a
-- source sets status 'removed': it leaves the public list and every scope of
-- prior_research at once, and sharing it again (by either spelling) doesn't
-- bring it back (the upsert only updates listed rows). `id` is a random
-- public id.
CREATE TABLE shared_sources (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  url_key TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  city TEXT NOT NULL,
  read_day TEXT NOT NULL,
  first_day TEXT NOT NULL,
  last_day TEXT NOT NULL,
  shares INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'listed' CHECK (status IN ('listed', 'removed'))
);
-- The public list and prior_research: listed sources per city, last shared
-- first; the removals every scope checks.
CREATE INDEX shared_sources_list ON shared_sources (status, city, last_day, seq);
