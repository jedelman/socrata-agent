// Deployments the Worker can run, chosen by the DEPLOYMENT var. Each has to be
// a static import so it gets bundled. Add yours here.
import defaultConfig from './default.config.js';
import spongeCityNorfolk from './sponge-city-norfolk.config.js';
import siren from './siren.config.js';

export default {
  default: defaultConfig,
  'sponge-city-norfolk': spongeCityNorfolk,
  siren,
};
