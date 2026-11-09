# The request-sync routine

The public source-request list is mirrored to GitHub issues by a nightly
Claude Code routine, "Siren: sync source requests to issues" (01:57
America/New_York). It runs `scripts/sync-request-issues.js --plan` against
the live feed and applies the plan with its GitHub tools. The routine's prompt
lives in the routine, not here, so this file keeps the text it should hold:
change both together. As of 2026-11-07 the stored prompt is still the earlier
one (plain `--plan`, and the old steps 2 and 4); see the merge step below.

## Two plan contracts

- `--plan` (the contract the routine was written for, 2026-11-04): every
  entry may be created when no issue carries its marker, and a closed entry is
  a fulfilled request, closed as completed. Withdrawn requests are left out.
- `--plan --with-withdrawn`: adds withdrawn requests, as entries with
  `create_if_missing: false` and `state_reason: "not_planned"`. A caller that
  passes this flag must never create such an entry, and must close each closed
  entry with its `state_reason`, including an issue already closed with
  another reason.

The routine keeps working unchanged on plain `--plan`; withdrawn requests'
issues then stay as they were until the routine is updated, or until someone
runs the script directly with a token (which honors both fields and also
closes issues the feed no longer lists). The admin page and
`docs/fulfilling-requests.md` are worded for that: a withdrawn request's
issue is closed "once the nightly sync runs with `--with-withdrawn`", and by
hand until then.

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

Merging this change does not update the routine. Its prompt is stored in the
routine, and only Jason can approve a change to it; nothing in this repo or
in a session changes it on its own. Until the stored prompt says what follows,
the routine must keep running plain `--plan`, and a withdrawn request's issue
stays open until a steward closes it by hand.

When merging the change that added `--with-withdrawn` (or soon after):

1. Read the stored prompt of "Siren: sync source requests to issues"
   (`get_trigger`) and check it still matches the copy below apart from steps
   2 and 4. If it has drifted, carry the two new steps into it instead.
2. Replace the whole prompt with the text below (`update_trigger`, with
   Jason's approval).
3. After the next run (01:57 America/New_York), check its report: withdrawn
   requests' issues closed as not planned, nothing created for them.

The replacement prompt, exactly (steps 2 and 4 are the only changes; step 2
also says the notes are steward-approved now):

```text
Nightly job for Jason Edelman's civic agent Siren: mirror Siren's public source-request list to GitHub issues in jedelman/socrata-agent. You only sync issues; you change no code and no other issues.

1. Get the repo. If jedelman/socrata-agent isn't in this session, add it with the add_repo tool (owner jedelman, repo socrata-agent, access "push", which is needed for the GitHub issue tools). Clone it and check out main. If you have no GitHub tools for listing, creating and updating issues, stop and report that; change nothing.

2. Build the plan from the public feed (no token needed):
   REQUESTS_URL=https://jason-edelman.org/ask-siren/api/requests GITHUB_REPOSITORY=jedelman/socrata-agent node scripts/sync-request-issues.js --plan --with-withdrawn > /tmp/plan.json
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
routine has that long to close its issue. One withdrawn longer ago than that
before the routine is updated is never closed by the routine (plan mode
leaves unlisted issues alone); close it by hand, or run the script directly
with a token, which closes marked issues the feed no longer lists.
