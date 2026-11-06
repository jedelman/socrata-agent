# The request-sync routine

The public source-request list is mirrored to GitHub issues by a nightly
Claude Code routine, "Siren: sync source requests to issues" (01:57
America/New_York). It runs `scripts/sync-request-issues.js --plan` against
the live feed and applies the plan with its GitHub tools. The routine's prompt
lives in the routine, not here, so this file keeps a copy: change both
together.

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
closes issues the feed no longer lists).

## Updating the routine (a manual step)

Steps 2 and 4 of the prompt change; the rest stays. Read the stored prompt
first (`get_trigger`) and replace those two steps with:

> 2. Build the plan from the public feed (no token needed):
>    REQUESTS_URL=https://jason-edelman.org/ask-siren/api/requests GITHUB_REPOSITORY=jedelman/socrata-agent node scripts/sync-request-issues.js --plan --with-withdrawn > /tmp/plan.json
>    Each entry has id, marker (an HTML comment like <!-- source-request:abc123def456 -->), title, body, state ("open" or "closed") and label ("source-request"), and may have state_reason ("completed" or "not_planned") and create_if_missing (false). The feed holds only requests the steward accepted, notes the steward approved, and the ids of requests the steward withdrew. If the feed fails or the script errors, stop and report the error; change nothing.
>
> 4. For each plan entry:
>    - no matching issue: if the entry has create_if_missing: false, do nothing (never create it); otherwise create one with exactly the plan's title and body and the label source-request;
>    - matching issue whose title or body differs: update it to exactly the plan's title and body;
>    - plan state "closed": if the issue is open, close it with the entry's state_reason ("completed" when it has none); if the issue is closed with a different reason, close it again with the entry's state_reason;
>    - plan state "open" and the issue is closed: reopen it.
>    Use the plan's text verbatim. It is already escaped so it can't ping anyone or inject links; don't add, reword or remove anything, and never write an @mention.

Until the routine's prompt says this, it must keep running plain `--plan`.

Until then, two promises lean on this update: the admin page's "closes its
GitHub issue at the next sync" and the same line in
`docs/fulfilling-requests.md`. Update the routine before merging the change
that added `--with-withdrawn`, or close withdrawn requests' issues by hand.
