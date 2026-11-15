// Faux `chrome` en mémoire (storage, alarms, runtime.sendMessage) pour tester le service worker
// sous Node et pour le harnais navigateur (dev/harness.html). N'est pas livré dans l'extension.

export function installChrome(g = globalThis, extensionId = 'ext-id') {
  const area = () => {
    const data = {};
    return {
      data,
      async get(k) {
        if (k == null) return structuredClone(data);
        const out = {};
        for (const x of typeof k === 'string' ? [k] : Array.isArray(k) ? k : Object.keys(k)) if (x in data) out[x] = structuredClone(data[x]);
        return out;
      },
      async set(o) { for (const [k, v] of Object.entries(o)) data[k] = structuredClone(v); },
      async remove(k) { for (const x of [].concat(k)) delete data[x]; },
      setAccessLevel() {},
    };
  };
  const onMessage = [], onAlarm = [], onTabRemoved = [];
  const alarms = new Map();

  function dispatch(msg, sender) {
    return new Promise((resolve) => {
      let async = false;
      for (const f of onMessage) if (f(structuredClone(msg), sender, resolve) === true) async = true;
      if (!async) setTimeout(() => resolve(undefined), 0);
    });
  }

  const popupSender = { id: extensionId, url: `chrome-extension://${extensionId}/src/popup/popup.html` };
  const chrome = {
    runtime: {
      id: extensionId,
      getURL: (p = '') => `chrome-extension://${extensionId}/${p}`,
      onMessage: { addListener: (f) => onMessage.push(f) },
      sendMessage: (msg) => dispatch(msg, popupSender), // vue de la popup
    },
    storage: { local: area(), session: area() },
    alarms: {
      create: async (name, info) => void alarms.set(name, info),
      clear: async (name) => alarms.delete(name),
      onAlarm: { addListener: (f) => onAlarm.push(f) },
    },
    tabs: { onRemoved: { addListener: (f) => onTabRemoved.push(f) } },
  };
  g.chrome = chrome;

  return {
    chrome,
    alarms,
    /** Message émis par un script de contenu sur la page `url`. */
    fromContent: (msg, { url, tabId = 1, frameId = 0 }) => dispatch(msg, { id: extensionId, url, tab: { id: tabId }, frameId }),
    /** Message d'une autre extension. */
    fromOther: (msg) => dispatch(msg, { id: 'autre-extension', url: 'chrome-extension://autre/x.html' }),
    fireAlarm: (name) => onAlarm.forEach((f) => f({ name })),
    closeTab: (id) => onTabRemoved.forEach((f) => f(id)),
  };
}
