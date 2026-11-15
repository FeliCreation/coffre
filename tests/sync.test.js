import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault } from '../src/core/vault.js';
import { syncVault, fetchRemoteVault } from '../src/core/sync.js';
import { checkConfig } from '../src/core/github.js';
import { fakeGithub } from './helpers/fake-github.js';

const FAST = { iterations: 1000 };
const PW = 'correct horse battery staple';
const CFG = { repo: 'moi/coffre-donnees', token: 'github_pat_' + 'x'.repeat(30) };

/** Deuxième appareil : même coffre (même clé) reconstruit depuis le fichier distant. */
async function secondDevice(gh) {
  const stored = JSON.parse(gh.file);
  return Vault.unlock(stored, PW);
}

test('première synchro : le coffre chiffré est créé dans le dépôt, sans secret en clair', async () => {
  const gh = fakeGithub(CFG.token);
  const v = await Vault.create(PW, FAST);
  v.addEntry({ title: 'Banque', url: 'mabanque.fr', username: 'cyril-unique', password: 'mdp-unique-xyz' });
  assert.deepEqual(await syncVault(v, CFG, { fetchImpl: gh.fetch }), { pulled: false, pushed: true });
  for (const s of ['Banque', 'mabanque', 'cyril-unique', 'mdp-unique-xyz', CFG.token]) assert.ok(!gh.file.includes(s), s);
});

test("un nouvel appareil récupère le coffre avec le mot de passe maître et voit les identifiants", async () => {
  const gh = fakeGithub(CFG.token);
  const a = await Vault.create(PW, FAST);
  a.addEntry({ title: 'Mail', password: 'p1' });
  await syncVault(a, CFG, { fetchImpl: gh.fetch });
  const remote = await fetchRemoteVault(CFG, { fetchImpl: gh.fetch });
  const b = await Vault.unlock(remote, PW);
  assert.equal(b.getEntry(b.list()[0].id).password, 'p1');
});

test('fusion : ajouts des deux côtés conservés, modification la plus récente gagne', async () => {
  const gh = fakeGithub(CFG.token);
  const a = await Vault.create(PW, FAST);
  const { id } = a.addEntry({ title: 'Commun', password: 'v1' });
  await syncVault(a, CFG, { fetchImpl: gh.fetch });
  const b = await secondDevice(gh);

  a.addEntry({ title: 'Seulement A', password: 'a' });
  b.addEntry({ title: 'Seulement B', password: 'b' });
  await new Promise((r) => setTimeout(r, 5));
  b.updateEntry(id, { password: 'v2-par-B' });

  await syncVault(a, CFG, { fetchImpl: gh.fetch });
  await syncVault(b, CFG, { fetchImpl: gh.fetch });
  await syncVault(a, CFG, { fetchImpl: gh.fetch });

  for (const v of [a, b]) {
    assert.deepEqual(v.list().map((e) => e.title), ['Commun', 'Seulement A', 'Seulement B']);
    assert.equal(v.getEntry(id).password, 'v2-par-B');
  }
});

test('une suppression se propage, mais une modification postérieure la fait échouer', async () => {
  const gh = fakeGithub(CFG.token);
  const a = await Vault.create(PW, FAST);
  const { id: x } = a.addEntry({ title: 'À supprimer', password: '1' });
  const { id: y } = a.addEntry({ title: 'Ressuscitée', password: '1' });
  await syncVault(a, CFG, { fetchImpl: gh.fetch });
  const b = await secondDevice(gh);

  await new Promise((r) => setTimeout(r, 5));
  a.deleteEntry(x);
  a.deleteEntry(y);
  await new Promise((r) => setTimeout(r, 5));
  b.updateEntry(y, { password: '2' }); // modifiée sur B après la suppression sur A

  await syncVault(a, CFG, { fetchImpl: gh.fetch });
  await syncVault(b, CFG, { fetchImpl: gh.fetch });
  await syncVault(a, CFG, { fetchImpl: gh.fetch });

  for (const v of [a, b]) assert.deepEqual(v.list().map((e) => e.title), ['Ressuscitée']);
});

