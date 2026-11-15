// Service worker MV3 : seul détenteur du coffre déchiffré.
// Il est tué par le navigateur à tout moment : on reconstruit donc le coffre à chaque réveil
// à partir du blob chiffré (storage.local) et de la clé de session (storage.session, mémoire seulement).

import { Vault, VaultError, hostOf, hostMatches } from '../core/vault.js';
import { generatePassword, estimateStrength } from '../core/generator.js';
import { syncVault, fetchRemoteVault, checkConfig } from '../core/sync.js';

const KEY_VAULT = 'vault';
const KEY_SESSION = 'sessionKey';
const KEY_SETTINGS = 'settings';
const ALARM_LOCK = 'autolock';
const ALARM_SYNC = 'sync';
const KEY_SYNC_LAST = 'syncLast';
const KEY_JOIN = 'joinSync'; // dépôt + jeton saisis avant le déverrouillage (mémoire seulement)
const SYNC_EVERY_MINUTES = 5;
const DEFAULT_SETTINGS = { autoLockMinutes: 15 };

// La clé de session reste invisible des content scripts (pages web).
chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });

let cached = null; // Vault déchiffré tant que le worker vit
let queue = Promise.resolve(); // sérialise les opérations pour éviter les écritures concurrentes

async function settings() {
  const { [KEY_SETTINGS]: s } = await chrome.storage.local.get(KEY_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...s };
}

async function armAutoLock() {
  const { autoLockMinutes } = await settings();
  if (autoLockMinutes > 0) await chrome.alarms.create(ALARM_LOCK, { delayInMinutes: autoLockMinutes });
}

// Identifiants saisis sur une page, en attente de « Enregistrer ? » (mémoire seulement, par onglet).
const PENDING_PREFIX = 'pending:';
const PENDING_TTL_MS = 10 * 60_000;

async function clearPending(tabId) {
  if (tabId !== undefined) return chrome.storage.session.remove(PENDING_PREFIX + tabId);
  const keys = Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith(PENDING_PREFIX));
  if (keys.length) await chrome.storage.session.remove(keys);
}

async function readPending(tabId) {
  const k = PENDING_PREFIX + tabId;
  const p = (await chrome.storage.session.get(k))[k];
  if (!p) return null;
  if (Date.now() - p.at > PENDING_TTL_MS) {
    await clearPending(tabId);
    return null;
  }
  return p;
}

chrome.tabs.onRemoved.addListener((tabId) => clearPending(tabId));

async function lock() {
  cached = null;
  await chrome.storage.session.remove(KEY_SESSION);
  await clearPending();
  await chrome.alarms.clear(ALARM_LOCK);
  await chrome.alarms.clear(ALARM_SYNC);
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM_LOCK) lock();
  if (a.name === ALARM_SYNC) syncSoon();
});

async function stored() {
  return (await chrome.storage.local.get(KEY_VAULT))[KEY_VAULT] ?? null;
}

async function unlockedVault() {
  if (cached) return cached;
  const st = await stored();
  const { [KEY_SESSION]: key } = await chrome.storage.session.get(KEY_SESSION);
  if (!st || !key) throw new VaultError('LOCKED', 'Coffre verrouillé.');
  cached = await Vault.fromSessionKey(st, key);
  return cached;
}

async function persist(vault, { sync = true } = {}) {
  await chrome.storage.local.set({ [KEY_VAULT]: await vault.serialize() });
  if (sync) syncSoon();
}

// ----- Synchronisation (coffre chiffré dans un dépôt GitHub privé) -----

async function runSync(vault) {
  const cfg = vault.sync;
  if (!cfg) return null;
  try {
    const res = await syncVault(vault, cfg);
    if (res.pulled) await persist(vault, { sync: false });
    await chrome.storage.local.set({ [KEY_SYNC_LAST]: { at: Date.now(), ok: true } });
    return res;
  } catch (e) {
    await chrome.storage.local.set({ [KEY_SYNC_LAST]: { at: Date.now(), ok: false, code: e.code ?? 'ERROR', error: e.message } });
    throw e;
  }
}

/** Planifie une synchro après l'opération en cours (échecs silencieux : visibles dans Réglages). */
function syncSoon() {
  queue = queue.then(async () => {
    try {
      const v = await unlockedVault();
      if (v.sync) await runSync(v);
    } catch {}
  });
}

async function startSession(vault) {
  cached = vault;
  await chrome.storage.session.set({ [KEY_SESSION]: await vault.sessionKey() });
  await armAutoLock();
  if (vault.sync) await chrome.alarms.create(ALARM_SYNC, { periodInMinutes: SYNC_EVERY_MINUTES });
}

// ----- Actions exposées à l'interface (popup, options) -----
// Les mots de passe ne sortent que via `reveal` / `shareEntry`, sur action explicite.

