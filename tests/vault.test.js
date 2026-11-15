import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault, VaultError, hostOf, hostMatches, siteUrl } from '../src/core/vault.js';

test('siteUrl : normalise les adresses web, refuse tout le reste', () => {
  assert.equal(siteUrl('exemple.fr'), 'https://exemple.fr/');
  assert.equal(siteUrl(' https://www.exemple.fr/login?a=1 '), 'https://www.exemple.fr/login?a=1');
  assert.equal(siteUrl('http://exemple.fr'), 'http://exemple.fr/');
  assert.equal(siteUrl('localhost:3000'), 'https://localhost:3000/');
  for (const bad of ['', '   ', null, undefined, 'javascript:alert(1)', 'file:///C:/x', 'ftp://exemple.fr', 'mailto:a@b.fr', 'data:text/html,x', 'chrome://settings', 'https://exemple.fr@evil.com', 'user:pass@evil.com']) {
    assert.equal(siteUrl(bad), null, String(bad));
  }
});

const FAST = { iterations: 1000 }; // PBKDF2 réduit : tests rapides seulement
const PW = 'correct horse battery staple';

test('création, ajout, sérialisation et réouverture', async () => {
  const v = await Vault.create(PW, FAST);
  v.addEntry({ title: 'Banque', url: 'https://www.mabanque.fr/login', username: 'cyril', password: 's3cret!' });
  const stored = JSON.parse(JSON.stringify(await v.serialize()));

  const v2 = await Vault.unlock(stored, PW);
  assert.equal(v2.list().length, 1);
  assert.equal(v2.getEntry(v2.list()[0].id).password, 's3cret!');
});

test('le stockage ne contient aucun secret en clair', async () => {
  const v = await Vault.create(PW, FAST);
  v.addEntry({ title: 'Banque', url: 'mabanque.fr', username: 'cyril-unique', password: 'mdp-unique-xyz' });
  const raw = JSON.stringify(await v.serialize());
  for (const s of ['Banque', 'mabanque', 'cyril-unique', 'mdp-unique-xyz']) assert.ok(!raw.includes(s), s);
});

test('mauvais mot de passe refusé', async () => {
  const v = await Vault.create(PW, FAST);
  const stored = await v.serialize();
  await assert.rejects(Vault.unlock(stored, 'mauvais mot de passe'), { code: 'WRONG_PASSWORD' });
});

test('mot de passe maître trop court refusé', async () => {
  await assert.rejects(Vault.create('court', FAST), { code: 'WEAK_MASTER' });
});

test('données altérées détectées', async () => {
  const v = await Vault.create(PW, FAST);
  v.addEntry({ title: 'A', password: 'x' });
  const stored = await v.serialize();
  const bytes = Buffer.from(stored.data.ct, 'base64');
  bytes[0] ^= 1;
  stored.data.ct = bytes.toString('base64');
  await assert.rejects(Vault.unlock(stored, PW), { code: 'CORRUPTED' });
});

test('chaque sérialisation utilise un IV neuf', async () => {
  const v = await Vault.create(PW, FAST);
  const a = await v.serialize();
  const b = await v.serialize();
  assert.notEqual(a.data.iv, b.data.iv);
});

test('changement de mot de passe maître', async () => {
  const v = await Vault.create(PW, FAST);
  v.addEntry({ title: 'A', password: 'x' });
  await v.changeMasterPassword('nouveau mot de passe 42', FAST);
  const stored = await v.serialize();
  await assert.rejects(Vault.unlock(stored, PW), { code: 'WRONG_PASSWORD' });
  const v2 = await Vault.unlock(stored, 'nouveau mot de passe 42');
  assert.equal(v2.list().length, 1);
});

test('réouverture par clé de session', async () => {
  const v = await Vault.create(PW, FAST);
  v.addEntry({ title: 'A', password: 'x' });
  const stored = await v.serialize();
  const v2 = await Vault.fromSessionKey(stored, await v.sessionKey());
  assert.equal(v2.list()[0].title, 'A');
});

test('liste et recherche ne divulguent ni mot de passe ni notes', async () => {
  const v = await Vault.create(PW, FAST);
  v.addEntry({ title: 'Mail', url: 'mail.exemple.fr', username: 'moi', password: 'pw', notes: 'secret' });
  const [e] = v.search('mail');
  assert.equal(e.password, undefined);
  assert.equal(e.notes, undefined);
  assert.equal(e.hasNotes, true);
});

test('historique des mots de passe limité à 5', async () => {
  const v = await Vault.create(PW, FAST);
  const { id } = v.addEntry({ title: 'A', password: 'p0' });
  for (let i = 1; i <= 7; i++) v.updateEntry(id, { password: `p${i}` });
  const e = v.getEntry(id);
  assert.equal(e.password, 'p7');
  assert.equal(e.history.length, 5);
  assert.equal(e.history[0].password, 'p6');
});

test('suppression et entrée introuvable', async () => {
  const v = await Vault.create(PW, FAST);
  const { id } = v.addEntry({ title: 'A' });
  v.deleteEntry(id);
  assert.equal(v.list().length, 0);
  assert.throws(() => v.getEntry(id), VaultError);
});

test('correspondance de domaine : sous-domaines oui, domaines voisins non', () => {
  assert.equal(hostOf('https://www.Exemple.fr/a?b'), 'exemple.fr');
  assert.equal(hostOf('exemple.fr'), 'exemple.fr');
  assert.equal(hostMatches('exemple.fr', 'exemple.fr'), true);
  assert.equal(hostMatches('exemple.fr', 'login.exemple.fr'), true);
  assert.equal(hostMatches('exemple.fr', 'evil-exemple.fr'), false);
  assert.equal(hostMatches('exemple.fr', 'exemple.fr.evil.com'), false);
  assert.equal(hostMatches('login.exemple.fr', 'exemple.fr'), false);
  assert.equal(hostMatches('', 'exemple.fr'), false);
});

test('forHost ne propose que les entrées du bon site', async () => {
  const v = await Vault.create(PW, FAST);
  v.addEntry({ title: 'Bon', url: 'exemple.fr' });
  v.addEntry({ title: 'Piège', url: 'evil-exemple.fr' });
  assert.deepEqual(v.forHost('www.exemple.fr').map((e) => e.title), ['Bon']);
});
