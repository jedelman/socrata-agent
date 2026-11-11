# Telemetry

Siren keeps two kinds of lines in Cloudflare Workers Logs. Both are kept for 7 days, and neither holds a question, an answer, an account or an address.

1. **Answer lines** (`event: "siren.answer"`, `worker/telemetry.js`). Siren writes one per answer, with `TELEMETRY = "true"`. Each line holds:
   - the tier and the model;
   - steps, time and cost;
   - which tools ran;
   - whether the answer was partial;
   - which case files were read;
   - a few topic words, only those found in the City's own budget books and Zoning Ordinance;
   - a `trace` id.
2. **Claude API spans** (`event: "claude.span"`, `worker/otlp.js`). These come from the OpenTelemetry export of the Anthropic API workspace that Siren's key belongs to. Jason, 2026-11-11: "the Siren workspace refers to the Claude API we're running her on. It can export opentelemetry traces."
   - Each model call is a span, and each web search is a span inside it.
   - A span records the model, tokens (cache reads and writes included), stop reason, service tier, error type, tool name, the API's request id, and its timing.

Each answer's model calls carry one random trace id, sent to the API as a W3C `traceparent` header. The API's spans for those calls carry the same id as the answer line's `trace`. Filter Workers Logs on that id to see one answer end to end: Siren's line, then every model call and search the API ran for it.

## Why a route on Siren, and not Cloudflare directly

Cloudflare's OpenTelemetry support only sends data out to other platforms. It takes no OTLP in, and it never accepts the binary (protobuf) encoding ([Cloudflare docs](https://developers.cloudflare.com/observability/export/opentelemetry/), read 2026-11-11).

The Claude API sends only OTLP/HTTP protobuf, usually gzipped ([Anthropic docs](https://platform.claude.com/docs/en/manage-claude/opentelemetry/api), read 2026-11-11). So Siren acts as the collector, at `POST /otlp/v1/traces`:
- it checks the token;
- it decodes the protobuf, with no extra dependency;
- it writes one line per span.

The route exists only while the `OTLP_TOKEN` secret is set, and is at least 32 characters. Otherwise the path answers as every unknown path does.

## What never reaches a log

Set the destination to **Metadata only**. In that mode the API sends no prompts, responses, tool inputs or tool results.

The receiver does not rely on that alone. It keeps a fixed list of attributes, each with the shape its value must have, and drops everything else:
- the organization, workspace and user ids;
- URLs and beta names;
- any value of the wrong shape, such as a model name that isn't a model name.

The content attributes (the span reference's "Content" badge) are never read at all. If the destination is ever switched to **Full content**, the content still never reaches a log. The delivery's summary line then says `"content_arrived": true`, so the steward knows to switch the destination back.

The token travels in its own header, `x-otlp-token`. No Worker route reads an `Authorization` header: the Bluesky sign-in promise (`test/requests-page.test.js`) depends on that.

## Setting it up (Jason)

You need the admin role in the Console organization.

1. **Make a token:** `openssl rand -hex 32` (64 characters).
2. **Store it as Siren's secret.** Run `npx wrangler secret put OTLP_TOKEN --env siren` and paste the token, or add it in the dashboard: Workers & Pages → siren → Settings → Variables and Secrets → Add, type Secret, name `OTLP_TOKEN`. Secrets carry over from one Workers Builds deploy to the next.
3. **Add a destination** at platform.claude.com/settings/telemetry-destinations (Add destination):

   | Field | Value |
   | --- | --- |
   | Provider | Custom |
   | Name | Siren (Workers Logs) |
   | OTLP endpoint URL | `https://ask-siren.jason-edelman.org/otlp` (the API adds `/v1/traces`) |
   | Request headers | `x-otlp-token`, with the token as its value |
   | Content mode | **Metadata only** |
   | Workspaces | **Selected**, then Siren's workspace only |

4. **Test it:** choose More actions → Test.
   - It should say the span was delivered, and Workers Logs should show a `claude.span` line named `anthropic.test`.
   - A 415 means the secret isn't live yet: the path is still answering as an unknown one.
   - A 401 means the header's value doesn't match the secret.
5. **Optional: give me the workspace id** (`wrkspc_...`). I'll set it as `OTLP_WORKSPACE` in `wrangler.toml`, and then spans from any other workspace never land in Siren's logs, even if the destination's scope is widened later. It isn't a secret.

To stop, delete or disable the destination in the Console, or delete the secret.

## Limits and cost

- **Delivery:** at least once and best effort. The same span can arrive twice (its trace and span ids tell the copies apart), and a span can be lost.
- **Size:** a delivery may be up to 4 MB as sent and 16 MB unzipped. At most 2,000 lines are written per delivery; the summary line counts the rest.
- **Cost:** an answer with six model calls and two searches writes about 15 lines of a few hundred bytes each. From 2026-12-01, Workers Paid includes 50 GB of log ingestion per billing cycle ([Cloudflare docs](https://developers.cloudflare.com/observability/pricing/), read 2026-11-11). Siren's traffic uses a small fraction of that.

## Not yet

The case-file routine can't read Workers Logs yet. That needs a read-only Cloudflare API token in the routine's environment, and that environment doesn't have one.
