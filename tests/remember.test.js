import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryKeyStore, createRemember, openRemember, forgetRemember, REMEMBER_CHOICES } from '../src/core/remember.js';
import * as C from '../src/core/crypto.js';

const DAY = 24 * 3600_000;
const vaultKey = () => C.toB64(C.randomBytes(32));

test('mémorisation : aller-retour, échéance fixe, jamais la clé en clair', async () => {
  const store = memoryKeyStore();
  const key = vaultKey();
  const now = 1_000_000;
  const rec = await createRemember(store, key, 15, now);
  assert.equal(rec.expiresAt, now + 15 * DAY);
  assert.ok(!JSON.stringify(rec).includes(key));
  assert.equal(await openRemember(store, rec, now + 14 * DAY), key);
  assert.equal(await openRemember(store, rec, now + 15 * DAY), null); // expirée pile à l'échéance
  assert.equal(await openRemember(store, rec, now + 16 * DAY), null);
});

test("la clé d'appareil n'est pas extractable : le code ne peut jamais en lire les octets", async () => {
  const store = memoryKeyStore();
  await createRemember(store, vaultKey(), 1);
  const k = await store.get();
  assert.equal(k.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', k));
});

test("oublier l'appareil rend la copie chiffrée définitivement inutilisable", async () => {
  const store = memoryKeyStore();
  const key = vaultKey();
  const rec = await createRemember(store, key, 15);
  await forgetRemember(store);
  assert.equal(await openRemember(store, rec), null);
  // même si une nouvelle clé d'appareil est créée plus tard, l'ancienne copie ne se rouvre pas
  await createRemember(store, vaultKey(), 15);
  assert.equal(await openRemember(store, rec), null);
});

test('données altérées, enregistrement absent ou invalide : null, sans exception', async () => {
  const store = memoryKeyStore();
  const rec = await createRemember(store, vaultKey(), 15);
  const bytes = C.fromB64(rec.wrapped.ct);
  bytes[0] ^= 1;
  assert.equal(await openRemember(store, { ...rec, wrapped: { ...rec.wrapped, ct: C.toB64(bytes) } }), null);
  for (const bad of [null, undefined, {}, { wrapped: rec.wrapped }, { wrapped: rec.wrapped, expiresAt: 'demain' }]) assert.equal(await openRemember(store, bad), null);
  assert.equal(await openRemember(memoryKeyStore(), rec), null); // autre appareil : pas de clé d'appareil
});

test('durées refusées hors limites', async () => {
  for (const d of [0, -1, 1.5, 91, NaN]) await assert.rejects(createRemember(memoryKeyStore(), vaultKey(), d), RangeError, String(d));
  assert.deepEqual([...REMEMBER_CHOICES], [1, 7, 15, 30]);
});
