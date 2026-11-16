// « Rester connecté » : garde le coffre ouvert plusieurs jours sur CET appareil, sans retaper le mot de passe maître.
// La clé du coffre n'est jamais écrite en clair : elle est chiffrée par une clé d'appareil NON EXTRACTABLE
// (objet CryptoKey gardé dans IndexedDB : le code JavaScript peut l'utiliser mais jamais en lire les octets).
// Oublier l'appareil supprime cette clé : la copie chiffrée devient définitivement inutilisable.

import * as C from './crypto.js';

const AAD = 'coffre:remember:1';
const DAY_MS = 24 * 3600_000;
export const REMEMBER_CHOICES = Object.freeze([1, 7, 15, 30]);
export const REMEMBER_DEFAULT_DAYS = 15;

/** Stockage de la clé d'appareil en mémoire (tests, ou navigateur sans IndexedDB : la mémorisation ne survit alors pas au redémarrage). */
export function memoryKeyStore() {
  let key = null;
  return { get: async () => key, put: async (k) => void (key = k), clear: async () => void (key = null) };
}

/** Stockage persistant dans IndexedDB (la clé non extractable y est conservée telle quelle). */
export function idbKeyStore(name = 'coffre-device') {
  const open = () => new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const run = async (mode, fn) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction('keys', mode);
        const req = fn(t.objectStore('keys'));
        t.oncomplete = () => resolve(req.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: () => run('readonly', (s) => s.get('device')),
    put: (k) => run('readwrite', (s) => s.put(k, 'device')),
    clear: () => run('readwrite', (s) => s.delete('device')),
  };
}

export const defaultKeyStore = () => (typeof indexedDB !== 'undefined' ? idbKeyStore() : memoryKeyStore());

/**
 * Chiffre la clé du coffre (base64) avec une NOUVELLE clé d'appareil. Renvoie l'enregistrement à stocker
 * ({ wrapped, expiresAt }) : l'échéance est fixe, comptée à partir de la saisie du mot de passe maître.
 */
export async function createRemember(store, vaultKeyB64, days, now = Date.now()) {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new RangeError('Durée invalide (1 à 90 jours).');
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await store.put(key); // remplace l'éventuelle clé précédente : l'ancienne copie chiffrée devient inutilisable
  return { wrapped: await C.seal(key, C.fromB64(vaultKeyB64), AAD), expiresAt: now + days * DAY_MS };
}

/** Clé du coffre (base64) si l'enregistrement est valide et non expiré, sinon null (jamais d'exception). */
export async function openRemember(store, record, now = Date.now()) {
  if (!record?.wrapped || !(record.expiresAt > now)) return null;
  try {
    const key = await store.get();
    if (!key) return null;
    return C.toB64(await C.open(key, record.wrapped, AAD));
  } catch {
    return null;
  }
}

export async function forgetRemember(store) {
  try {
    await store.clear();
  } catch {}
}
