// Import depuis un export CSV ou zip : Dashlane, Bitwarden, Chrome/Edge, ou CSV générique.
// Ne garde que les identifiants de connexion (jamais cartes, pièces d'identité, infos personnelles).

import { readZip } from './zip.js';
import { parseTotp } from './totp.js';

const dec = new TextDecoder('utf-8');

/** CSV RFC 4180 : guillemets, guillemets doublés, retours à la ligne dans un champ. */
export function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') (field += '"', i++);
        else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') (row.push(field), (field = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) (row.push(field), rows.push(row));

  const [head, ...body] = rows.filter((r) => r.some((f) => f !== ''));
  if (!head) return { headers: [], records: [] };
  const headers = head.map((h) => h.trim().toLowerCase());
  const records = body.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
  return { headers, records };
}

/** Reconnaît le format d'après les en-têtes. */
export function detectFormat(headers) {
  const has = (...k) => k.every((x) => headers.includes(x));
  if (has('login_uri', 'login_password')) return 'bitwarden';
  if (has('username', 'password', 'title') && (headers.includes('username2') || headers.includes('otpurl') || headers.includes('otpsecret'))) return 'dashlane';
  if (has('name', 'url', 'username', 'password')) return 'chrome';
  if (headers.includes('password') && ['url', 'title', 'name'].some((k) => headers.includes(k))) return 'generique';
  return null;
}

const clean = (s) => (s ?? '').trim();
/** Clé 2FA importable ? Sinon on la garde dans les notes. */
const validTotp = (v) => {
  try {
    parseTotp(v);
    return true;
  } catch {
    return false;
  }
};

const join = (...parts) => parts.filter(Boolean).join('\n');

const MAPPERS = {
  dashlane(r) {
    const users = [...new Set([r.username, r.username2, r.username3].map(clean).filter(Boolean))];
    const otp = clean(r.otpurl) || clean(r.otpsecret);
    return {
      title: clean(r.title),
      url: clean(r.url),
      username: users[0] ?? '',
      password: r.password ?? '',
      notes: join(clean(r.note), users.length > 1 && `Autres identifiants : ${users.slice(1).join(', ')}`, otp && !validTotp(otp) && `Code à usage unique (TOTP) : ${otp}`),
      totp: otp && validTotp(otp) ? otp : '',
    };
  },
  bitwarden(r) {
    if (r.type && r.type !== 'login') return null;
    const totp = clean(r.login_totp);
    return {
      title: clean(r.name),
      url: clean(r.login_uri),
      username: clean(r.login_username),
      password: r.login_password ?? '',
      notes: join(clean(r.notes), totp && !validTotp(totp) && `Code à usage unique (TOTP) : ${totp}`),
      totp: totp && validTotp(totp) ? totp : '',
    };
  },
  chrome: (r) => ({ title: clean(r.name), url: clean(r.url), username: clean(r.username), password: r.password ?? '', notes: clean(r.note) }),
  generique: (r) => ({
    title: clean(r.title || r.name),
    url: clean(r.url || r.login_uri),
    username: clean(r.username || r.login || r.email),
    password: r.password ?? '',
    notes: clean(r.note || r.notes),
  }),
};

/** Convertit les lignes d'un CSV. Ignore les lignes sans mot de passe ni identifiant, ou sans titre ni adresse. */
export function recordsToEntries(records, format) {
  const entries = [];
  let skipped = 0;
  for (const r of records) {
    const e = MAPPERS[format](r);
    if (!e || (!e.password && !e.username) || (!e.title && !e.url)) skipped++;
    else entries.push({ ...e, notes: e.notes.replace(/\r\n?/g, '\n') });
  }
  return { entries, skipped };
}

/**
 * Analyse un fichier d'export (.csv ou .zip).
 * @returns {Promise<{format: string, entries: object[], skipped: number, ignoredFiles: string[]}>}
 */
export async function parseExport(bytes, filename = '') {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const isZip = u8[0] === 0x50 && u8[1] === 0x4b; // « PK »
  const files = isZip
    ? (await readZip(u8)).filter((f) => /\.csv$/i.test(f.name))
    : [{ name: filename || 'export.csv', data: u8 }];
  if (!files.length) throw new Error('Aucun fichier .csv trouvé dans cette archive.');

  const result = { format: null, entries: [], skipped: 0, ignoredFiles: [] };
  for (const f of files) {
    const { headers, records } = parseCsv(dec.decode(f.data));
    const format = detectFormat(headers);
    if (!format) {
      result.ignoredFiles.push(f.name);
      continue;
    }
    const { entries, skipped } = recordsToEntries(records, format);
    result.format ??= format;
    result.entries.push(...entries);
    result.skipped += skipped;
  }
  if (!result.format) throw new Error("Format non reconnu. Exportez vos identifiants depuis Dashlane, Bitwarden ou Chrome au format CSV.");
  return result;
}
