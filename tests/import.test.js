import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { parseCsv, detectFormat, parseExport } from '../src/core/import.js';
import { readZip } from '../src/core/zip.js';
import { Vault } from '../src/core/vault.js';

// Données fictives uniquement.
const DASHLANE = [
  'username,username2,username3,title,password,note,url,category,otpUrl',
  'alice@exemple.fr,alice2,,Exemple,pw-un,"ligne 1',
  'ligne ""2""",https://exemple.fr/login,Divers,',
  ',,,Sans compte,,,https://vide.fr,Divers,',
  'bob,,,Banque,pw-deux,,mabanque.fr,Finance,otpauth://totp/Banque?secret=ABCD',
].join('\r\n');

/** Fabrique un zip (méthode 0 ou 8) pour les tests. */
function makeZip(files, { encrypted = false } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data, method = 8 } of files) {
    const raw = Buffer.from(data);
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const nm = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(encrypted ? 1 : 0, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    parts.push(lh, nm, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(encrypted ? 1 : 0, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nm);
    offset += lh.length + nm.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}

test('CSV : guillemets, retours à la ligne dans un champ, BOM, CRLF', () => {
  const { headers, records } = parseCsv('﻿A,B\r\n"x,1","l1\nl2"\r\n"a ""b""",\r\n');
  assert.deepEqual(headers, ['a', 'b']);
  assert.deepEqual(records, [{ a: 'x,1', b: 'l1\nl2' }, { a: 'a "b"', b: '' }]);
});

test('détection des formats', () => {
  assert.equal(detectFormat(parseCsv(DASHLANE).headers), 'dashlane');
  assert.equal(detectFormat(['name', 'url', 'username', 'password', 'note']), 'chrome');
  assert.equal(detectFormat(['folder', 'type', 'name', 'login_uri', 'login_username', 'login_password']), 'bitwarden');
  assert.equal(detectFormat(['type', 'title', 'first_name']), null);
  assert.equal(detectFormat(['type', 'number', 'name']), null);
});

test('Dashlane : champs, identifiants multiples, TOTP, lignes vides ignorées', async () => {
  const r = await parseExport(new TextEncoder().encode(DASHLANE), 'credentials.csv');
  assert.equal(r.format, 'dashlane');
  assert.equal(r.skipped, 1);
  assert.equal(r.entries.length, 2);
  const [a, b] = r.entries;
  assert.equal(a.username, 'alice@exemple.fr');
  assert.equal(a.password, 'pw-un');
  assert.match(a.notes, /ligne 1\nligne "2"/);
  assert.match(a.notes, /Autres identifiants : alice2/);
  assert.match(b.notes, /TOTP\) : otpauth:\/\/totp\/Banque/);
});

test('zip Dashlane : ne garde que credentials.csv, ignore cartes et identité', async () => {
  const zip = makeZip([
    { name: 'credentials.csv', data: DASHLANE },
    { name: 'payments.csv', data: 'type,account_name,cc_number,code\r\ncard,Visa,4111111111111111,123\r\n' },
    { name: 'ids.csv', data: 'type,number,name\r\n', method: 0 },
  ]);
  const r = await parseExport(zip, 'export.zip');
  assert.equal(r.entries.length, 2);
  assert.deepEqual(r.ignoredFiles.sort(), ['ids.csv', 'payments.csv']);
  assert.ok(!JSON.stringify(r.entries).includes('4111'), 'aucune donnée de carte importée');
});

test('zip chiffré, corrompu ou sans csv : erreurs claires', async () => {
  await assert.rejects(readZip(makeZip([{ name: 'a.csv', data: 'x' }], { encrypted: true })), /mot de passe/);
  await assert.rejects(readZip(new Uint8Array([80, 75, 1, 2, 3])), /zip valide/);
  await assert.rejects(parseExport(makeZip([{ name: 'notes.txt', data: 'x' }])), /Aucun fichier .csv/);
  await assert.rejects(parseExport(new TextEncoder().encode('a,b\n1,2'), 'x.csv'), /Format non reconnu/);
});

test('Chrome et Bitwarden', async () => {
  const chrome = await parseExport(new TextEncoder().encode('name,url,username,password,note\nSite,https://s.fr,moi,pw,n'), 'Chrome.csv');
  assert.deepEqual(chrome.entries[0], { title: 'Site', url: 'https://s.fr', username: 'moi', password: 'pw', notes: 'n', folder: '' });
  const bw = await parseExport(new TextEncoder().encode('folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,BW,,,0,https://bw.fr,u,p,\n,,note,Note,x,,0,,,,\n'), 'bw.csv');
  assert.equal(bw.entries.length, 1);
  assert.equal(bw.entries[0].title, 'BW');
});

test('Vault.importEntries : doublons ignorés, entrées invalides comptées', async () => {
  const v = await Vault.create('mot de passe maître test', { iterations: 1000 });
  v.addEntry({ title: 'Exemple', url: 'exemple.fr', username: 'alice@exemple.fr', password: 'pw-un' });
  const { entries } = await parseExport(new TextEncoder().encode(DASHLANE), 'c.csv');
  const res = v.importEntries([...entries, entries[0], { title: '', url: '' }]);
  assert.deepEqual(res, { added: 1, duplicates: 2, invalid: 1 });
  assert.equal(v.list().length, 2);
  assert.deepEqual(v.importEntries(entries), { added: 0, duplicates: 2, invalid: 0 }, 'réimport idempotent');
});
