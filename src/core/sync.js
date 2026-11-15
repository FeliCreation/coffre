// Synchronisation du coffre chiffré via un fichier d'un dépôt GitHub privé. Rien n'est jamais envoyé en clair.

import { getFile, putFile, checkConfig, SyncError } from './github.js';

export { SyncError, checkConfig };

/**
 * Fusionne le coffre local avec le distant, puis met le distant à jour si nécessaire.
 * Renvoie { pulled, pushed } ; l'appelant doit enregistrer le coffre local si `pulled`.
 */
export async function syncVault(vault, cfg, { fetchImpl = fetch, attempts = 3 } = {}) {
  const c = checkConfig(cfg);
  for (let i = 0; i < attempts; i++) {
    const remote = await getFile(c, fetchImpl);
    if (!remote) {
      await putFile(c, await vault.serialize(), undefined, fetchImpl);
      return { pulled: false, pushed: true };
    }
    const { pull, push } = await vault.mergeRemote(remote.json);
    if (!push) return { pulled: pull, pushed: false };
    try {
      await putFile(c, await vault.serialize(), remote.sha, fetchImpl);
      return { pulled: pull, pushed: true };
    } catch (e) {
      if (e.code !== 'CONFLICT' || i === attempts - 1) throw e;
    }
  }
  throw new SyncError('CONFLICT', 'Synchronisation impossible : le coffre distant change sans cesse.');
}

/** Récupère le coffre chiffré distant pour un appareil qui n'en a pas encore (null si le dépôt est vide). */
export async function fetchRemoteVault(cfg, { fetchImpl = fetch } = {}) {
  const remote = await getFile(checkConfig(cfg), fetchImpl);
  if (remote && remote.json?.v !== 1) throw new SyncError('BAD_FORMAT', "Le fichier distant n'est pas un coffre.");
  return remote?.json ?? null;
}
