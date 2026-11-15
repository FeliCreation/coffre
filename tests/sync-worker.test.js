import test from 'node:test';
import assert from 'node:assert/strict';
import { installChrome } from '../dev/chrome-mock.js';
import { fakeGithub } from './helpers/fake-github.js';

const mock = installChrome();
const { chrome } = mock;
await import('../src/background/service-worker.js');

const PW = 'correct horse battery staple';
const REPO = 'moi/coffre-donnees';
const TOKEN = 'github_pat_' + 'y'.repeat(30);
const call = (msg) => chrome.runtime.sendMessage(msg);
const settle = () => new Promise((r) => setTimeout(r, 40));
const gh = fakeGithub(TOKEN);
globalThis.fetch = gh.fetch;

test('activer la synchro : coffre créé dans le dépôt, jeton absent du fichier et de la réponse', async () => {
  await call({ type: 'create', password: PW });
  await call({ type: 'add', entry: { title: 'Mail', url: 'mail.exemple.fr', username: 'moi', password: 'motdepasse-unique' } });
  assert.equal((await call({ type: 'syncStatus' })).configured, false);

  assert.equal((await call({ type: 'syncSetup', repo: 'pas bon', token: TOKEN })).code, 'BAD_REPO');
  const res = await call({ type: 'syncSetup', repo: REPO, token: TOKEN });
  assert.equal(res.ok, true);
  const st = await call({ type: 'syncStatus' });
  assert.equal(st.configured, true);
  assert.equal(st.repo, REPO);
  assert.ok(!JSON.stringify(st).includes(TOKEN));
  assert.ok(gh.file);
  for (const s of ['Mail', 'motdepasse-unique', TOKEN]) assert.ok(!gh.file.includes(s), s);
  assert.ok(!JSON.stringify(chrome.storage.local.data).includes(TOKEN)); // le jeton est dans la partie chiffrée
});

test('chaque modification est envoyée automatiquement', async () => {
  const before = gh.sha;
  await call({ type: 'add', entry: { title: 'Banque', url: 'mabanque.fr', password: 'autre-mdp' } });
  await settle();
  assert.ok(gh.sha > before);
});

test("nouvel appareil : on rejoint avec dépôt + jeton, puis le mot de passe maître suffit", async () => {
  await call({ type: 'lock' });
  for (const k of Object.keys(chrome.storage.local.data)) delete chrome.storage.local.data[k]; // appareil vierge

  assert.equal((await call({ type: 'state' })).exists, false);
  assert.equal((await call({ type: 'syncJoin', repo: REPO, token: 'github_pat_' + 'z'.repeat(30) })).ok, true); // jeton quelconque : le faux serveur l'accepte
  assert.equal((await call({ type: 'state' })).exists, true);
  assert.equal((await call({ type: 'syncJoin', repo: REPO, token: TOKEN })).code, 'EXISTS');
  assert.equal((await call({ type: 'unlock', password: 'mauvais mot de passe' })).code, 'WRONG_PASSWORD');
  assert.equal((await call({ type: 'unlock', password: PW })).ok, true);

  const { entries } = await call({ type: 'list', query: '' });
  assert.deepEqual(entries.map((e) => e.title), ['Banque', 'Mail']);
  assert.equal((await call({ type: 'syncStatus' })).configured, true);
});

test('une entrée ajoutée ailleurs arrive à la synchro manuelle ; une suppression aussi', async () => {
  // Autre appareil simulé : on modifie directement le fichier distant avec la même clé.
  const { Vault } = await import('../src/core/vault.js');
  const other = await Vault.unlock(JSON.parse(gh.file), PW);
  other.addEntry({ title: 'Ajout distant', password: 'x' });
  const banque = other.list().find((e) => e.title === 'Banque');
  await new Promise((r) => setTimeout(r, 5));
  other.deleteEntry(banque.id);
  gh.file = JSON.stringify(await other.serialize());
  gh.sha++;

  assert.equal((await call({ type: 'syncNow' })).ok, true);
  const { entries } = await call({ type: 'list', query: '' });
  assert.deepEqual(entries.map((e) => e.title), ['Ajout distant', 'Mail']);
});

test('échec réseau : mémorisé, visible dans l\'état, le coffre reste utilisable', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('hors ligne'); };
  const r = await call({ type: 'syncNow' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NETWORK');
  assert.equal((await call({ type: 'syncStatus' })).last.ok, false);
  assert.equal((await call({ type: 'add', entry: { title: 'Hors ligne', password: 'y' } })).ok, true);
  await settle();
  globalThis.fetch = real;
  assert.equal((await call({ type: 'syncNow' })).ok, true); // rattrape au retour de la connexion
  assert.ok(JSON.parse(JSON.stringify(gh.file)).length > 0);
});

test('verrouillé : aucune action de synchro ; une page web ne peut pas les appeler ; désactivation', async () => {
  assert.equal(await mock.fromContent({ type: 'syncNow' }, { url: 'https://exemple.fr/' }), undefined); // table des pages : action inconnue
  assert.equal((await call({ type: 'syncDisable' })).ok, true);
  assert.equal((await call({ type: 'syncStatus' })).configured, false);
  await call({ type: 'lock' });
  assert.equal((await call({ type: 'syncNow' })).code, 'LOCKED');
  assert.equal((await call({ type: 'syncSetup', repo: REPO, token: TOKEN })).code, 'LOCKED');
});
