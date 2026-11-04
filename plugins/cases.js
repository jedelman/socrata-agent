// Case files: research done once, checked against its sources, and served to
// every question. Each file in data/cases/ holds findings with a source URL
// and an exact quote; scripts/verify-cases.js re-fetches every source and
// fails if a quote is missing. A plugin attaches a case to its answer with
// `theRecord`, which also puts every source in the trace and the hand-off.

const REPO = 'https://github.com/jedelman/socrata-agent/blob/main';

export function theRecord(ctx, doc) {
  const sources = new Map();
  const shape = (f) => {
    sources.set(f.source.url, f.source.title);
    return { claim: f.claim, source: f.source.title, url: f.source.url, found_by: f.found_by, ...(f.checked ? { checked: f.checked } : {}) };
  };
  const verified = doc.findings.filter((f) => !f.unverified && f.checked);
  const by = (stance) => verified.filter((f) => f.stance === stance).map(shape);
  const byId = Object.fromEntries(doc.findings.map((f) => [f.id, f]));
  ctx.cite({
    tool: `read the verified case file: ${doc.title}`,
    url: `${REPO}/data/cases/${doc.id}.json`,
    rows: doc.findings.length,
    note: `${verified.length} findings with their quotes checked against the source; ${doc.findings.length - verified.length} marked unverified`,
  });
  const record = {
    question: doc.title,
    steward: doc.steward,
    summary: doc.summary,
    confirms: by('confirms'),
    weakens: by('weakens'),
    context: by('context'),
    who_decides: by('who_decides'),
    not_yet_verified: doc.findings.filter((f) => f.unverified || !f.checked).map((f) => f.claim),
    what_would_help: doc.what_would_help.map((h) => ({ text: h.text, ...(byId[h.finding] ? { based_on: byId[h.finding].source.title } : {}) })),
    records_to_request: doc.records_to_request,
    how_to_use:
      'Each finding was checked against its source on the date shown, and names who found it. Name the source when you use a finding. Give what weakens the case alongside what confirms it. Say "not yet verified" for anything in not_yet_verified. The records to request are drafts for the person to send under the Virginia FOIA; Siren never sends them.',
  };
  for (const [url, title] of sources) ctx.resources.addRecord({ title, url, kind: 'source' });
  return record;
}
