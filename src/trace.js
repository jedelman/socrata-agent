// The trace is written by code, never by the model. Every outbound request
// made on the agent's behalf lands here as it happens, so the trace shown to
// the operator is a record of what ran, not the model's account of it.
// A request the answer's budget refused (src/request-budget.js) is recorded too, as
// "refused" with the reason, so the trace shows what was not sent and why.

import { isBudgetRefusal } from './request-budget.js';

export class Trace {
  constructor() {
    this.steps = [];
  }

  // Wrap one outbound request. `info` describes it for a human reader;
  // `run` performs it and returns { result, rows }.
  async record(info, run) {
    const step = { n: this.steps.length + 1, ...info, ok: false, rows: null, ms: 0 };
    this.steps.push(step);
    const t0 = Date.now();
    try {
      const { result, rows } = await run();
      step.ok = true;
      step.rows = rows ?? null;
      return result;
    } catch (err) {
      step.error = String(err?.message || err);
      if (isBudgetRefusal(err)) step.refused = true;
      throw err;
    } finally {
      step.ms = Date.now() - t0;
    }
  }

  toJSON() {
    return this.steps;
  }

  toMarkdown() {
    if (!this.steps.length) return '_No queries were run._';
    return this.steps
      .map((s) => {
        const head = `${s.n}. **${s.tool}**${s.dataset ? ` · \`${s.dataset}\`` : ''}`;
        const what = s.soql ? `\n   \`${s.soql}\`` : '';
        const result = s.ok
          ? s.rows == null
            ? 'ok'
            : `${s.rows} row${s.rows === 1 ? '' : 's'}`
          : `${s.refused ? 'refused' : 'failed'}: ${s.error}`;
        // A step with no request to repeat (earlier results, earlier research) has no link.
        return `${head}${what}\n   ${result} · ${s.ms} ms${s.url ? ` · [source](${s.url})` : ''}`;
      })
      .join('\n');
  }
}
