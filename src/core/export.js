// Export CSV (NON chiffré) et validation d'une sauvegarde chiffrée. Format CSV = celui de Chrome :
// importable tel quel dans Chrome, Bitwarden, Dashlane, et ré-importable dans Coffre.

const COLUMNS = ['name', 'url', 'username', 'password', 'note', 'folder'];

const cell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(entries) {
  const rows = entries.map((e) => [e.title, e.url, e.username, e.password, e.notes, e.folder].map(cell).join(','));
  return `${[COLUMNS.join(','), ...rows].join('\r\n')}\r\n`;
}

/** Vérifie qu'un texte est bien un coffre chiffré de Coffre (sans le déchiffrer). Renvoie l'objet. */
export function parseBackup(text) {
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Ce fichier n'est pas une sauvegarde Coffre."), { code: 'BAD_BACKUP' });
  }
  const ok = o?.v === 1 && o.kdf?.salt && Number.isInteger(o.kdf.iterations) && o.wrappedKey?.ct && o.data?.ct && o.data?.iv;
  if (!ok) throw Object.assign(new Error("Ce fichier n'est pas une sauvegarde Coffre."), { code: 'BAD_BACKUP' });
  return o;
}

export const backupFilename = (d = new Date()) => `coffre-sauvegarde-${d.toISOString().slice(0, 10)}.json`;
export const csvFilename = (d = new Date()) => `coffre-export-${d.toISOString().slice(0, 10)}.csv`;