const actions = {
  async state() {
    const exists = !!(await stored());
    let unlocked = false;
    if (exists) {
      try {
        await unlockedVault();
        unlocked = true;
      } catch {}
    }
    return { exists, unlocked };
  },
  async create({ password }) {
    if (await stored()) throw new VaultError('EXISTS', 'Un coffre existe déjà.');
    const vault = await Vault.create(password);
    await persist(vault);
    await startSession(vault);
    return {};
  },
  async unlock({ password }) {
    const st = await stored();
    if (!st) throw new VaultError('NO_VAULT', 'Aucun coffre.');
    const vault = await Vault.unlock(st, password);
    const joined = (await chrome.storage.session.get(KEY_JOIN))[KEY_JOIN];
    if (joined) {
      vault.setSync(joined); // appareil rejoint : on retient dépôt + jeton dans la partie chiffrée
      await chrome.storage.session.remove(KEY_JOIN);
    }
    await startSession(vault);
    if (vault.sync) {
      try {
        await runSync(vault); // met la liste à jour tout de suite ; un échec n'empêche pas d'ouvrir le coffre
      } catch {}
    }
    if (joined) await persist(vault, { sync: false });
    return {};
  },
  async lock() {
    await lock();
    return {};
  },
  async list({ query = '' }) {
    return { entries: (await unlockedVault()).search(query) };
  },
  async forHost({ host }) {
    return { entries: (await unlockedVault()).forHost(host) };
  },
  async reveal({ id }) {
    return { entry: (await unlockedVault()).getEntry(id) };
  },
  async add({ entry }) {
    const v = await unlockedVault();
    const added = v.addEntry(entry);
    await persist(v);
    return { entry: added };
  },
  async update({ id, patch }) {
    const v = await unlockedVault();
    const updated = v.updateEntry(id, patch);
    await persist(v);
    return { entry: updated };
  },
  async remove({ id }) {
    const v = await unlockedVault();
    v.deleteEntry(id);
    await persist(v);
    return {};
  },
  async generate({ options }) {
    const password = generatePassword(options);
    return { password, strength: estimateStrength(password) };
  },
  async strength({ password }) {
    return { strength: estimateStrength(password) };
  },
  async myShareInfo() {
    const v = await unlockedVault();
    return { code: await v.myPublicCode(), fingerprint: await v.myFingerprint() };
  },
  async shareEntry({ id, recipientCode, ttlHours }) {
    return { code: await (await unlockedVault()).shareEntry(id, recipientCode, { ttlHours }) };
  },
  async importShare({ code }) {
    const v = await unlockedVault();
    const res = await v.importShare(code);
    await persist(v);
    return res;
  },
  async getSettings() {
    return { settings: await settings() };
  },
  async setSettings({ settings: s }) {
    const minutes = Number(s?.autoLockMinutes);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 240) throw new VaultError('BAD_SETTING', 'Délai invalide (0 à 240 minutes).');
    await chrome.storage.local.set({ [KEY_SETTINGS]: { autoLockMinutes: Math.round(minutes) } });
    return {};
  },
  async pendingForTab({ tabId }) {
    await unlockedVault();
    const p = await readPending(tabId);
    return { pending: p ? { host: p.host, username: p.username, existingId: p.existingId } : null };
  },
  async savePending({ tabId }) {
    const p = await readPending(tabId);
    if (!p) throw new VaultError('NO_PENDING', 'Rien à enregistrer.');
    const v = await unlockedVault();
    let entry;
    try {
      if (!p.existingId) throw new VaultError('NOT_FOUND');
      entry = v.updateEntry(p.existingId, { password: p.password });
    } catch (e) {
      if (e.code !== 'NOT_FOUND') throw e;
      entry = v.addEntry({ title: p.host, url: p.origin, username: p.username, password: p.password });
    }
    await persist(v);
    await clearPending(tabId);
    return { entry };
  },
  async dismissPending({ tabId }) {
    await clearPending(tabId);
    return {};
  },
  async importEntries({ entries }) {
    if (!Array.isArray(entries) || entries.length > 5000) throw new VaultError('BAD_IMPORT', 'Import invalide (5 000 identifiants au maximum).');
    const str = (x) => (typeof x === 'string' ? x.slice(0, 20_000) : '');
    const clean = entries.map((e) => ({ title: str(e?.title), url: str(e?.url), username: str(e?.username), password: str(e?.password), notes: str(e?.notes) }));
    const v = await unlockedVault();
    const res = v.importEntries(clean);
    if (res.added) await persist(v);
    return res;
  },
  async syncStatus() {
    const v = await unlockedVault();
    const { [KEY_SYNC_LAST]: last = null } = await chrome.storage.local.get(KEY_SYNC_LAST);
    return { configured: !!v.sync, repo: v.sync?.repo ?? null, last };
  },
  async syncSetup({ repo, token }) {
    const v = await unlockedVault();
    const cfg = checkConfig({ repo, token });
    const previous = v.sync;
    v.setSync({ repo: cfg.repo, token: cfg.token });
    try {
      await runSync(v);
    } catch (e) {
      v.setSync(previous);
      throw e;
    }
    await persist(v, { sync: false });
    await chrome.alarms.create(ALARM_SYNC, { periodInMinutes: SYNC_EVERY_MINUTES });
    return {};
  },
  async syncNow() {
    const v = await unlockedVault();
    if (!v.sync) throw new VaultError('NO_SYNC', "La synchronisation n'est pas configurée.");
    return { ...(await runSync(v)) };
  },
  async syncDisable() {
    const v = await unlockedVault();
    v.setSync(null);
    await persist(v, { sync: false });
    await chrome.alarms.clear(ALARM_SYNC);
    return {};
  },
  /** Appareil sans coffre : télécharge le coffre chiffré distant ; on le déverrouille ensuite avec le mot de passe maître. */
  async syncJoin({ repo, token }) {
    if (await stored()) throw new VaultError('EXISTS', 'Un coffre existe déjà sur cet appareil.');
    const cfg = checkConfig({ repo, token });
    const remote = await fetchRemoteVault(cfg);
    if (!remote) throw new VaultError('NO_REMOTE_VAULT', "Ce dépôt ne contient pas encore de coffre : activez d'abord la synchronisation sur l'autre appareil.");
    await chrome.storage.local.set({ [KEY_VAULT]: remote });
    await chrome.storage.session.set({ [KEY_JOIN]: { repo: cfg.repo, token: cfg.token } });
    return {};
  },
  async changeMasterPassword({ current, next }) {
    const st = await stored();
    const v = await Vault.unlock(st, current); // revérifie l'ancien mot de passe
    await v.changeMasterPassword(next);
    await persist(v);
    await startSession(v);
    return {};
  },
};

