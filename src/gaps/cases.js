// The case files bundled with Siren, for the gap code's render-time check
// (docs/gaps.md §5.3.9): a gap that quotes a finding is shown only while the
// bundled case file still holds that finding, verified, with the same quote.
// plugins/case-file.js bundles the same files for the case_file tool.

import trees from '../../data/cases/norfolk-trees.json' with { type: 'json' };
import litter from '../../data/cases/norfolk-litter.json' with { type: 'json' };

export const CASES = Object.freeze({ [trees.id]: trees, [litter.id]: litter });
