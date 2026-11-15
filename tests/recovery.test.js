import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault } from '../src/core/vault.js';
import { newRecoveryCode, normalizeRecoveryCode } from '../src/core/recovery.js';
import { toCsv, parseBackup } from '../src/core/export.js';
import { parseExport } from '../src/core/import.js';
import { syncVault } from '../src/core/sync.js';
import { fakeGithub } from './helpers/fake-github.js';

const FAST = { iterations: 1000 };
const PW = 'correct horse battery staple';

test('code de récupération : format, unicité, saisie tolérante', () => {
  const a = newRecoveryCode();
  assert.match(a, /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
  assert.notEqual(a, newRecoveryCode());
  assert.equal(normalizeRecoveryCode(a.toLowerCase().replaceAll('-', ' ')), a.replaceAll('-', ''));
  for (const bad of ['', 'ABCD', 'A'.repeat(31), '1'.repeat(32), null]) assert.equal(normalizeRecoveryCode(bad), null);
});

test('le kit rouvre le coffre sans le mot de passe maître, puis on en choisit un nouveau', async () => {
  const v = await Vault.create(PW, FAST);
  v.addEntry({ title: 'Mail', password: 'p1' });
  assert.equal(v.hasRecovery, false);
  const code = await v.createRecoveryKit(FAST);
  assert.equal(v.hasRecovery, true);
  const stored = JSON.parse(JSON.stringify(await v.serialize()));

  const r = await Vault.unlockWithRecovery(stored, code.toLowerCase());
  assert.equal(r.list().length, 1);
  await r.changeMasterPassword('nouveau mot de passe 42', FAST);
  const after = JSON.parse(JSON.stringify(await r.serialize()));
  assert.equal((await Vault.unlock(after, 'nouveau mot de passe 42')).list().length, 1);
  await assert.rejects(Vault.unlock(after, PW), { code: 'WRONG_PASSWORD' });
  assert.equal((await Vault.unlockWithRecovery(after, code)).list().length, 1); // le kit survit au changement de mot de passe
});

test('mauvais code, coffre sans kit, ancien code après régénération', async () => {
  const v = await Vault.create(PW, FAST);
  await assert.rejects(Vault.unlockWithRecovery(await v.serialize(), newRecoveryCode()), { code: 'NO_RECOVERY' });
  const old = await v.createRecoveryKit(FAST);
  await assert.rejects(Vault.unlockWithRecovery(await v.serialize(), newRecoveryCode()), { code: 'WRONG_RECOVERY' });
  await assert.rejects(Vault.unlockWithRecovery(await v.serialize(), 'trop court'), { code: 'WRONG_RECOVERY' });
  const fresh = await v.createRecoveryKit(FAST);
  await assert.rejects(Vault.unlockWithRecovery(await v.serialize(), old), { code: 'WRONG_RECOVERY' });
  assert.ok(await Vault.unlockWithRecovery(await v.serialize(), fresh));
});

test('le code de récupération et la clé ne sont jamais en clair dans le stockage', async () => {
  const v = await Vault.create(PW, FAST);
  const code = await v.createRecoveryKit(FAST);
  const raw = JSON.stringify(await v.serialize());
  assert.ok(!raw.includes(code) && !raw.includes(code.replaceAll('-', '')));
});

test('le kit se propage aux autres appareils par la synchro', async () => {
  const CFG = { repo: 'moi/donnees', token: 'github_pat_' + 'k'.repeat(30) };
  const gh = fakeGithub(CFG.token);
  const a = await Vault.create(PW, FAST);
  await syncVault(a, CFG, { fetchImpl: gh.fetch });
  const b = await Vault.unlock(JSON.parse(gh.file), PW);
  await new Promise((r) => setTimeout(r, 5));
  const code = await a.createRecoveryKit(FAST);
  await syncVault(a, CFG, { fetchImpl: gh.fetch });
  await syncVault(b, CFG, { fetchImpl: gh.fetch });
  assert.equal(b.hasRecovery, true);
  assert.ok(await Vault.unlockWithRecovery(JSON.parse(JSON.stringify(await b.serialize())), code));
});

test('export CSV : champs piégés, ré-import identique', async () => {
  const entries = [
    { title: 'Banque, "principale"', url: 'https://mabanque.fr/x?a=1,2', username: 'cyril', password: 'p"w,d\n=2+2', notes: 'ligne1\r\nligne2' },
    { title: 'Simple', url: 'exemple.fr', username: '', password: 'x', notes: '' },
  ];
  const csv = toCsv(entries);
  assert.ok(csv.startsWith('name,url,username,password,note\r\n'));
  const back = await parseExport(new TextEncoder().encode(csv), 'export.csv');
  assert.equal(back.format, 'chrome');
  assert.equal(back.entries.length, 2);
  assert.equal(back.entries[0].title, entries[0].title);
  assert.equal(back.entries[0].password, entries[0].password);
  assert.equal(back.entries[0].notes, 'ligne1\nligne2');
});

test('sauvegarde : seul un vrai coffre chiffré est accepté', async () => {
  const v = await Vault.create(PW, FAST);
  const text = JSON.stringify(await v.serialize());
  assert.equal(parseBackup(text).v, 1);
  for (const bad of ['', 'pas du json', '{}', '{"v":1}', JSON.stringify({ ...JSON.parse(text), data: {} })]) {
    assert.throws(() => parseBackup(bad), { code: 'BAD_BACKUP' }, bad.slice(0, 20));
  }
});
