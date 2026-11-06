#!/usr/bin/env node
// Mirror the public source-request list to GitHub issues, one per request,
// labeled source-request. Run nightly by a Claude Code routine ("Siren:
// sync source requests to issues"), which runs --plan and applies the plan
// with its GitHub tools; or run it directly with a GITHUB_TOKEN. The
// routine's prompt is kept in docs/request-sync-routine.md.
//
// It reads only the public feed (steward-accepted requests, approved public
// notes), so nothing reaches GitHub that isn't already on the public page.
// Issues are matched by a hidden marker, created when missing, updated when
// the count or notes change, and closed as completed when a request is
// fulfilled. A request the steward takes off the public list arrives in the
// feed's `withdrawn` list; its issue is closed as not planned, and its
// current title and body are replaced with a fixed text that carries nothing
// from the request. A withdrawn request that never had an issue gets none.
//
// That does not erase the request's words from GitHub. A title change is a
// public event in the issue's timeline ("changed the title ~~old~~ new"),
// which no API removes, and earlier bodies stay in the issue's edit history
// (a note the steward deleted after approving it included). Only deleting
// the issue removes them; that is a manual step for a repo admin, and this
// script never deletes anything. For text that names a person or a home,
// the steward deletes the issue by hand.
//
// Applying directly, the sync also closes, the same way, any source-request
// issue whose marker is in neither list (a request withdrawn before the feed
// listed withdrawals, or one deleted from storage). It does that only when
// the feed carries a `withdrawn` list, so a feed from an unconfigured site
// closes nothing, and it refuses to close every issue (or more than
// UNLISTED_LIMIT) that way without --close-unlisted, so a feed from the
// wrong or an empty namespace can't blank the mirror. Plan mode leaves
// unlisted issues alone.
//
//   REQUESTS_URL=https://jason-edelman.org/ask-siren/api/requests \
//   GITHUB_REPOSITORY=owner/repo node scripts/sync-request-issues.js --plan [--with-withdrawn]
//     prints the desired issues as JSON ([{id, marker, title, body, state,
//     state_reason?, create_if_missing?, label}]), needing no token. The
//     caller matches existing issues by marker. Plain --plan keeps its first
//     contract: every entry may be created when missing, and closed ones are
//     fulfilled requests. Withdrawn entries appear only with
//     --with-withdrawn, which only a caller that honors two more fields may
//     pass: an entry with create_if_missing: false is never created (it only
//     updates an issue that exists), and a closed entry is closed with its
//     state_reason (completed or not_planned), including an issue already
//     closed with another reason.
//   ... GITHUB_TOKEN=... node scripts/sync-request-issues.js [--dry-run] [--close-unlisted]
//     applies them itself through the GitHub API. --dry-run prints the
//     operations and writes nothing; with a token it lists the existing
//     issues (a read) so it shows closes and refusals too.

