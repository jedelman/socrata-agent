// Every outbound request an answer makes, counted at the fetch boundary.
//
// Cloudflare caps the external subrequests one Worker invocation may make: 50
// on Workers Free, 10,000 by default on Paid (limits page, checked
// 2026-11-06). Every fetch() to the internet counts, each model API call and
// each SDK retry included. A Siren answer runs its whole tool loop in one
// invocation, and past the cap every fetch throws, the model's too, so the
// person would get an error instead of an answer.
//
// So each answer gets one counter, and every fetch made on its behalf goes
// through it: Socrata, the meeting portal, plugin HTTP, the model provider and
// its retries. Tools are counted, not trusted: createContext hands them only
// the counting fetch. One count, two lanes:
//   - tool fetches are refused once what is left would not cover the model
//     calls still needed to finish (the reserve). A refusal throws
//     RequestBudgetError before any request goes out, and Trace.record marks
//     the step "refused" with the reason.
//   - model fetches are never refused here: the final answer must still be
//     asked for. The reserve keeps them under the platform's cap.

export class RequestBudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RequestBudgetError';
    this.refused = true;
  }
}

export const isBudgetRefusal = (err) => err instanceof RequestBudgetError;

// The real network, looked up at call time (a test that swaps
// globalThis.fetch still sees the call). Nothing else in src/ names it.
export const networkFetch = (...args) => globalThis.fetch(...args);

/** A whole number of requests, or Infinity for "no limit" (unset, 0, or not a number). */
export function budgetLimit(value) {
  const n = Number(value);
  return value != null && value !== '' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : Infinity;
}

/**
 * One answer's request counter. `limit` caps every fetch it makes (Infinity:
 * count only). `fetchImpl` is the network underneath (default: the real one).
 */
export function requestBudget({ limit = Infinity, fetchImpl } = {}) {
  const max = budgetLimit(limit);
  const base = fetchImpl || networkFetch;
  let tools = 0;
  let model = 0;
  let refused = 0;
  let reserve = 0;
  const used = () => tools + model;

  return Object.freeze({
    get limit() {
      return max;
    },
    get used() {
      return used();
    },
    get refused() {
      return refused;
    },
    get reserve() {
      return reserve;
    },
    /** How many requests to keep back for the model calls that finish the answer. */
    setReserve(n) {
      reserve = Math.max(0, Math.floor(Number(n) || 0));
    },
    /** True once a tool fetch would be refused (or one already was). */
    get exhausted() {
      return refused > 0 || used() + 1 + reserve > max;
    },
    /** The fetch tools get: counted, and refused past the limit less the reserve. */
    tool: async (url, init) => {
      if (used() + 1 + reserve > max) {
        refused++;
        throw new RequestBudgetError(
          `Not sent: this answer's limit of ${max} outbound requests is reached (${used()} made, ${reserve} kept so the model can still answer).`
        );
      }
      tools++;
      return base(url, init);
    },
    /** The fetch the model provider gets: counted, never refused. */
    model: async (url, init) => {
      model++;
      return base(url, init);
    },
    summary() {
      return { limit: Number.isFinite(max) ? max : null, used: used(), tools, model, refused };
    },
  });
}
