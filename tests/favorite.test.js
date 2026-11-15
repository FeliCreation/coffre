import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault } from '../src/core/vault.js';
import { syncVault } from '../src/core/sync.js';
import { fakeGithub } from './helpers/fake-github.js';

const FAST = { iterations: 1000 };
const PW = 'correct horse battery staple';

test('favoris : défaut faux, bascule, présent dans la liste, jamais de secret', async () => {
  const v = await Vault.create(PW, FAST);
  const { id } = v.addEntry({ title: 'Banque', password: 'secret-xyz' });
  assert.equal(v.list()[0].favorite, false);
  v.updateEntry(id, { favorite: true });
  assert.equal(v.list()[0].favorite, true);
  assert.equal(v.list()[0].password, undefined);
  v.updateEntry(id, { favorite: 0 }); // valeur « fausse » : toujours un booléen
  assert.strictEqual(v.getEntry(id).favorite, false);
  const before = v.getEntry(id).updatedAt;
  await new Promise((r) => setTimeout(r, 3));
  v.updateEntry(id, { favorite: true });
  assert.ok(v.getEntry(id).updatedAt > before); // le changement se propage par la synchro
});

test('favoris : propagés entre appareils par la synchro', async () => {
  const CFG = { repo: 'moi/donnees', token: 'github_pat_' + 'f'.repeat(30) };
  const gh = fakeGithub(CFG.token);
  const a = await Vault.create(PW, FAST);
  const { id } = a.addEntry({ title: 'Mail', password: 'p' });
  await syncVault(a, CFG, { fetchImpl: gh.fetch });
  const b = await Vault.unlock(JSON.parse(gh.file), PW);
  await new Promise((r) => setTimeout(r, 5));
  b.updateEntry(id, { favorite: true });
  await syncVault(b, CFG, { fetchImpl: gh.fetch });
  await syncVault(a, CFG, { fetchImpl: gh.fetch });
  assert.equal(a.list()[0].favorite, true);
});
