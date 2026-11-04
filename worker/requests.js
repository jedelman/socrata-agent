// Source requests: when Siren can't answer from the records she reaches, she
// names the source that would have answered, and the person can ask for it
// to be added. Requests are pooled by source, so the most-wanted sources rise
// to the top for the steward. Nothing about who asked is kept: no account,
// no visitor id; only the source, a link if one was given, and short notes
// on what people wanted to know, which the person sees and can edit first.

import { sha256hex } from './invites.js';

const NOTE_CHARS = 300;
const KEEP_NOTES = 20;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

export const requestKey = async (source) => `request:${await sha256hex(clip(source, 200).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())}`;

export async function addRequest({ body, kv, visitor, perDay = 20, now = Date.now() }) {
  const source = clip(body?.source, 200);
  if (source.length < 3) return { ok: false, status: 400, error: 'Name the source to add.' };
  const url = clip(body?.url, 500);
  const need = clip(body?.need, NOTE_CHARS);
  const day = new Date(now).toISOString().slice(0, 10);
  const rateKey = `request-rate:${day}:${visitor}`;
  const used = Number((await kv.get(rateKey)) || 0);
  if (used >= perDay) return { ok: false, status: 429, error: 'That is a lot of requests for one day. Thank you; try again tomorrow.' };
  await kv.put(rateKey, String(used + 1), { expirationTtl: 90000 });
  const key = await requestKey(source);
  const at = new Date(now).toISOString();
  const cur = (await kv.get(key, 'json')) || { source, url: '', count: 0, first: at, needs: [] };
  const next = {
    ...cur,
    url: cur.url || (/^https:\/\//i.test(url) ? url : ''),
    count: cur.count + 1,
    last: at,
    needs: need ? [...cur.needs, { text: need, at }].slice(-KEEP_NOTES) : cur.needs,
  };
  // KV is eventually consistent, so two requests at once can count as one.
  // The count is a signal for the steward, not a vote.
  await kv.put(key, JSON.stringify(next));
  return { ok: true, count: next.count };
}
