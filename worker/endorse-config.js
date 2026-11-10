// The one place the endorsement record's NSID lives, with everything built
// from it: the OAuth scope, the Constellation source, the subject URL and the
// record itself. Shared by the Worker and the browser (served as module text
// by index.js), and pure: no network, no globals beyond Intl.
//
// The NSID is settled (Jason, 2026-11-09) until a domain for Cairn is chosen;
// moving it is the documented migration in docs/bluesky-endorsements.md,
// "Moving the NSID". test/endorse-config.test.js fails if the string appears
// in any other source file.
//
// The free tier's question record (docs/free-tier.md) lives here too, under
// the same rule: QUESTION_NSID appears in no other source file.

export const ENDORSE_NSID = 'org.jason-edelman.siren.endorsement';
export const QUESTION_NSID = 'org.jason-edelman.siren.question';

/** The one repo permission Siren asks for: create and delete these records, nothing else. */
export const ENDORSE_SCOPE = `repo:${ENDORSE_NSID}?action=create&action=delete`;
/**
 * The OAuth scope requested and declared in the client metadata. No
 * transition:generic fallback for servers that won't grant the repo scope
 * (D3, default, pending Jason): they get a clear message instead.
 */
export const OAUTH_SCOPE = `atproto ${ENDORSE_SCOPE}`;
/** Constellation's source for these links: the collection and the JSON path of the subject URL. */
export const ENDORSE_SOURCE = `${ENDORSE_NSID}:subject.uri`;

/** A random public request id (worker/requests.js PUBLIC_ID_RE); also the record key. */
export const ENDORSE_ID_RE = /^[a-z2-7]{16}$/;

/** Bluesky's moderation labeler (app.bsky.labeler.getServices, checked 2026-11-09). */
export const BLUESKY_MODERATION_DID = 'did:plc:ar7c4by46qjdydhdevvrndac';
/**
 * The moderation label values that flag an endorser (D13, default, pending
 * Jason): spam, inauthentic, engagement-farming, impersonation, scam.
 */
export const MODERATION_FLAGS = Object.freeze(['spam', 'inauthentic', 'engagement-farming', 'impersonation', 'scam']);

const ORIGIN_RE = /^(https:\/\/[a-z0-9.-]+|http:\/\/127\.0\.0\.1:[0-9]{1,5})$/;
const BASE_RE = /^(\/[a-z0-9._~-]+)*$/;

/**
 * The canonical subject URL for a request: `${origin}${base}/requests/${id}`,
 * lowercase, no trailing slash, query or fragment. Built here and nowhere
 * else, because Constellation matches it exactly (a trailing slash is a
 * different target). `origin` is PUBLIC_ORIGIN, never the Host header.
 * -> the URL, or null for anything off that shape.
 */
export function endorseSubject(origin, base, id) {
  if (typeof origin !== 'string' || !ORIGIN_RE.test(origin)) return null;
  if (typeof base !== 'string' || !BASE_RE.test(base)) return null;
  if (typeof id !== 'string' || !ENDORSE_ID_RE.test(id)) return null;
  return `${origin}${base}/requests/${id}`;
}

const graphemes = (s) => {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].map((x) => x.segment);
  return [...s];
};

/** A string cut to `maxGraphemes` graphemes and `maxLength` UTF-16 units, whole graphemes only. */
export function capText(s, maxGraphemes, maxLength = Infinity) {
  let out = '';
  let n = 0;
  for (const g of graphemes(String(s ?? ''))) {
    if (n >= maxGraphemes || out.length + g.length > maxLength) break;
    out += g;
    n++;
  }
  return out;
}

// RFC 3339 with a time zone, as atproto's datetime format requires.
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** The record Siren writes: {$type, subject: {uri, id, title?}, createdAt}. */
export function buildEndorsement({ subject, id, title, now = Date.now() }) {
  const t = typeof title === 'string' ? capText(title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim(), 200, 300) : '';
  return {
    $type: ENDORSE_NSID,
    subject: { uri: subject, id, ...(t ? { title: t } : {}) },
    createdAt: new Date(now).toISOString(),
  };
}

/** Whether a value is a valid endorsement record under the Lexicon (lexicons/…/endorsement.json). */
export function validEndorsement(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false;
  if (rec.$type !== undefined && rec.$type !== ENDORSE_NSID) return false;
  if (typeof rec.createdAt !== 'string' || !DATETIME_RE.test(rec.createdAt) || !Number.isFinite(Date.parse(rec.createdAt))) return false;
  const s = rec.subject;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  if (typeof s.uri !== 'string' || s.uri.length > 512 || !/^[a-z][a-z0-9+.-]*:\S+$/i.test(s.uri)) return false;
  if (typeof s.id !== 'string' || s.id.length > 64) return false;
  if (s.title !== undefined && (typeof s.title !== 'string' || s.title.length > 300 || graphemes(s.title).length > 200)) return false;
  return true;
}

/** Whether a record is an endorsement of exactly this subject URL. */
export const endorses = (rec, subject) => validEndorsement(rec) && rec.subject.uri === subject;

