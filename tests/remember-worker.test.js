import test from 'node:test';
import assert from 'node:assert/strict';
import { installChrome } from '../dev/chrome-mock.js';

const mock = installChrome();
const { chrome } = mock;
await import('../src/background/service-worker.js');

const PW = 'correct horse battery staple';
const DAY = 24 * 3600_000;
const call = (msg) => chrome.runtime.sendMessage(msg);
const tick = () => new Promise((r) => setTimeout(r, 20));
/** Simule le redémarrage du navigateur : la mémoire de session est effacée, le stockage local reste. */
const restartBrowser = () => { for (const k of Object.keys(chrome.storage.session.data)) delete chrome.storage.session.data[k]; };

test('préparation : coffre créé puis verrouillé', async () => {
  await call({ type: 'create', password: PW });
  await call({ type: 'add', entry: { title: 'Banque', password: 'mdp-unique-123' } });
  await call({ type: 'lock' });
  assert.equal((await call({ type: 'state' })).unlocked, false);
});

test('sans « Rester connecté » : verrouillage par inactivité actif, redémarrage = mot de passe demandé', async () => {
  const r = await call({ type: 'unlock', password: PW });
  assert.equal(r.remembered, false);
  assert.equal(mock.alarms.has('autolock'), true);
  assert.equal((await call({ type: 'rememberStatus' })).active, false);
  restartBrowser();
  assert.equal((await call({ type: 'state' })).unlocked, false);
});

test('« Rester connecté » : durée de 15 jours par défaut, clé jamais en clair dans le stockage', async () => {
  assert.equal((await call({ type: 'getSettings' })).settings.rememberDays, 15);
  const before = Date.now();
  const r = await call({ type: 'unlock', password: PW, remember: true });
  assert.equal(r.remembered, true);
  const st = await call({ type: 'rememberStatus' });
  assert.equal(st.active, true);
  assert.ok(st.expiresAt >= before + 15 * DAY && st.expiresAt <= Date.now() + 15 * DAY);
  const sessionKey = chrome.storage.session.data.sessionKey;
  assert.ok(sessionKey);
  assert.ok(!JSON.stringify(chrome.storage.local.data).includes(sessionKey), 'la clé du coffre ne doit jamais être écrite en clair');
});

test('appareil mémorisé : pas de verrouillage par inactivité, redémarrage du navigateur sans mot de passe', async () => {
  assert.equal(mock.alarms.has('autolock'), false);
  mock.fireAlarm('autolock'); // même si une alarme tardive se déclenche
  await tick();
  assert.equal((await call({ type: 'state' })).unlocked, true);

  restartBrowser();
  assert.equal(chrome.storage.session.data.sessionKey, undefined);
  const s = await call({ type: 'state' });
  assert.equal(s.unlocked, true);
  assert.equal((await call({ type: 'list', query: '' })).entries[0].title, 'Banque');
  assert.ok(chrome.storage.session.data.sessionKey); // session rétablie
  assert.equal((await call({ type: 'reveal', id: (await call({ type: 'list', query: '' })).entries[0].id })).entry.password, 'mdp-unique-123');
});

test('les pages web ne peuvent pas interroger la mémorisation', async () => {
  assert.equal(await mock.fromContent({ type: 'rememberStatus' }, { url: 'https://exemple.fr/' }), undefined);
});

test('échéance dépassée : verrouillé, enregistrement supprimé', async () => {
  chrome.storage.local.data.remember.expiresAt = Date.now() - 1000;
  assert.equal((await call({ type: 'state' })).unlocked, false);
  assert.equal(chrome.storage.local.data.remember, undefined);
  assert.equal(chrome.storage.session.data.sessionKey, undefined);
  assert.equal((await call({ type: 'list', query: '' })).code, 'LOCKED');
});

test('enregistrement altéré : verrouillé et supprimé (jamais d\'ouverture avec des données douteuses)', async () => {
  await call({ type: 'unlock', password: PW, remember: true });
  const ct = chrome.storage.local.data.remember.wrapped.ct;
  chrome.storage.local.data.remember.wrapped.ct = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
  restartBrowser();
  assert.equal((await call({ type: 'state' })).unlocked, false);
  assert.equal(chrome.storage.local.data.remember, undefined);
});

test('« Verrouiller » exige vraiment le mot de passe : il oublie aussi l\'appareil', async () => {
  await call({ type: 'unlock', password: PW, remember: true });
  await call({ type: 'lock' });
  assert.equal((await call({ type: 'rememberStatus' })).active, false);
  restartBrowser();
  assert.equal((await call({ type: 'state' })).unlocked, false);
});

test('durée réglable (1, 7, 15, 30 jours), valeurs refusées', async () => {
  for (const bad of [0, 2, 365, 'abc']) assert.equal((await call({ type: 'setSettings', settings: { rememberDays: bad } })).code, 'BAD_SETTING', String(bad));
  assert.equal((await call({ type: 'setSettings', settings: { rememberDays: 7 } })).ok, true);
  await call({ type: 'unlock', password: PW, remember: true });
  const { expiresAt } = await call({ type: 'rememberStatus' });
  assert.ok(expiresAt <= Date.now() + 7 * DAY && expiresAt > Date.now() + 6 * DAY);
  assert.equal((await call({ type: 'getSettings' })).settings.autoLockMinutes, 15); // autres réglages préservés
});

test('changer le mot de passe maître révoque la mémorisation', async () => {
  assert.equal((await call({ type: 'rememberStatus' })).active, true);
  assert.equal((await call({ type: 'changeMasterPassword', current: PW, next: 'nouveau mot de passe 42' })).ok, true);
  assert.equal((await call({ type: 'rememberStatus' })).active, false);
  restartBrowser();
  assert.equal((await call({ type: 'state' })).unlocked, false);
});

test('mauvais mot de passe : aucune mémorisation créée', async () => {
  assert.equal((await call({ type: 'unlock', password: PW, remember: true })).code, 'WRONG_PASSWORD');
  assert.equal((await call({ type: 'rememberStatus' })).active, false);
});
