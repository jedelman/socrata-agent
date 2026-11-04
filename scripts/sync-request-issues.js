#!/usr/bin/env node
// Mirror the public source-request list to GitHub issues, one per request,
// labeled source-request. Run nightly by a Claude Code routine ("Siren:
// sync source requests to issues"), which runs --plan and applies the plan
// with its GitHub tools; or run it directly with a GITHUB_TOKEN.
//
// It reads only the public feed (steward-accepted requests, public notes), so
// nothing reaches GitHub that isn't already on the public page. Issues are
// matched by a hidden marker, created when missing, updated when the count or
// notes change, and closed as completed when a request is fulfilled.
//
//   REQUESTS_URL=https://jason-edelman.org/ask-siren/api/requests \
//   GITHUB_REPOSITORY=owner/repo node scripts/sync-request-issues.js --plan
//     prints the desired issues as JSON ([{id, marker, title, body, state}]),
//     needing no token; the caller matches existing issues by marker.
//   ... GITHUB_TOKEN=... node scripts/sync-request-issues.js [--dry-run]
//     applies them itself through the GitHub API.

const LABEL = 'source-request';
const marker = (id) => `<!-- source-request:${id} -->`;

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

/** The issues the public list should have, as plain data. */
export function plan(requests, pageUrl, repo) {
  return requests.map((r) => ({
    id: r.id,
    marker: marker(r.id),
    title: issueTitle(r),
    body: issueBody(r, pageUrl, repo),
    state: r.status === 'fulfilled' ? 'closed' : 'open',
    label: LABEL,
  }));
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const feedUrl = process.env.REQUESTS_URL;
  if (!feedUrl) throw new Error('Set REQUESTS_URL to the public /api/requests feed.');
  const pageUrl = feedUrl.replace(/api\/requests$/, 'requests');
  const { requests = [] } = await (await fetch(feedUrl)).json();
  if (process.argv.includes('--plan')) {
    console.log(JSON.stringify(plan(requests, pageUrl, process.env.GITHUB_REPOSITORY), null, 2));
    return;
  }
  if (!dry) await gh('/labels', { method: 'POST', body: { name: LABEL, color: '1d6b5c', description: 'A data source people asked the agent to learn' } });
  const existing = [];
  for (let page = 1; ; page++) {
    const batch = dry ? [] : await gh(`/issues?labels=${LABEL}&state=all&per_page=100&page=${page}`);
    existing.push(...batch);
    if (batch.length < 100) break;
  }
  for (const r of requests) {
    const issue = existing.find((i) => (i.body || '').includes(marker(r.id)));
    const body = issueBody(r, pageUrl);
    const title = issueTitle(r);
    if (!issue) {
      console.log(`create: ${title}`);
      if (!dry) await gh('/issues', { method: 'POST', body: { title, body, labels: [LABEL] } });
      continue;
    }
    const wantClosed = r.status === 'fulfilled';
    const patch = {};
    if (issue.body !== body) patch.body = body;
    if (issue.title !== title) patch.title = title;
    if (wantClosed && issue.state === 'open') Object.assign(patch, { state: 'closed', state_reason: 'completed' });
    if (!wantClosed && issue.state === 'closed') patch.state = 'open';
    if (Object.keys(patch).length) {
      console.log(`update #${issue.number}: ${Object.keys(patch).join(', ')}`);
      if (!dry) await gh(`/issues/${issue.number}`, { method: 'PATCH', body: patch });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
