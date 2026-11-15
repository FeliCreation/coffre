// Audit de santé du coffre : mots de passe faibles, réutilisés, anciens. Logique pure, tout reste local.
// Le résultat ne contient jamais de mot de passe : seulement des identifiants d'entrées et des titres.

import { estimateStrength } from './generator.js';

export const OLD_AFTER_MS = 365 * 24 * 3600_000;

/** `entries` : entrées complètes (avec mot de passe). */
export function auditEntries(entries, now = Date.now()) {
  const weak = [];
  const old = [];
  const byPassword = new Map();
  const bad = new Set();
  let withPassword = 0;

  for (const e of entries) {
    if (!e.password) continue;
    withPassword++;
    const s = estimateStrength(e.password);
    if (s.score <= 1) {
      weak.push({ id: e.id, title: e.title, detail: `${s.bits} bits` });
      bad.add(e.id);
    }
    if (now - (e.updatedAt ?? e.createdAt ?? now) > OLD_AFTER_MS) {
      old.push({ id: e.id, title: e.title, detail: `modifié il y a ${Math.floor((now - e.updatedAt) / (30 * 24 * 3600_000))} mois` });
      bad.add(e.id);
    }
    const g = byPassword.get(e.password) ?? [];
    g.push({ id: e.id, title: e.title });
    byPassword.set(e.password, g);
  }

  const reused = [];
  for (const g of byPassword.values()) {
    if (g.length < 2) continue;
    reused.push({ count: g.length, entries: g });
    g.forEach((x) => bad.add(x.id));
  }
  reused.sort((a, b) => b.count - a.count);

  const healthy = withPassword - [...bad].length;
  return { total: withPassword, weak, reused, old, score: withPassword ? Math.round((100 * healthy) / withPassword) : 100 };
}
