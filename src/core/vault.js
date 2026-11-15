// Coffre-fort : tout est chiffré par une clé aléatoire (clé du coffre), elle-même protégée
// par le mot de passe maître. Changer de mot de passe ne rechiffre donc que la clé.

import * as C from './crypto.js';
import * as S from './share.js';
import { newRecoveryCode, normalizeRecoveryCode } from './recovery.js';

const AAD_DATA = 'coffre:data:1';
const AAD_WRAP = 'coffre:wrap:1';
const AAD_RECOVERY = 'coffre:recovery:1';
const MIN_PASSWORD_LENGTH = 10;
const HISTORY_MAX = 5;

export class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

function checkMaster(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) {
    throw new VaultError('WEAK_MASTER', `Le mot de passe maître doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`);
  }
}

/** Nom d'hôte normalisé d'une URL saisie librement (« exemple.fr », « https://exemple.fr/x »). */
export function hostOf(url) {
  if (!url) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Adresse ouvrable pour une saisie libre : http(s) uniquement (jamais javascript:, file:, mailto:…). */
export function siteUrl(url) {
  const s = (url ?? '').trim();
  if (!s) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  // « mailto:x », « javascript:x »… : un schéma sans « // » n'est accepté que s'il s'agit d'un port (localhost:3000).
  if (!hasScheme && /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(s)) return null;
  try {
    const u = new URL(hasScheme ? s : `https://${s}`);
    if (u.username || u.password) return null; // « https://site.fr@autre.com » est un piège classique
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** L'hôte de l'onglet correspond à l'hôte de l'entrée s'il est identique ou en est un sous-domaine. */
export function hostMatches(entryHost, tabHost) {
  if (!entryHost || !tabHost) return false;
  const t = tabHost.replace(/^www\./, '');
  return t === entryHost || t.endsWith(`.${entryHost}`);
}

const TOMBSTONE_MAX_AGE_MS = 180 * 24 * 3600_000;

/** Empreinte de ce qui doit être synchronisé (sans les secrets : seulement identifiants d'entrées et dates). */
function signature(d) {
  const ents = d.entries.map((e) => `${e.id}:${e.updatedAt}`).sort().join(',');
  const del = Object.entries(d.deleted ?? {}).map(([id, t]) => `${id}:${t}`).sort().join(',');
  return `${ents}|${del}|${d.headerAt ?? 0}`;
}

const summary = ({ password, notes, history, ...rest }) => ({ ...rest, hasNotes: !!notes });

export class Vault {
  #key;
  #header;
  data;

  constructor(key, header, data) {
    this.#key = key;
    this.#header = header;
    this.data = data;
  }

  // ----- Cycle de vie -----

  static async create(masterPassword, { iterations = C.KDF_ITERATIONS } = {}) {
    checkMaster(masterPassword);
    const salt = C.randomBytes(16);
    const kek = await C.deriveKek(masterPassword, salt, iterations);
    const key = await C.newVaultKey();
    const wrappedKey = await C.seal(kek, await C.exportKey(key), AAD_WRAP);
    const header = { v: 1, kdf: { name: 'PBKDF2-SHA256', iterations, salt: C.toB64(salt) }, wrappedKey };
    const data = { version: 1, createdAt: Date.now(), headerAt: Date.now(), entries: [], deleted: {}, sync: null, identity: await S.generateIdentity() };
    return new Vault(key, header, data);
  }

  static async unlock(stored, masterPassword) {
    if (stored?.v !== 1) throw new VaultError('BAD_FORMAT', 'Format de coffre inconnu.');
    const kek = await C.deriveKek(masterPassword ?? '', C.fromB64(stored.kdf.salt), stored.kdf.iterations);
    let raw;
    try {
      raw = await C.open(kek, stored.wrappedKey, AAD_WRAP);
    } catch {
      throw new VaultError('WRONG_PASSWORD', 'Mot de passe maître incorrect.');
    }
    return Vault.#load(stored, await C.importVaultKey(raw));
  }

  /** Rouvre le coffre avec la clé gardée en session (sans re-demander le mot de passe). */
  static async fromSessionKey(stored, sessionKeyB64) {
    if (stored?.v !== 1) throw new VaultError('BAD_FORMAT', 'Format de coffre inconnu.');
    return Vault.#load(stored, await C.importVaultKey(C.fromB64(sessionKeyB64)));
  }

  static async #load(stored, key) {
    const { data: sealed, ...header } = stored;
    let data;
    try {
      data = await C.openJson(key, sealed, AAD_DATA);
    } catch {
      throw new VaultError('CORRUPTED', 'Coffre illisible ou altéré.');
    }
    return new Vault(key, header, data);
  }

  async serialize() {
    return { ...this.#header, data: await C.sealJson(this.#key, this.data, AAD_DATA) };
  }

  async sessionKey() {
    return C.toB64(await C.exportKey(this.#key));
  }

  async changeMasterPassword(newPassword, { iterations = C.KDF_ITERATIONS } = {}) {
    checkMaster(newPassword);
    const salt = C.randomBytes(16);
    const kek = await C.deriveKek(newPassword, salt, iterations);
    const wrappedKey = await C.seal(kek, await C.exportKey(this.#key), AAD_WRAP);
    const { recovery } = this.#header;
    this.#header = { v: 1, kdf: { name: 'PBKDF2-SHA256', iterations, salt: C.toB64(salt) }, wrappedKey, ...(recovery ? { recovery } : {}) };
    this.data.headerAt = Date.now(); // permet à la synchro de savoir quel en-tête est le plus récent
  }

  // ----- Kit de récupération -----

  get hasRecovery() {
    return !!this.#header.recovery;
  }

  /** Crée (ou remplace) le kit : renvoie le code à afficher UNE fois. L'ancien code cesse de fonctionner. */
  async createRecoveryKit({ iterations = C.KDF_ITERATIONS } = {}) {
    const code = newRecoveryCode();
    const salt = C.randomBytes(16);
    const kek = await C.deriveKek(normalizeRecoveryCode(code), salt, iterations);
    const wrappedKey = await C.seal(kek, await C.exportKey(this.#key), AAD_RECOVERY);
    this.#header = { ...this.#header, recovery: { iterations, salt: C.toB64(salt), wrappedKey } };
    this.data.headerAt = Date.now();
    return code;
  }

  /** Rouvre le coffre avec le code de récupération (à suivre d'un changeMasterPassword). */
  static async unlockWithRecovery(stored, code) {
    if (stored?.v !== 1) throw new VaultError('BAD_FORMAT', 'Format de coffre inconnu.');
    if (!stored.recovery) throw new VaultError('NO_RECOVERY', "Aucun kit de récupération n'a été créé pour ce coffre.");
    const norm = normalizeRecoveryCode(code);
    if (!norm) throw new VaultError('WRONG_RECOVERY', 'Code de récupération invalide (32 lettres et chiffres).');
    const kek = await C.deriveKek(norm, C.fromB64(stored.recovery.salt), stored.recovery.iterations);
    let raw;
    try {
      raw = await C.open(kek, stored.recovery.wrappedKey, AAD_RECOVERY);
    } catch {
      throw new VaultError('WRONG_RECOVERY', 'Code de récupération incorrect.');
    }
    return Vault.#load(stored, await C.importVaultKey(raw));
  }

  // ----- Synchronisation -----

  /** Configuration de synchro (dépôt + jeton), gardée dans la partie chiffrée du coffre. */
  get sync() {
    return this.data.sync ?? null;
  }

  setSync(cfg) {
    this.data.sync = cfg;
  }

  /**
   * Fusionne le coffre distant (même clé obligatoire) dans celui-ci.
   * Par entrée : la plus récente gagne ; une suppression gagne sur une modification plus ancienne.
   * Renvoie { pull: ce coffre a changé, push: le coffre distant doit être mis à jour }.
   */
  async mergeRemote(remoteStored) {
    if (remoteStored?.v !== 1) throw new VaultError('BAD_FORMAT', 'Format de coffre inconnu.');
    let remote;
    try {
      remote = await Vault.#load(remoteStored, this.#key);
    } catch {
      throw new VaultError('DIFFERENT_VAULT', "Le coffre distant n'est pas le même que celui de cet appareil (ou il est altéré).");
    }
    const a = this.data;
    const b = remote.data;
    const before = signature(a);
    const remoteSig = signature(b);

    const deleted = {};
    for (const src of [b.deleted ?? {}, a.deleted ?? {}]) for (const [id, t] of Object.entries(src)) deleted[id] = Math.max(deleted[id] ?? 0, t);

    const newer = (x, y) => (x.updatedAt !== y.updatedAt ? x.updatedAt > y.updatedAt : JSON.stringify(x) > JSON.stringify(y));
    const best = new Map();
    for (const e of [...b.entries, ...a.entries]) {
      const cur = best.get(e.id);
      if (!cur || newer(e, cur)) best.set(e.id, e);
    }
    const entries = [];
    for (const e of best.values()) {
      if ((deleted[e.id] ?? -1) >= e.updatedAt) continue; // supprimée après sa dernière modification
      delete deleted[e.id]; // modifiée après une suppression : la pierre tombale n'a plus lieu d'être
      entries.push(e);
    }
    const limit = Date.now() - TOMBSTONE_MAX_AGE_MS;
    for (const [id, t] of Object.entries(deleted)) if (t < limit) delete deleted[id];

    entries.sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));
    a.entries = entries;
    a.deleted = deleted;
    a.createdAt = Math.min(a.createdAt, b.createdAt ?? a.createdAt);
    if ((b.headerAt ?? 0) > (a.headerAt ?? 0)) {
      const { data: _d, ...hdr } = remoteStored;
      this.#header = hdr;
      a.headerAt = b.headerAt;
    }
    a.sync ??= b.sync ?? null;
    const after = signature(a);
    return { pull: after !== before, push: after !== remoteSig };
  }

  // ----- Entrées -----

  #find(id) {
    const e = this.data.entries.find((x) => x.id === id);
    if (!e) throw new VaultError('NOT_FOUND', 'Entrée introuvable.');
    return e;
  }

  addEntry({ title = '', url = '', username = '', password = '', notes = '', source = null } = {}) {
    if (!title.trim() && !url.trim()) throw new VaultError('EMPTY', 'Un titre ou une adresse est requis.');
    const now = Date.now();
    const entry = {
      id: crypto.randomUUID(),
      title: title.trim() || hostOf(url),
      url: url.trim(),
      username,
      password,
      notes,
      history: [],
      source,
      createdAt: now,
      updatedAt: now,
    };
    this.data.entries.push(entry);
    return summary(entry);
  }

  /** Ajoute plusieurs entrées en ignorant les doublons exacts (même site, identifiant et mot de passe). */
  importEntries(list) {
    const key = (e) => `${hostOf(e.url) || (e.title || '').trim().toLowerCase()}\u0000${e.username}\u0000${e.password}`;
    const seen = new Set(this.data.entries.map(key));
    let added = 0;
    let duplicates = 0;
    let invalid = 0;
    for (const e of list) {
      if (!e || (!e.title?.trim() && !e.url?.trim())) {
        invalid++;
        continue;
      }
      const entry = { title: '', url: '', username: '', password: '', notes: '', ...e };
      const k = key(entry);
      if (seen.has(k)) {
        duplicates++;
        continue;
      }
      seen.add(k);
      this.addEntry({ title: entry.title, url: entry.url, username: entry.username, password: entry.password, notes: entry.notes });
      added++;
    }
    return { added, duplicates, invalid };
  }

  updateEntry(id, patch) {
    const e = this.#find(id);
    const allowed = ['title', 'url', 'username', 'password', 'notes'];
    if (patch.password !== undefined && patch.password !== e.password) {
      e.history = [{ password: e.password, changedAt: Date.now() }, ...e.history].slice(0, HISTORY_MAX);
    }
    for (const k of allowed) if (patch[k] !== undefined) e[k] = patch[k];
    e.updatedAt = Date.now();
    return summary(e);
  }

  deleteEntry(id) {
    this.#find(id);
    this.data.entries = this.data.entries.filter((x) => x.id !== id);
    (this.data.deleted ??= {})[id] = Date.now(); // pierre tombale : la suppression se propage aux autres appareils
  }

  /** Entrée complète (mot de passe inclus) : à n'appeler que sur action explicite de l'utilisateur. */
  getEntry(id) {
    return structuredClone(this.#find(id));
  }

  /** Liste sans mots de passe ni notes, pour l'affichage. */
  list() {
    return this.data.entries.map(summary).sort((a, b) => a.title.localeCompare(b.title, 'fr'));
  }

  search(query) {
    const q = query.trim().toLowerCase();
    if (!q) return this.list();
    return this.list().filter((e) => [e.title, e.url, e.username].some((f) => f.toLowerCase().includes(q)));
  }

  /** Entrées proposables pour un site (jamais de correspondance partielle de nom de domaine). */
  forHost(tabHost) {
    return this.list().filter((e) => hostMatches(hostOf(e.url), tabHost.toLowerCase()));
  }

  // ----- Partage -----

  get identity() {
    return this.data.identity;
  }

  async myPublicCode() {
    return S.publicCode(this.identity.publicKey);
  }

  async myFingerprint() {
    return S.formatFingerprint(await S.fingerprint(this.identity.publicKey));
  }

  shareEntry(id, recipientCode, opts) {
    const e = this.#find(id);
    return S.createShare(this.identity, recipientCode, e, opts);
  }

  async importShare(code) {
    const { entry, sender } = await S.openShare(this.identity, code);
    const added = this.addEntry({ ...entry, source: { sharedBy: sender.fingerprint, at: Date.now() } });
    return { entry: added, senderFingerprint: S.formatFingerprint(sender.fingerprint) };
  }
}
