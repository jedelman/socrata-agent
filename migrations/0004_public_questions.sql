-- The free tier's public questions (docs/free-tier.md): one row per
-- question asked in public with Bluesky, and Siren's answer to it. NOT
-- applied yet: it is a rollout step for Jason (docs/free-tier.md, "Flags and
-- rollout"), with
--   npx wrangler d1 migrations apply SIREN_DB --env siren --remote
-- That command applies every pending migration, so it applies 0003 too,
-- which drops the old endorsement tables: check they're empty first
-- (docs/bluesky-endorsements.md, Rollout, step 5).
--
-- What a row holds is public by the asker's choice: the record's AT-URI and
-- CID, the asker's DID and handle (as verified when answered), the city, the
-- question (the record's own text), the answer and the record shown under it
-- (worker/conversations.js answerRecord). Never stored here, or anywhere
-- beside a DID or handle: the invite, the visitor hash, an email account, a
-- conversation (CLAUDE.md). Dates are days; checked_ms, when the record was
-- last confirmed present, is internal, never shown, and kept to ten-minute
-- steps. That keeps exact times out of this table; it doesn't stop an
-- operator matching a question to an invite through other records with
-- exact times (docs/free-tier.md, "What is stored").
--
-- A Cron Trigger (worker/index.js scheduled) re-checks every answered or
-- hidden question about hourly and withdraws one whose record is gone.
--
-- Threads (Jason, 2026-11-10): a follow-up's record names the question it
-- replies to and its thread's root (strongRefs). root_uri and parent_uri
-- hold those records' AT-URIs (NULL on a root), depth is 0 for a root. When
-- a question is withdrawn, every root_uri or parent_uri naming its URI
-- becomes 'withdrawn:<its id>', so the thread keeps its shape without the
-- withdrawn asker's DID.
--
-- A withdrawn row keeps only id, day, status and its place in the thread
-- (root_uri, parent_uri, depth, which name only other questions): every
-- other column is emptied (question_uri too, so the record's URI is gone
-- with it). A hidden row keeps everything, so the steward can unhide it.
--
-- tools is internal and never served: the answer's tool results, trimmed as
-- a private conversation keeps them (worker/conversations.js), so a
-- follow-up's answer gets them back as data, the way the chat does.
--
-- Portable on purpose: the question's record is kept by AT-URI and CID, and
-- the answer as plain data, so if Siren gets a DID of her own, each answer
-- can become a record in her repo pointing at its question by strongRef
-- (docs/free-tier.md, "Later: Siren's own DID").
CREATE TABLE public_questions (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  question_uri TEXT UNIQUE,
  question_cid TEXT,
  did TEXT,
  handle TEXT,
  city TEXT,
  question TEXT,
  answer TEXT,
  record TEXT,
  status TEXT NOT NULL CHECK (status IN ('answering', 'answered', 'withdrawn', 'hidden')),
  day TEXT NOT NULL,
  checked_ms INTEGER NOT NULL DEFAULT 0,
  root_uri TEXT,
  parent_uri TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  tools TEXT
);
-- The public list: answered roots, newest first.
CREATE INDEX public_questions_list ON public_questions (status, depth, seq);
-- Loading a thread: every question under one root.
CREATE INDEX public_questions_thread ON public_questions (root_uri, seq);
-- Rewriting the replies of a withdrawn question.
CREATE INDEX public_questions_parent ON public_questions (parent_uri);
-- The sweep: the questions checked longest ago.
CREATE INDEX public_questions_checked ON public_questions (checked_ms);
