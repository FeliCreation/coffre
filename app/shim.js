// Faux `chrome` pour l'application web : la popup et le service worker de l'extension tournent tels quels dans la page.
// - storage.local : localStorage (le coffre y est déjà chiffré) ;
// - storage.session : sessionStorage (la clé de session disparaît à la fermeture de l'application = verrouillage) ;
// - alarms : minuteries, rattrapées au retour au premier plan (les minuteries sont gelées en arrière-plan sur mobile).

const ID = 'coffre-app';
const PREFIX = 'coffre:';

function area(store) {
  const read = () => {
    const out = {};
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k.startsWith(PREFIX)) out[k.slice(PREFIX.length)] = JSON.parse(store.getItem(k));
    }
    return out;
  };
  return {
    async get(k) {
      const all = read();
      if (k == null) return all;
      const out = {};
      for (const x of typeof k === 'string' ? [k] : Array.isArray(k) ? k : Object.keys(k)) if (x in all) out[x] = all[x];
      return out;
    },
    async set(o) {
      for (const [k, v] of Object.entries(o)) store.setItem(PREFIX + k, JSON.stringify(v));
    },
    async remove(k) {
      for (const x of [].concat(k)) store.removeItem(PREFIX + x);
    },
    setAccessLevel() {},
  };
}

export function installAppChrome(g = globalThis) {
  const onMessage = [];
  const onAlarm = [];
  const alarms = new Map(); // nom → { due, period, timer }

  const fire = (name) => {
    const a = alarms.get(name);
    if (!a) return;
    if (a.period) schedule(name, a.period, a.period);
    else alarms.delete(name);
    onAlarm.forEach((f) => f({ name }));
  };
  function schedule(name, delayMin, period) {
    const prev = alarms.get(name);
    if (prev) clearTimeout(prev.timer);
    const ms = Math.max(1000, delayMin * 60_000);
    alarms.set(name, { due: Date.now() + ms, period, timer: setTimeout(() => fire(name), ms) });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    for (const [name, a] of [...alarms]) if (a.due <= Date.now()) fire(name); // échéance dépassée pendant l'arrière-plan
  });

  const sender = { id: ID, url: `app://${ID}/popup` };
  const chrome = {
    runtime: {
      id: ID,
      getURL: (p = '') => `app://${ID}/${p}`,
      onMessage: { addListener: (f) => onMessage.push(f) },
      sendMessage: (msg) =>
        new Promise((resolve) => {
          let async = false;
          for (const f of onMessage) if (f(structuredClone(msg), sender, resolve) === true) async = true;
          if (!async) setTimeout(() => resolve(undefined), 0);
        }),
    },
    storage: { local: area(localStorage), session: area(sessionStorage) },
    alarms: {
      create: async (name, info = {}) => schedule(name, info.delayInMinutes ?? info.periodInMinutes, info.periodInMinutes),
      clear: async (name) => {
        const a = alarms.get(name);
        if (a) clearTimeout(a.timer);
        alarms.delete(name);
      },
      onAlarm: { addListener: (f) => onAlarm.push(f) },
    },
    tabs: {
      onRemoved: { addListener() {} },
      query: async () => [],
      create: async ({ url }) => void window.open(url, '_blank', 'noopener,noreferrer'),
      sendMessage: async () => ({ filled: false }),
    },
  };
  g.chrome = chrome;
  return chrome;
}
