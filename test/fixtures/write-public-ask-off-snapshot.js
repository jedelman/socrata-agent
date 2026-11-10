// Writes public-ask-off-snapshot.json: the flag-off scenario's output. Run it
// only on the code before the free tier (main before the free tier: f6f0e9e, retaken after #31 merged); test/public-ask-off.test.js
// compares the code since against it.
//   node test/fixtures/write-public-ask-off-snapshot.js
import * as nodeModule from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { publicAskOffScenario } from './public-ask-off-scenario.js';

const asText = (url) => ({ format: 'module', source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), 'utf8'))};`, shortCircuit: true });
nodeModule.registerHooks({
  load(url, context, next) {
    if (url.startsWith('file:') && (context.importAttributes?.type === 'text' || url.endsWith('.html'))) return asText(url);
    if (url.startsWith('file:') && url.endsWith('.json') && !context.importAttributes?.type) {
      return { format: 'module', source: `export default ${readFileSync(fileURLToPath(url), 'utf8')};`, shortCircuit: true };
    }
    return next(url, context);
  },
});
const worker = (await import('../../worker/index.js')).default;
const entries = await publicAskOffScenario({ worker });
writeFileSync(new URL('./public-ask-off-snapshot.json', import.meta.url), `${JSON.stringify(entries, null, 1)}\n`);
console.error(`${entries.length} entries written.`);
