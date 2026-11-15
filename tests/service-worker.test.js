import test from 'node:test';
import assert from 'node:assert/strict';
import { installChrome } from '../dev/chrome-mock.js';

const mock = installChrome();
const { chrome } = mock;
await import('../src/background/service-worker.js');

const PW = 'correct horse battery staple';
const call = (msg) => chrome.runtime.sendMessage(msg);
const page = (msg, url, o = {}) => mock.fromContent(msg, { url, ...o });
const wait = () => new Promise((r) => setTimeout(r, 15));
let siteId;

test('sans coffre : état vide, mot de passe maître faible refusé', async () => {
  assert.deepEqual(await call({ type: 'state' }), { ok: true, exists: false, unlocked: false });
  assert.equal((await call({ type: 'create', password: 'court' })).code, 'WEAK_MASTER');
});

test('création, ajout et liste sans secrets', async () => {
  assert.equal((await call({ type: 'create', password: PW })).ok, true);
  assert.equal((await call({ type: 'state' })).unlocked, true);
  assert.equal((await call({ type: 'create', password: PW })).code, 'EXISTS');

  const add = await call({ type: 'add', entry: { title: 'Exemple', url: 'https://exemple.fr/login', username: 'cyril', password: 'S3cret-xyz' } });
  siteId = add.entry.id;
  await call({ type: 'add', entry: { title: 'Banque', url: 'mabanque.fr', username: 'cyril', password: 'autre' } });

  const { entries } = await call({ type: 'list', query: '' });
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.password === undefined));
  assert.equal((await call({ type: 'reveal', id: siteId })).entry.password, 'S3cret-xyz');
});

test('le stockage local ne contient aucun secret en clair', () => {
  const raw = JSON.stringify(chrome.storage.local.data);
  for (const s of ['Exemple', 'exemple.fr', 'S3cret-xyz', 'mabanque']) assert.ok(!raw.includes(s), s);
});

test('une page ne peut pas appeler les actions de la popup', async () => {
  const url = 'https://exemple.fr/login';
  assert.equal(await page({ type: 'reveal', id: siteId }, url), undefined);
  assert.equal(await page({ type: 'list', query: '' }, url), undefined);
  assert.equal(await page({ type: 'unlock', password: PW }, url), undefined);
});

test('la popup ne peut pas appeler les actions de page, ni une autre extension', async () => {
  assert.equal(await call({ type: 'fill', id: siteId }), undefined);
  assert.equal(await mock.fromOther({ type: 'state' }), undefined);
});

test('contenu : propositions limitées au bon domaine, HTTPS seulement', async () => {
  const ok = await page({ type: 'entries' }, 'https://www.exemple.fr/login');
  assert.deepEqual(ok.entries.map((e) => e.title), ['Exemple']);
  assert.equal((await page({ type: 'entries' }, 'https://login.exemple.fr/')).entries.length, 1);
  assert.equal((await page({ type: 'entries' }, 'https://evil-exemple.fr/')).entries.length, 0);
  assert.equal((await page({ type: 'entries' }, 'https://exemple.fr.evil.com/')).entries.length, 0);
  assert.equal((await page({ type: 'entries' }, 'http://exemple.fr/')).code, 'INSECURE');
  assert.equal((await page({ type: 'entries' }, 'https://exemple.fr/', { frameId: 3 })).code, 'BAD_FRAME');
});

test("contenu : fill refuse un identifiant d'un autre site", async () => {
  const good = await page({ type: 'fill', id: siteId }, 'https://exemple.fr/login');
  assert.deepEqual({ u: good.username, p: good.password }, { u: 'cyril', p: 'S3cret-xyz' });
  assert.equal((await page({ type: 'fill', id: siteId }, 'https://evil-exemple.fr/')).code, 'HOST_MISMATCH');
  assert.equal((await page({ type: 'fill', id: siteId }, 'http://exemple.fr/')).code, 'INSECURE');
});

test('capture : proposition, enregistrement, doublon ignoré', async () => {
  const url = 'https://nouveau.fr/connexion';
  await page({ type: 'captured', username: 'moi', password: 'pw-nouveau' }, url, { tabId: 7 });
  const p = await call({ type: 'pendingForTab', tabId: 7 });
  assert.deepEqual(p.pending, { host: 'nouveau.fr', username: 'moi', existingId: null });
  assert.ok(!JSON.stringify(p).includes('pw-nouveau'), 'le mot de passe ne revient pas à la popup');

  assert.equal((await call({ type: 'savePending', tabId: 7 })).entry.title, 'nouveau.fr');
  assert.equal((await call({ type: 'pendingForTab', tabId: 7 })).pending, null);

  await page({ type: 'captured', username: 'moi', password: 'pw-nouveau' }, url, { tabId: 7 });
  assert.equal((await call({ type: 'pendingForTab', tabId: 7 })).pending, null, 'identifiants déjà connus');
});