// ----- Actions du script de contenu (pages web) -----
// Le site visé vient toujours de `sender.url` (fourni par le navigateur), jamais du message.
// Une page n'obtient un identifiant que si son domaine correspond, et seulement en HTTPS.

function pageInfo(sender) {
  let u;
  try {
    u = new URL(sender.url);
  } catch {
    throw new VaultError('BAD_PAGE', 'Page invalide.');
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !local) throw new VaultError('INSECURE', "Remplissage refusé : la page n'est pas en HTTPS.");
  return { host: hostOf(u.hostname), origin: u.origin };
}

const contentActions = {
  async entries(_msg, sender) {
    const { host } = pageInfo(sender);
    if (!(await stored())) return { locked: true, exists: false, entries: [] };
    try {
      return { locked: false, exists: true, entries: (await unlockedVault()).forHost(host) };
    } catch (e) {
      if (e.code === 'LOCKED') return { locked: true, exists: true, entries: [] };
      throw e;
    }
  },
  async fill({ id }, sender) {
    const { host } = pageInfo(sender);
    const e = (await unlockedVault()).getEntry(id);
    if (!hostMatches(hostOf(e.url), host)) throw new VaultError('HOST_MISMATCH', 'Cet identifiant ne correspond pas à ce site.');
    return { username: e.username, password: e.password };
  },
  async captured({ username, password }, sender) {
    if (typeof password !== 'string' || !password || password.length > 1024) return {};
    if (typeof username !== 'string' || username.length > 512) username = '';
    const { host, origin } = pageInfo(sender);
    let v;
    try {
      v = await unlockedVault();
    } catch {
      return {}; // coffre verrouillé : on ne retient rien
    }
    const same = v.forHost(host).map((s) => v.getEntry(s.id)).filter((e) => e.username === username);
    if (same.some((e) => e.password === password)) return {}; // déjà enregistré
    await chrome.storage.session.set({
      [PENDING_PREFIX + sender.tab.id]: { host, origin, username, password, existingId: same[0]?.id ?? null, at: Date.now() },
    });
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  // Les pages de l'extension (popup) et les scripts de contenu ont des tables d'actions séparées.
  const fromPage = !!sender.tab && sender.url && !sender.url.startsWith(chrome.runtime.getURL(''));
  const table = fromPage ? contentActions : actions;
  if (!Object.hasOwn(table, msg?.type)) return false;
  if (fromPage && sender.frameId !== 0) {
    sendResponse({ ok: false, code: 'BAD_FRAME', error: 'Cadre non pris en charge.' });
    return false;
  }

  queue = queue
    .then(async () => {
      const result = await table[msg.type](msg, sender);
      if (msg.type !== 'lock' && msg.type !== 'state') await armAutoLock(); // activité : on repousse le verrouillage
      return { ok: true, ...result };
    })
    .catch((e) => ({ ok: false, code: e.code ?? 'ERROR', error: e.message }))
    .then(sendResponse);
  return true; // réponse asynchrone
});
