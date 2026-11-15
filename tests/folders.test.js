import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault, cleanFolder, FOLDER_MAX } from '../src/core/vault.js';
import { parseExport } from '../src/core/import.js';
import { toCsv } from '../src/core/export.js';

const FAST = { iterations: 1000 };
const PW = 'correct horse battery staple';

test('dossier : nom normalisé, défaut vide, limité en longueur', () => {
  assert.equal(cleanFolder('  Banque   et   assurance '), 'Banque et assurance');
  assert.equal(cleanFolder(null), '');
  assert.equal(cleanFolder('x'.repeat(200)).length, FOLDER_MAX);
});

test('dossier : ajout, modification, liste, recherche', async () => {
  const v = await Vault.create(PW, FAST);
  const { id } = v.addEntry({ title: 'Banque', password: 'p', folder: ' Finance ' });
  v.addEntry({ title: 'Mail', password: 'p' });
  assert.equal(v.list().find((e) => e.title === 'Banque').folder, 'Finance');
  assert.equal(v.list().find((e) => e.title === 'Mail').folder, '');
  assert.deepEqual(v.search('finance').map((e) => e.title), ['Banque']); // la recherche couvre aussi le dossier
  v.updateEntry(id, { folder: 'Pro' });
  assert.equal(v.getEntry(id).folder, 'Pro');
  v.updateEntry(id, { folder: '' });
  assert.equal(v.getEntry(id).folder, '');
});

test('renommer / supprimer un dossier : seuls ses identifiants sont touchés, date mise à jour', async () => {
  const v = await Vault.create(PW, FAST);
  v.addEntry({ title: 'A', folder: 'Perso' });
  v.addEntry({ title: 'B', folder: 'Perso' });
  const c = v.addEntry({ title: 'C', folder: 'Pro' });
  const before = v.getEntry(c.id).updatedAt;
  await new Promise((r) => setTimeout(r, 3));
  assert.equal(v.renameFolder('Perso', 'Maison'), 2);
  assert.deepEqual(v.list().map((e) => e.folder), ['Maison', 'Maison', 'Pro']);
  assert.equal(v.getEntry(c.id).updatedAt, before); // dossier voisin intact
  assert.equal(v.renameFolder('Maison', ''), 2); // supprimer : identifiants conservés
  assert.deepEqual(v.list().map((e) => e.folder), ['', '', 'Pro']);
  assert.equal(v.list().length, 3);
  assert.equal(v.renameFolder('', 'X'), 0); // le « dossier » vide n'existe pas
  assert.equal(v.renameFolder('Inconnu', 'X'), 0);
});

test('import : dossiers Bitwarden et Dashlane repris ; export CSV les conserve (aller-retour)', async () => {
  const bw = await parseExport(new TextEncoder().encode('folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\nFinance,,login,Banque,,,0,https://b.fr,u,p,\n,,login,Sans,,,0,https://s.fr,u,p2,\n'), 'bw.csv');
  assert.deepEqual(bw.entries.map((e) => e.folder), ['Finance', '']);
  const dl = await parseExport(new TextEncoder().encode('username,username2,username3,title,password,note,url,category,otpUrl\nme,,,Shop,pw,,s.fr,Shopping,\n'), 'dl.csv');
  assert.equal(dl.entries[0].folder, 'Shopping');

  const v = await Vault.create(PW, FAST);
  v.importEntries(bw.entries);
  const csv = toCsv(v.list().map((s) => v.getEntry(s.id)));
  assert.ok(csv.startsWith('name,url,username,password,note,folder\r\n'));
  const back = await parseExport(new TextEncoder().encode(csv), 'x.csv');
  assert.deepEqual(back.entries.map((e) => [e.title, e.folder]).sort(), [['Banque', 'Finance'], ['Sans', '']]);
});