test('capture : changement de mot de passe → mise à jour avec historique', async () => {
  await page({ type: 'captured', username: 'moi', password: 'pw-v2' }, 'https://nouveau.fr/connexion', { tabId: 8 });
  const { pending } = await call({ type: 'pendingForTab', tabId: 8 });
  assert.ok(pending.existingId);
  const { entry } = await call({ type: 'savePending', tabId: 8 });
  const full = (await call({ type: 'reveal', id: entry.id })).entry;
  assert.equal(full.password, 'pw-v2');
  assert.equal(full.history[0].password, 'pw-nouveau');
});

test("capture : ignorer et fermeture d'onglet effacent la proposition", async () => {
  await page({ type: 'captured', username: 'a', password: 'x1' }, 'https://autre.fr/', { tabId: 9 });
  await call({ type: 'dismissPending', tabId: 9 });
  assert.equal((await call({ type: 'pendingForTab', tabId: 9 })).pending, null);
  await page({ type: 'captured', username: 'a', password: 'x1' }, 'https://autre.fr/', { tabId: 10 });
  mock.closeTab(10);
  await wait();
  assert.equal((await call({ type: 'pendingForTab', tabId: 10 })).pending, null);
});

test('réglages : validation du délai', async () => {
  assert.equal((await call({ type: 'setSettings', settings: { autoLockMinutes: 999 } })).code, 'BAD_SETTING');
  assert.equal((await call({ type: 'setSettings', settings: { autoLockMinutes: 'abc' } })).code, 'BAD_SETTING');
  assert.equal((await call({ type: 'setSettings', settings: { autoLockMinutes: 5 } })).ok, true);
  assert.equal((await call({ type: 'getSettings' })).settings.autoLockMinutes, 5);
});

test('verrouillage : alarme, accès refusés, rien de capturé, mauvais mot de passe', async () => {
  assert.ok(mock.alarms.has('autolock'), 'alarme armée');
  await page({ type: 'captured', username: 'z', password: 'zz' }, 'https://exemple.fr/', { tabId: 11 });
  mock.fireAlarm('autolock');
  await wait();

  assert.equal((await call({ type: 'state' })).unlocked, false);
  assert.equal((await call({ type: 'list', query: '' })).code, 'LOCKED');
  assert.equal((await call({ type: 'reveal', id: siteId })).code, 'LOCKED');
  assert.deepEqual(await page({ type: 'entries' }, 'https://exemple.fr/'), { ok: true, locked: true, exists: true, entries: [] });
  assert.equal((await page({ type: 'fill', id: siteId }, 'https://exemple.fr/')).code, 'LOCKED');
  await page({ type: 'captured', username: 'q', password: 'qq' }, 'https://exemple.fr/', { tabId: 12 });
  assert.equal(Object.keys(chrome.storage.session.data).filter((k) => k.startsWith('pending:')).length, 0);

  assert.equal((await call({ type: 'unlock', password: 'mauvais mot de passe' })).code, 'WRONG_PASSWORD');
  assert.equal((await call({ type: 'unlock', password: PW })).ok, true);
  assert.equal((await call({ type: 'list', query: '' })).entries.length, 3);
});

test('changement de mot de passe maître', async () => {
  assert.equal((await call({ type: 'changeMasterPassword', current: 'faux faux faux', next: 'nouveau mot de passe 1' })).code, 'WRONG_PASSWORD');
  assert.equal((await call({ type: 'changeMasterPassword', current: PW, next: 'nouveau mot de passe 1' })).ok, true);
  await call({ type: 'lock' });
  assert.equal((await call({ type: 'unlock', password: PW })).code, 'WRONG_PASSWORD');
  assert.equal((await call({ type: 'unlock', password: 'nouveau mot de passe 1' })).ok, true);
});

test('import : doublons ignorés, types invalides nettoyés, interdit aux pages', async () => {
  const count = async () => (await call({ type: 'list', query: '' })).entries.length;
  const before = await count();
  const rows = [
    { title: 'Imp', url: 'imp.fr', username: 'u', password: 'p' },
    { title: 'Imp', url: 'imp.fr', username: 'u', password: 'p' },
    { title: 42, url: {}, username: null, password: 'x' },
  ];
  const r = await call({ type: 'importEntries', entries: rows });
  assert.deepEqual({ added: r.added, duplicates: r.duplicates, invalid: r.invalid }, { added: 1, duplicates: 1, invalid: 1 });
  assert.equal(await count(), before + 1);
  assert.equal((await call({ type: 'importEntries', entries: 'pas une liste' })).code, 'BAD_IMPORT');
  assert.equal(await page({ type: 'importEntries', entries: rows }, 'https://exemple.fr/'), undefined);
});

test('partage via le service worker', async () => {
  const info = await call({ type: 'myShareInfo' });
  assert.match(info.code, /^coffre-pub:1:/);
  const { code } = await call({ type: 'shareEntry', id: siteId, recipientCode: info.code, ttlHours: 1 }); // à soi-même
  const res = await call({ type: 'importShare', code });
  assert.equal(res.ok, true);
  assert.equal(res.entry.title, 'Exemple');
});