test('changement de mot de passe maître propagé (en-tête le plus récent)', async () => {
  const gh = fakeGithub(CFG.token);
  const a = await Vault.create(PW, FAST);
  a.addEntry({ title: 'A', password: 'x' });
  await syncVault(a, CFG, { fetchImpl: gh.fetch });
  const b = await secondDevice(gh);

  await new Promise((r) => setTimeout(r, 5));
  await a.changeMasterPassword('nouveau mot de passe 42', FAST);
  await syncVault(a, CFG, { fetchImpl: gh.fetch });
  await syncVault(b, CFG, { fetchImpl: gh.fetch }); // B ne doit pas écraser l'en-tête de A

  await assert.rejects(Vault.unlock(JSON.parse(gh.file), PW), { code: 'WRONG_PASSWORD' });
  assert.equal((await Vault.unlock(JSON.parse(gh.file), 'nouveau mot de passe 42')).list().length, 1);
  await syncVault(b, CFG, { fetchImpl: gh.fetch });
  assert.equal((await Vault.unlock(await b.serialize(), 'nouveau mot de passe 42')).list().length, 1);
});

test('conflit d\'écriture : la synchro reprend et aboutit', async () => {
  let armed = false;
  let interfered = 0;
  const gh = fakeGithub(CFG.token, {
    onPut(s) {
      if (!armed || interfered) return;
      interfered++;
      s.sha++; // quelqu'un d'autre écrit entre notre lecture et notre écriture
    },
  });
  const a = await Vault.create(PW, FAST);
  await syncVault(a, CFG, { fetchImpl: gh.fetch });
  const b = await secondDevice(gh);
  b.addEntry({ title: 'B', password: 'b' });
  armed = true;
  await syncVault(b, CFG, { fetchImpl: gh.fetch });
  assert.equal(interfered, 1);
  assert.equal(gh.calls.filter((c) => c.startsWith('PUT')).length, 3); // création, tentative en conflit, reprise
  assert.equal((await secondDevice(gh)).list().length, 1);
});

test('coffre d\'un autre utilisateur ou altéré : refusé sans rien écraser', async () => {
  const gh = fakeGithub(CFG.token);
  const a = await Vault.create(PW, FAST);
  a.addEntry({ title: 'A', password: 'x' });
  await syncVault(a, CFG, { fetchImpl: gh.fetch });
  const before = gh.file;
  const autre = await Vault.create(PW, FAST);
  await assert.rejects(syncVault(autre, CFG, { fetchImpl: gh.fetch }), { code: 'DIFFERENT_VAULT' });
  assert.equal(gh.file, before);
});

test('erreurs GitHub : dépôt absent, jeton refusé, réseau', async () => {
  const v = await Vault.create(PW, FAST);
  await assert.rejects(syncVault(v, CFG, { fetchImpl: fakeGithub(CFG.token, { repoExists: false }).fetch }), { code: 'NO_REPO' });
  const res = (status) => async () => ({ status, ok: false, json: async () => ({}) });
  await assert.rejects(syncVault(v, CFG, { fetchImpl: res(401) }), { code: 'AUTH' });
  await assert.rejects(syncVault(v, CFG, { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), { code: 'NETWORK' });
});

test('configuration validée', () => {
  assert.throws(() => checkConfig({ repo: 'pas-un-depot', token: CFG.token }), { code: 'BAD_REPO' });
  assert.throws(() => checkConfig({ repo: '../x/y', token: CFG.token }), { code: 'BAD_REPO' });
  assert.throws(() => checkConfig({ repo: 'a/b', token: 'court' }), { code: 'BAD_TOKEN' });
  assert.throws(() => checkConfig({ repo: 'a/b', token: CFG.token, path: '../../x' }), { code: 'BAD_PATH' });
  assert.equal(checkConfig({ repo: 'a/b', token: `  ${CFG.token}  ` }).token, CFG.token);
});
