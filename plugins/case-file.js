// case_file: the verified case files, for questions with no address ("do the
// trees in Ghent have any protection?"). The same record trees_on_my_block
// and litter_on_my_street attach, reachable on its own.

import { definePlugin } from '../src/plugins.js';
import { theRecord } from './cases.js';
import trees from '../data/cases/norfolk-trees.json' with { type: 'json' };
import litter from '../data/cases/norfolk-litter.json' with { type: 'json' };

export const CASES = { [trees.id]: trees, [litter.id]: litter };

export default definePlugin({
  name: 'case_file',
  cities: ['norfolk'],
  description: `Read a verified case file: findings checked against their sources (budgets, audits, City Code, state law, studies), sorted into what confirms a concern, what weakens it, the rules that apply, and who decides, with what would help and which records to request. Topics: ${Object.values(CASES).map((c) => `"${c.id}" (${c.title})`).join('; ')}. Use for questions about these topics that have no address, such as a neighborhood, the whole city, or what the rules are.`,
  parameters: {
    type: 'object',
    properties: { topic: { type: 'string', enum: Object.keys(CASES), description: 'Which case file.' } },
    required: ['topic'],
    additionalProperties: false,
  },
  async run(ctx, { topic }) {
    const doc = CASES[topic];
    if (!doc) return { error: `No case file "${topic}". Known: ${Object.keys(CASES).join(', ')}.` };
    return theRecord(ctx, doc);
  },
});