const LABEL = 'source-request';
const marker = (id) => `<!-- source-request:${id} -->`;
const MARKER = /<!-- source-request:([0-9a-f]{12}) -->/;
const ID = /^[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The fixed text a withdrawn request's issue is left with. Nothing from the
 * request itself; the title leaves out the id too (the marker in the body is
 * enough to match), since the id can confirm a guessed source.
 */
export function withdrawnTitle() {
  return 'Source request (withdrawn)';
}
export function withdrawnBody(id, day) {
  return [marker(id), DAY.test(String(day || '')) ? `Removed from the public request list by a steward on ${day}.` : 'Removed from the public request list.'].join('\n');
}

/**
 * Text people typed, made safe for an issue body: markdown and HTML are shown
 * literally, and @mentions can't ping anyone.
 */
export function mdText(s) {
  return String(s ?? '')
    .replace(/[\\`*_{}[\]()<>#+\-.!|~]/g, (c) => `\\${c}`)
    .replace(/@/g, '@​')
    .replace(/\s+/g, ' ')
    .trim();
}

export function issueTitle(r) {
  return `Source request: ${String(r.source).replace(/@/g, '@​').slice(0, 200)}`;
}

export function issueBody(r, pageUrl, repo = process.env.GITHUB_REPOSITORY) {
  const lines = [
    marker(r.id),
    `**Source:** ${mdText(r.source)}`,
    ...(r.url ? [`**Link given:** ${mdText(r.url)} (not checked; confirm it before relying on it)`] : []),
    `**Asked for by:** ${r.count} ${r.count === 1 ? 'person' : 'people'} through ${pageUrl ? `[the request list](${pageUrl})` : 'the request list'} · id \`${r.id}\``,
    '',
  ];
  if (r.steward_note) lines.push(`**Steward:** ${mdText(r.steward_note)}`, '');
  if (r.notes?.length) {
    lines.push('**What people wanted to know:**');
    for (const n of r.notes) lines.push(`> ${mdText(n)}`, '>');
    lines.pop();
    lines.push('');
  }
  lines.push(
    `To fulfill this, follow [docs/fulfilling-requests.md](https://github.com/${repo}/blob/main/docs/fulfilling-requests.md): a pull request that teaches the agent this source, with every finding quoted from it and every check passing. Mention this issue in the PR.`,
    '',
    '_This issue is kept in sync with the public request list; edits here are overwritten._'
  );
  return lines.join('\n');
}

function github(env, fetchImpl) {
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'socrata-agent request sync',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && res.status !== 422) throw new Error(`GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  };
}

/** The issues the public list should have, as plain data. Withdrawn requests come last, closed with the fixed text. */
export function plan(requests, pageUrl, repo, withdrawn = []) {
  const live = requests.map((r) => ({
    id: r.id,
    marker: marker(r.id),
    title: issueTitle(r),
    body: issueBody(r, pageUrl, repo),
    state: r.status === 'fulfilled' ? 'closed' : 'open',
    ...(r.status === 'fulfilled' ? { state_reason: 'completed' } : {}),
    label: LABEL,
  }));
  const listed = new Set(requests.map((r) => r.id));
  const gone = (withdrawn || [])
    .filter((w) => ID.test(String(w?.id || '')) && !listed.has(w.id))
    .map((w) => ({ id: w.id, marker: marker(w.id), title: withdrawnTitle(), body: withdrawnBody(w.id, w.day), state: 'closed', state_reason: 'not_planned', create_if_missing: false, label: LABEL }));
  return [...live, ...gone];
}

export const UNLISTED_LIMIT = 3;

/**
 * What applying directly does to the existing labeled issues, as plain data:
 * [{op: 'create', title, body, labels}] and [{op: 'update', number, patch}].
 * `withdrawn` is the feed's list, or undefined when the feed has none; only a
 * list turns on closing issues whose marker is in neither list. Rewriting
 * every marked issue that way, or more than UNLISTED_LIMIT, throws unless
 * closeUnlisted is set.
 */
export function operations({ existing, requests, withdrawn, pageUrl, repo, closeUnlisted = false }) {
  const issues = (existing || []).filter((i) => !i.pull_request);
  const ops = [];
  const patchTo = (issue, want) => {
    const patch = {};
    if (issue.body !== want.body) patch.body = want.body;
    if (issue.title !== want.title) patch.title = want.title;
    const reason = want.state_reason || 'completed';
    // An issue already closed with another reason (fulfilled, then withdrawn) is re-closed with this one.
    if (want.state === 'closed' && (issue.state === 'open' || (issue.state_reason && issue.state_reason !== reason))) Object.assign(patch, { state: 'closed', state_reason: reason });
    if (want.state === 'open' && issue.state === 'closed') patch.state = 'open';
    if (Object.keys(patch).length) ops.push({ op: 'update', number: issue.number, patch });
  };
  const wanted = plan(requests, pageUrl, repo, withdrawn || []);
  for (const want of wanted) {
    const issue = issues.find((i) => (i.body || '').includes(want.marker));
    if (issue) patchTo(issue, want);
    else if (want.create_if_missing !== false) ops.push({ op: 'create', title: want.title, body: want.body, labels: [LABEL] });
  }
  if (Array.isArray(withdrawn)) {
    const known = new Set(wanted.map((w) => w.id));
    const marked = issues.filter((i) => MARKER.test(i.body || ''));
    const before = ops.length;
    for (const issue of marked) {
      const id = issue.body.match(MARKER)[1];
      if (!known.has(id)) patchTo(issue, { title: withdrawnTitle(), body: withdrawnBody(id), state: 'closed', state_reason: 'not_planned' });
    }
    // Issues this pass would rewrite: refuse if that is all of them, or many.
    const changing = ops.length - before;
    if (!closeUnlisted && changing > 0 && (changing > UNLISTED_LIMIT || changing === marked.length)) {
      throw new Error(`Refusing to close ${changing} of ${marked.length} source-request issues that the feed doesn't list; check REQUESTS_URL, or rerun with --close-unlisted.`);
    }
  }
  return ops;
}

/** The command line, with its world passed in so tests can stub it. */
export async function main({ argv = process.argv.slice(2), env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const dry = argv.includes('--dry-run');
  const feedUrl = env.REQUESTS_URL;
  if (!feedUrl) throw new Error('Set REQUESTS_URL to the public /api/requests feed.');
  const pageUrl = feedUrl.replace(/api\/requests$/, 'requests');
  const res = await fetchImpl(feedUrl);
  if (!res.ok) throw new Error(`The feed answered ${res.status}; nothing was synced.`);
  const feed = await res.json();
  if (!Array.isArray(feed?.requests)) throw new Error('The feed has no requests list; nothing was synced.');
  const repo = env.GITHUB_REPOSITORY;
  const withdrawn = Array.isArray(feed.withdrawn) ? feed.withdrawn : undefined;
  if (argv.includes('--plan')) {
    // Withdrawn entries only for a caller that says it honors create_if_missing and state_reason.
    log(JSON.stringify(plan(feed.requests, pageUrl, repo, argv.includes('--with-withdrawn') ? withdrawn || [] : []), null, 2));
    return;
  }
  const gh = github(env, fetchImpl);
  const existing = [];
  // A dry run lists issues when it has a token (a read), so it previews closes and refusals.
  const list = !dry || Boolean(env.GITHUB_TOKEN);
  for (let page = 1; ; page++) {
    const batch = list ? await gh(`/issues?labels=${LABEL}&state=all&per_page=100&page=${page}`) : [];
    existing.push(...batch);
    if (batch.length < 100) break;
  }
  // Worked out before anything is written, so a refusal changes nothing.
  const ops = operations({ existing, requests: feed.requests, withdrawn, pageUrl, repo, closeUnlisted: argv.includes('--close-unlisted') });
  if (!dry) await gh('/labels', { method: 'POST', body: { name: LABEL, color: '1d6b5c', description: 'A data source people asked the agent to learn' } });
  for (const o of ops) {
    if (o.op === 'create') {
      log(`create: ${o.title}`);
      if (!dry) await gh('/issues', { method: 'POST', body: { title: o.title, body: o.body, labels: o.labels } });
    } else {
      log(`update #${o.number}: ${Object.keys(o.patch).join(', ')}`);
      if (!dry) await gh(`/issues/${o.number}`, { method: 'PATCH', body: o.patch });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
