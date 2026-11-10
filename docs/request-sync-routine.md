# The request-sync routine

The public source-request list is mirrored to GitHub issues by a nightly
Claude Code routine, "Siren: sync source requests to issues" (01:57
America/New_York). It runs `scripts/sync-request-issues.js --plan
--with-withdrawn` against the live feed and applies the plan with its GitHub
tools. The routine's prompt
lives in the routine, not here, so this file keeps the text it holds: change
both together. On 2026-11-09 Jason updated the stored prompt to the
`--plan --with-withdrawn` text below; see the merge step.

## Two plan contracts

- `--plan` (the contract the routine was written for on 2026-11-04 and ran
  until 2026-11-09): every entry may be created when no issue carries its
  marker, and a closed entry is a fulfilled request, closed as completed.
  Withdrawn requests are left out.
- `--plan --with-withdrawn` (the routine's contract since 2026-11-09): adds
  withdrawn requests, as entries with `create_if_missing: false` and
  `state_reason: "not_planned"`. A caller that passes this flag must never
  create such an entry, and must close each closed entry with its
  `state_reason`, including an issue already closed with another reason.

Since 2026-11-09 the routine runs `--plan --with-withdrawn`, so the nightly
sync closes a withdrawn request's issue as not planned while the request is
in the feed (30 days, `WITHDRAWN_DAYS`). Running the script directly with a
token honors both fields too, and also closes issues the feed no longer
lists. The admin page and `docs/fulfilling-requests.md` say so, and say which
issues still need closing by hand (the end of this file).

## Siren's new address (2026-11-10): update the stored prompt after the deploy

Siren moved to its own origin, `https://ask-siren.jason-edelman.org`, so the
feed is now `https://ask-siren.jason-edelman.org/api/requests`. The copy of
the prompt below already reads it (step 2's `REQUESTS_URL`; nothing else in
the prompt changes). The stored prompt still reads
`https://jason-edelman.org/ask-siren/api/requests`, and only Jason can change
it (the merge step below). Update it after the deploy that ships the move,
once the new feed answers.

A second scheduled task, "Siren: fulfill a source request", also fetches the
feed by its old URL; its stored prompt needs the same change after the
deploy. Its prompt isn't copied in this repo.

Until then the old URL keeps working through the redirect: the old address
answers 301 to the same path on the new origin, which the script's fetch
follows. Issue bodies link the new page either way, because the script takes
the page link from the URL it finally read the feed from. So the first run
after the deploy updates every source-request issue's body once, to the new
`[the request list](https://ask-siren.jason-edelman.org/requests)` link.

## Random request ids (2026-11-09)

Request ids are random now (16 base32 characters), not the first 12 hex of a
hash of the source text, which anyone could recompute from a guessed source.
New requests get one when first raised; older ones get one when the steward
runs `node scripts/invites.js request-ids --apply` (a dry run without
`--apply`). The routine's prompt needs no change for this. A migrated request
that had been public keeps its old id as `formerly` in the feed, and its plan
entry's marker carries that old id, so the routine matches the issue it
already has and updates its body to show the new id; it never opens a second
issue. A request first raised after the change is marked with its random id.
A never-public request's old id is dropped, so it never reaches GitHub.

## Merge step: update the routine (Jason only)

Done on 2026-11-09 for `--with-withdrawn`: Jason replaced the routine's
stored prompt with that text. Pending since 2026-11-10: step 2's new
`REQUESTS_URL`, after the deploy (above). Merging a change to the routine's
prompt never updates the routine by itself. Its prompt is stored in the routine, and only Jason can approve a
change to it; nothing in this repo or in a session changes it on its own.

The steps, as done for `--with-withdrawn`, for the next such change:

1. Read the stored prompt of "Siren: sync source requests to issues"
   (`get_trigger`) and check it still matches the copy below apart from the
   steps that change. If it has drifted, carry the new steps into it instead.
2. Replace the whole prompt with the new text (`update_trigger`, with
   Jason's approval).
3. After the next run (01:57 America/New_York), check its report. For
   `--with-withdrawn`: withdrawn requests' issues closed as not planned,
   nothing created for them. For the new address: the plan read from
   `https://ask-siren.jason-edelman.org/api/requests`, and nothing but
   issue bodies updated, if the run before it hadn't already updated them
   through the redirect.

The prompt, exactly as it should be stored (steps 2 and 4 changed on
2026-11-09, and step 2 also says the notes are steward-approved now; on
2026-11-10 step 2's `REQUESTS_URL` moved to Siren's new address, which the
stored prompt needs once the move is deployed, as above):

```text
Nightly job for Jason Edelman's civic agent Siren: mirror Siren's public source-request list to GitHub issues in jedelman/socrata-agent. You only sync issues; you change no code and no other issues.

1. Get the repo. If jedelman/socrata-agent isn't in this session, add it with the add_repo tool (owner jedelman, repo socrata-agent, access "push", which is needed for the GitHub issue tools). Clone it and check out main. If you have no GitHub tools for listing, creating and updating issues, stop and report that; change nothing.

2. Build the plan from the public feed (no token needed):
   REQUESTS_URL=https://ask-siren.jason-edelman.org/api/requests GITHUB_REPOSITORY=jedelman/socrata-agent node scripts/sync-request-issues.js --plan --with-withdrawn > /tmp/plan.json
   Each entry has id, marker (an HTML comment like <!-- source-request:abc123def456 -->), title, body, state ("open" or "closed") and label ("source-request"), and may have state_reason ("completed" or "not_planned") and create_if_missing (false). The feed holds only requests the steward accepted, notes the steward approved, and the ids of requests the steward withdrew. If the feed fails or the script errors, stop and report the error; change nothing.

3. List every issue in jedelman/socrata-agent with the label source-request, open and closed, using the GitHub tools. Match an issue to a plan entry only when the issue body contains that entry's marker.

4. For each plan entry:
   - no matching issue: if the entry has create_if_missing: false, do nothing (never create it); otherwise create one with exactly the plan's title and body and the label source-request;
   - matching issue whose title or body differs: update it to exactly the plan's title and body;
   - plan state "closed": if the issue is open, close it with the entry's state_reason ("completed" when it has none); if the issue is closed with a different reason, close it again with the entry's state_reason;
   - plan state "open" and the issue is closed: reopen it.
   Use the plan's text verbatim. It is already escaped so it can't ping anyone or inject links; don't add, reword or remove anything, and never write an @mention.

5. Don't touch issues without a matching marker, don't comment on any issue, don't delete anything, and don't change code, branches, the Worker or any secret.

6. Finish with a short report: issues created, updated, closed and reopened (title and number for each), and any errors. If nothing changed, say so in one line.
```

A withdrawn request stays in the feed for 30 days (`WITHDRAWN_DAYS`), so the
routine has that long to close its issue. A request withdrawn more than 30
days before the update of 2026-11-09 had left the feed before the routine
began closing issues, so the routine never closes its issue (plan mode
leaves unlisted issues alone); close it by hand, or run the script directly
with a token, which closes marked issues the feed no longer lists.
