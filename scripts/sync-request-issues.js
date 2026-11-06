#!/usr/bin/env node
// Mirror the public source-request list to GitHub issues, one per request,
// labeled source-request. Run nightly by a Claude Code routine ("Siren:
// sync source requests to issues"), which runs --plan and applies the plan
// with its GitHub tools; or run it directly with a GITHUB_TOKEN.
//
// It reads only the public feed (steward-accepted requests, approved public
// notes), so nothing reaches GitHub that isn't already on the public page.
// Issues are matched by a hidden marker, created when missing, updated when
// the count or notes change, and closed as completed when a request is
// fulfilled. A request the steward takes off the public list arrives in the
// feed's `withdrawn` list; its issue is closed, and its title and body are
// replaced with a fixed text, so the request's words leave the issue.
// Applying directly, the sync also closes, the same way, any source-request
// issue whose marker is in neither list (a request withdrawn before the feed
// listed withdrawals, or one deleted from storage). It does that only when
// the feed carries a `withdrawn` list, so a feed from an unconfigured site
// closes nothing. GitHub keeps earlier bodies in an issue's edit history;
// removing those is a step for the steward, by hand.
//
//   REQUESTS_URL=https://jason-edelman.org/ask-siren/api/requests \
//   GITHUB_REPOSITORY=owner/repo node scripts/sync-request-issues.js --plan
//     prints the desired issues as JSON ([{id, marker, title, body, state,
//     state_reason?, label}]), withdrawn ones included, needing no token; the
//     caller matches existing issues by marker.
//   ... GITHUB_TOKEN=... node scripts/sync-request-issues.js [--dry-run]
//     applies them itself through the GitHub API.

const LABEL = 'source-request';
const marker = (id) => `<!-- source-request:${id} -->`;
const MARKER = /<!-- source-request:([0-9a-f]{12}) -->/;
const ID = /^[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The fixed text a withdrawn request's issue is left with. Nothing from the request itself. */
export function withdrawnTitle(id) {
  return `Source request ${id} (withdrawn)`;
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

async function gh(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'socrata-agent request sync',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 422) throw new Error(`GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
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
    .map((w) => ({ id: w.id, marker: marker(w.id), title: withdrawnTitle(w.id), body: withdrawnBody(w.id, w.day), state: 'closed', state_reason: 'not_planned', label: LABEL }));
  return [...live, ...gone];
}

/**
 * What applying directly does to the existing labeled issues, as plain data:
 * [{op: 'create', title, body, labels}] and [{op: 'update', number, patch}].
 * `withdrawn` is the feed's list, or undefined when the feed has none; only a
 * list turns on closing issues whose marker is in neither list.
 */
export function operations({ existing, requests, withdrawn, pageUrl, repo }) {
  const issues = (existing || []).filter((i) => !i.pull_request);
  const ops = [];
  const patchTo = (issue, want) => {
    const patch = {};
    if (issue.body !== want.body) patch.body = want.body;
    if (issue.title !== want.title) patch.title = want.title;
    if (want.state === 'closed' && issue.state === 'open') Object.assign(patch, { state: 'closed', state_reason: want.state_reason || 'completed' });
    if (want.state === 'open' && issue.state === 'closed') patch.state = 'open';
    if (Object.keys(patch).length) ops.push({ op: 'update', number: issue.number, patch });
  };
  const wanted = plan(requests, pageUrl, repo, withdrawn || []);
  for (const want of wanted) {
    const issue = issues.find((i) => (i.body || '').includes(want.marker));
    if (issue) patchTo(issue, want);
    else if (want.state_reason !== 'not_planned') ops.push({ op: 'create', title: want.title, body: want.body, labels: [LABEL] });
  }
  if (Array.isArray(withdrawn)) {
    const known = new Set(wanted.map((w) => w.id));
    for (const issue of issues) {
      const m = (issue.body || '').match(MARKER);
      if (!m || known.has(m[1])) continue;
      patchTo(issue, { title: withdrawnTitle(m[1]), body: withdrawnBody(m[1]), state: 'closed', state_reason: 'not_planned' });
    }
  }
  return ops;
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const feedUrl = process.env.REQUESTS_URL;
  if (!feedUrl) throw new Error('Set REQUESTS_URL to the public /api/requests feed.');
  const pageUrl = feedUrl.replace(/api\/requests$/, 'requests');
  const res = await fetch(feedUrl);
  if (!res.ok) throw new Error(`The feed answered ${res.status}; nothing was synced.`);
  const feed = await res.json();
  if (!Array.isArray(feed?.requests)) throw new Error('The feed has no requests list; nothing was synced.');
  const repo = process.env.GITHUB_REPOSITORY;
  if (process.argv.includes('--plan')) {
    console.log(JSON.stringify(plan(feed.requests, pageUrl, repo, Array.isArray(feed.withdrawn) ? feed.withdrawn : []), null, 2));
    return;
  }
  if (!dry) await gh('/labels', { method: 'POST', body: { name: LABEL, color: '1d6b5c', description: 'A data source people asked the agent to learn' } });
  const existing = [];
  for (let page = 1; ; page++) {
    const batch = dry ? [] : await gh(`/issues?labels=${LABEL}&state=all&per_page=100&page=${page}`);
    existing.push(...batch);
    if (batch.length < 100) break;
  }
  for (const o of operations({ existing, requests: feed.requests, withdrawn: Array.isArray(feed.withdrawn) ? feed.withdrawn : undefined, pageUrl, repo })) {
    if (o.op === 'create') {
      console.log(`create: ${o.title}`);
      if (!dry) await gh('/issues', { method: 'POST', body: { title: o.title, body: o.body, labels: o.labels } });
    } else {
      console.log(`update #${o.number}: ${Object.keys(o.patch).join(', ')}`);
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
