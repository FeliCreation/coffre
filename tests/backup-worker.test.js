import test from 'node:test';
import assert from 'node:assert/strict';
import { installChrome } from '../dev/chrome-mock.js';

const mock = installChrome();
const { chrome } = mock;
await import('../src/background/service-worker.js');

const PW = 'correct horse battery staple';
const call = (msg) => chrome.runtime.sendMessage(msg);
let backup;
let code;

test('export CSV : redemande le mot de passe maître, refusé aux pages web', async () => {
  await call({ type: 'create', password: PW });
  await call({ type: 'add', entry: { title: 'Banque', url: 'mabanque.fr', username: 'cyril', password: 'mdp-unique-1' } });
  await call({ type: 'add', entry: { title: 'Mail', url: 'mail.exemple.fr', username: 'moi', password: 'mdp-unique-2' } });

  assert.equal((await call({ type: 'exportCsv', password: 'mauvais mot de passe' })).code, 'WRONG_PASSWORD');
  const r = await call({ type: 'exportCsv', password: PW });
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.match(r.filename, /^coffre-export-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.ok(r.csv.includes('mdp-unique-1') && r.csv.includes('mail.exemple.fr'));
  assert.equal(await mock.fromContent({ type: 'exportCsv', password: PW }, { url: 'https://exemple.fr/' }), undefined);
});

test('kit de récupération : création protégée par le mot de passe, code jamais stocké', async () => {
  assert.equal((await call({ type: 'recoveryStatus' })).has, false);
  assert.equal((await call({ type: 'createRecovery', password: 'mauvais mot de passe' })).code, 'WRONG_PASSWORD');
  const r = await call({ type: 'createRecovery', password: PW });
  code = r.code;
  assert.match(code, /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
  assert.equal((await call({ type: 'recoveryStatus' })).has, true);
  const raw = JSON.stringify(chrome.storage.local.data) + JSON.stringify(chrome.storage.session.data);
  assert.ok(!raw.includes(code) && !raw.includes(code.replaceAll('-', '')));
});

test('sauvegarde chiffrée : sans secret en clair', async () => {
  const r = await call({ type: 'exportBackup' });
  backup = r.json;
  assert.match(r.filename, /^coffre-sauvegarde-/);
  for (const s of ['Banque', 'mabanque', 'mdp-unique-1', code]) assert.ok(!backup.includes(s), s);
});

test('appareil neuf : restauration, mauvais fichiers refusés, puis déverrouillage', async () => {
  await call({ type: 'lock' });
  assert.equal((await call({ type: 'restoreBackup', json: backup })).code, 'EXISTS');
  for (const k of Object.keys(chrome.storage.local.data)) delete chrome.storage.local.data[k];

  for (const bad of ['', 'pas du json', '{}', 42]) assert.equal((await call({ type: 'restoreBackup', json: bad })).code, 'BAD_BACKUP');
  assert.equal((await call({ type: 'state' })).exists, false);
  assert.equal((await call({ type: 'restoreBackup', json: backup })).ok, true);
  assert.equal((await call({ type: 'unlock', password: 'mauvais mot de passe' })).code, 'WRONG_PASSWORD');
  assert.equal((await call({ type: 'unlock', password: PW })).ok, true);
  assert.equal((await call({ type: 'list', query: '' })).entries.length, 2);
});

test('mot de passe oublié : le kit rouvre le coffre, ancien mot de passe invalide, kit conservé', async () => {
  await call({ type: 'lock' });
  assert.equal((await call({ type: 'recover', code: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH', newPassword: 'nouveau mot de passe 42' })).code, 'WRONG_RECOVERY');
  assert.equal((await call({ type: 'recover', code, newPassword: 'court' })).code, 'WEAK_MASTER');
  assert.equal((await call({ type: 'state' })).unlocked, false);

  assert.equal((await call({ type: 'recover', code: code.toLowerCase(), newPassword: 'nouveau mot de passe 42' })).ok, true);
  assert.equal((await call({ type: 'state' })).unlocked, true);
  assert.equal((await call({ type: 'list', query: '' })).entries.length, 2);

  await call({ type: 'lock' });
  assert.equal((await call({ type: 'unlock', password: PW })).code, 'WRONG_PASSWORD');
  assert.equal((await call({ type: 'unlock', password: 'nouveau mot de passe 42' })).ok, true);
  assert.equal((await call({ type: 'recoveryStatus' })).has, true);
});
