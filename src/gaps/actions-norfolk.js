// What would close each Norfolk gap (docs/gaps.md §9). Action text comes only
// from this catalog PR and from case-file records_to_request, used verbatim.
// Siren drafts; people send, file, ask and claim. Siren never acts outward.
//
// Meeting questions ask about records or plans. The line-clearance question
// goes to the City only (J17 default). Records-request drafts carry no legal
// wording until verified `rules` findings for Va. Code § 2.2-3704 exist in a
// case file, compute no due dates, and name no recipient until one is
// verified with a date.

export const FOIA_LINES = Object.freeze({
  to: "[the City of Norfolk's FOIA officer: Siren has no verified contact for this yet]",
  leave_out: 'Please leave out the names and addresses of residents who made requests.',
  frame: (date) => `Siren drafted this from public records on ${date}. Siren doesn't send requests; you do.`,
});

export const ACTIONS = [
  { id: 'a-meeting-street', kind: 'meeting_question', text: 'Does the City plan to record a street on every Forestry work order?' },
  { id: 'a-proposal-street', kind: 'dataset_proposal', text: 'Record a street on every Forestry work order.' },
  {
    id: 'a-watch-street',
    kind: 'watch',
    text: 'A private watch on your own street, once Siren offers watches. Watches stay private to the person who sets them.',
    available: false,
  },
  { id: 'a-meeting-notice', kind: 'meeting_question', text: 'Does the City give residents notice before it removes a street tree, and where is that notice recorded?' },
  { id: 'a-meeting-planned', kind: 'meeting_question', text: 'Does the City keep a planned date for each street-tree removal, and can residents see it?' },
  { id: 'a-foia-planned', kind: 'foia_draft', needs: 'a records_to_request entry for planned removal dates, added to data/cases/norfolk-trees.json by case-file PR' },
  { id: 'a-foia-contracts', kind: 'foia_draft', from: { case: 'norfolk-trees', records_to_request: 0 } },
  { id: 'a-proposal-crew', kind: 'dataset_proposal', text: 'Mark on each work order whether a City crew or a contractor did the work.' },
  { id: 'a-foia-trees-per-order', kind: 'foia_draft', from: { case: 'norfolk-trees', records_to_request: 1 }, strikes: [{ phrase: 'priority', column: 'priority', dataset: 'qzfe-wj25' }] },
  { id: 'a-meeting-approver', kind: 'meeting_question', text: 'Which City office approves street-tree removals, and on what criteria?' },
  {
    id: 'a-foia-approver',
    kind: 'foia_draft',
    needs: 'a records_to_request entry for removal policy, criteria, the approving position and counts by request source with names left out, added to data/cases/norfolk-trees.json by case-file PR',
  },
  { id: 'a-meeting-reinventory', kind: 'meeting_question', text: 'Does the City plan a re-inventory of its street trees?' },
  { id: 'a-proposal-condition', kind: 'dataset_proposal', text: 'Add tree condition to the City Tree Inventory.' },
  { id: 'a-meeting-condition', kind: 'meeting_question', text: 'Does the City record the condition of its street trees, and where can residents read it?' },
  { id: 'a-proposal-size', kind: 'dataset_proposal', text: 'Fill the trunk size on every city tree record.' },
  {
    id: 'a-meeting-line',
    kind: 'meeting_question',
    text: 'Does the City keep a record of utility line-clearance tree work on City streets, and where can residents read it?',
    audience: 'City only',
  },
  {
    id: 'a-source-311',
    kind: 'source_request',
    aggregate_only: true,
    text: 'A reviewed plugin that counts MyNorfolk 311 tree requests citywide and by ward, from an exact list of request types, showing “fewer than 5” for small counts as docs/gaps.md I17 requires.',
  },
  { id: 'a-source-legislation', kind: 'source_request', text: 'List citywide agenda items beside block matches, so agenda items with no street address in their titles still show.' },
];

/** Strike a phrase (and the comma that joins it) from a records-request body. */
export function strike(text, phrase) {
  const p = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = text.replace(new RegExp(`(,\\s*)?\\b${p}\\b(\\s*,)?`), (m, a, b) => (a && b ? ',' : ''));
  if (out === text) throw new Error(`The phrase "${phrase}" is not in the records request.`);
  return out;
}

/** Words in action text that would ask for rows, a full table, or lifting a rule: refused on restricted gaps. */
export const ROW_LEVEL = /\b(?:row-level|each request|every request|full (?:csv|table|download|export)|full-table|raw data|addresses|lift(?:ing)? the rule|remove the restriction|individual requests?)\b/i;
