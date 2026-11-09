// Where the browser keeps a Bluesky sign-in for endorsing: IndexedDB on
// Siren's origin. Two stores: `flows` (one pending sign-in per state, with
// its non-extractable DPoP key, 10 minutes) and `session` (one at most:
// the DID, handle, PDS, the access token and its key, 24 hours at most).
// Nothing here is ever sent to Siren's Worker. Sign out deletes both.
//
// memoryStore is the same interface in memory, for tests and for browsers
// without IndexedDB (where a sign-in then lasts as long as the page).

const DB = 'siren-endorse';
const VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('flows')) db.createObjectStore('flows', { keyPath: 'state' });
      if (!db.objectStoreNames.contains('session')) db.createObjectStore('session');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      let out;
      Promise.resolve(fn(t.objectStore(store))).then((v) => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

/** The IndexedDB store. */
export function idbStore() {
  return {
    putFlow: (flow) => tx('flows', 'readwrite', (s) => req(s.put(flow))),
    // Read and delete in one transaction: a flow is used once.
    takeFlow: (state) => tx('flows', 'readwrite', async (s) => {
      const flow = await req(s.get(state));
      if (flow) s.delete(state);
      return flow || null;
    }),
    purgeFlows: (now) => tx('flows', 'readwrite', async (s) => {
      for (const f of await req(s.getAll())) if (!(f.expires > now)) s.delete(f.state);
    }),
    getSession: () => tx('session', 'readonly', (s) => req(s.get('current'))).then((v) => v || null),
    putSession: (session) => tx('session', 'readwrite', (s) => req(s.put(session, 'current'))),
    deleteSession: () => tx('session', 'readwrite', (s) => req(s.delete('current'))),
  };
}

/** The same interface in memory. */
export function memoryStore() {
  const flows = new Map();
  let session = null;
  return {
    flows,
    putFlow: async (flow) => { flows.set(flow.state, flow); },
    takeFlow: async (state) => {
      const f = flows.get(state) || null;
      flows.delete(state);
      return f;
    },
    purgeFlows: async (now) => { for (const [k, f] of flows) if (!(f.expires > now)) flows.delete(k); },
    getSession: async () => session,
    putSession: async (s) => { session = s; },
    deleteSession: async () => { session = null; },
  };
}

/** IndexedDB when the browser has it and it opens, else memory. */
export async function bestStore() {
  try {
    if (typeof indexedDB === 'undefined') return memoryStore();
    (await open()).close();
    return idbStore();
  } catch {
    return memoryStore();
  }
}