// ---- The free tier's question record (docs/free-tier.md) ----------------

/** The repo permission the ask client needs: create and delete these records, nothing else. */
export const QUESTION_SCOPE = `repo:${QUESTION_NSID}?action=create&action=delete`;
/** What a fresh sign-in on the public questions page asks for. */
export const ASK_SCOPE = `atproto ${QUESTION_SCOPE}`;
/**
 * What the ask client declares in its metadata: the question permission,
 * and the endorsement one, which it asks for too only when the browser's
 * live session for the same account already holds it (so signing in to ask
 * doesn't take endorsing away). Never transition:generic.
 */
export const ASK_CLIENT_SCOPE = `atproto ${QUESTION_SCOPE} ${ENDORSE_SCOPE}`;
/** The chat's limit on a question (worker/index.js MAX_QUESTION), in UTF-16 units. */
export const MAX_QUESTION_TEXT = 600;
/** A city id as worker/index.js serves them ('norfolk'). */
export const CITY_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** A record key Siren's page writes: a TID (atproto.com/specs/tid), 13 characters. */
export const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

/** A CID as a strongRef carries it (base32, lowercase). */
export const CID_RE = /^[a-z0-9]{8,128}$/;
const STRONG_REF = 'com.atproto.repo.strongRef';
const strongRef = (r) => ({ uri: r.uri, cid: r.cid });

/**
 * The record the ask page writes: {$type, text, city, createdAt}, and for a
 * follow-up `reply: {root, parent}`, each a strongRef ({uri, cid}) to an
 * earlier question record, as app.bsky.feed.post replies are.
 */
export function buildQuestion({ text, city, now = Date.now(), reply = null }) {
  return {
    $type: QUESTION_NSID, text: String(text ?? '').trim(), city, createdAt: new Date(now).toISOString(),
    ...(reply ? { reply: { root: strongRef(reply.root), parent: strongRef(reply.parent) } } : {}),
  };
}

const plainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
/** A strongRef to a question record: {uri, cid} (and its $type, optionally), nothing else. */
function validStrongRef(r) {
  if (!plainObject(r)) return false;
  const keys = Object.keys(r).filter((k) => k !== '$type').sort();
  if (keys.join(',') !== 'cid,uri' || (r.$type !== undefined && r.$type !== STRONG_REF)) return false;
  const p = parseRecordUri(r.uri);
  return Boolean(p && p.collection === QUESTION_NSID && TID_RE.test(p.rkey)) && typeof r.cid === 'string' && CID_RE.test(r.cid);
}

/**
 * Whether a value is a question record exactly as the Lexicon
 * (lexicons/…/question.json) and the chat's input checks allow: these four
 * fields (and `reply`, for a follow-up) and no others, $type this NSID, text
 * 1 to 600 characters once trimmed, a city id, an RFC 3339 createdAt, and a
 * reply of two strongRefs to question records.
 */
export function validQuestion(rec) {
  if (!plainObject(rec)) return false;
  const keys = Object.keys(rec).filter((k) => k !== 'reply').sort();
  if (keys.join(',') !== '$type,city,createdAt,text') return false;
  if ('reply' in rec) {
    const r = rec.reply;
    if (!plainObject(r) || Object.keys(r).filter((k) => k !== '$type').sort().join(',') !== 'parent,root') return false;
    if (r.$type !== undefined && r.$type !== `${QUESTION_NSID}#replyRef`) return false;
    if (!validStrongRef(r.root) || !validStrongRef(r.parent)) return false;
  }
  if (rec.$type !== QUESTION_NSID) return false;
  if (typeof rec.text !== 'string' || rec.text.length > MAX_QUESTION_TEXT || !rec.text.trim()) return false;
  if (typeof rec.city !== 'string' || !CITY_ID_RE.test(rec.city)) return false;
  return typeof rec.createdAt === 'string' && DATETIME_RE.test(rec.createdAt) && Number.isFinite(Date.parse(rec.createdAt));
}

/**
 * An AT-URI of a question record: at://<did>/<QUESTION_NSID>/<tid>.
 * -> { did, collection, rkey } for any at://<did>/<collection>/<rkey> shape
 * (the caller checks the collection and the DID), or null.
 */
export function parseRecordUri(uri) {
  if (typeof uri !== 'string' || uri.length > 512) return null;
  const m = /^at:\/\/(did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-])\/([a-zA-Z][a-zA-Z0-9.-]{2,316})\/([A-Za-z0-9._:~-]{1,512})$/.exec(uri);
  return m ? { did: m[1], collection: m[2], rkey: m[3] } : null;
}

/**
 * The day a record says it was made, 'YYYY-MM-DD', or null: an RFC 3339
 * datetime, not more than five minutes in the future. Record text is never
 * shown; this day is the only field of a record Siren displays.
 */
export function endorsedDay(rec, now = Date.now()) {
  const at = rec?.createdAt;
  if (typeof at !== 'string' || !DATETIME_RE.test(at)) return null;
  const t = Date.parse(at);
  if (!Number.isFinite(t) || t > now + 5 * 60e3) return null;
  return new Date(t).toISOString().slice(0, 10);
}
