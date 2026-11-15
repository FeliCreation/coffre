# REPRISE — Coffre

## État (2026-11-15)
- Noyau `src/core/` fini ; service worker, popup et script de contenu écrits. `npm test` : 66 tests verts (noyau, import, synchro, service worker avec faux `chrome`). L'extension (0.3.0 : synchro) se charge dans Chrome sans erreur (capture de Cyril sur la 0.2.0) ; les essais fonctionnels restent à faire.
- **Synchro multi-appareils (2026-11-15)** : le coffre chiffré est un fichier `coffre.json` d'un dépôt GitHub PRIVÉ de Cyril, via l'API « contents » (`src/core/github.js`, `sync.js`). Fusion par entrée (`Vault.mergeRemote` : plus récent gagne, pierres tombales `data.deleted` 180 j, en-tête le plus récent `headerAt`). Dépôt + jeton fine-grained stockés dans `data.sync` (partie chiffrée). Synchro après chaque écriture, toutes les 5 min (alarme), au déverrouillage, et manuelle (Réglages). Appareil vierge : « J'ai déjà un coffre sur un autre appareil » (`syncJoin`) puis mot de passe maître. Choix de Cyril : dépôt GitHub privé (pas Drive, pas Chrome Sync).
- **Application web (téléphone/PC)** : `app/` réutilise telles quelles la popup et le service worker avec un faux `chrome` (`app/shim.js` : localStorage / sessionStorage / minuteries). Publiée par `.github/workflows/pages.yml` sur GitHub Pages (dépôt public requis en gratuit, il ne contient aucun secret). Vérifiée dans le navigateur de test à 375 px avec un faux GitHub : création, activation, appareil vierge, déverrouillage. **Non vérifié** : service worker hors ligne (le volet de test n'accepte pas les service workers), vrai GitHub, vrai téléphone, extension 0.3.0 dans Chrome.
- Limite assumée : pas de remplissage dans les autres applications (nécessiterait une application Android native / un client de bureau). Le script de contenu ne capte que les formulaires web.
- Vérifié en navigateur via le harnais `dev/` (faux `chrome` en mémoire, vrai code) : création/déverrouillage/verrouillage, ajout, fiche, génération, partage + import, remplissage (champs + événements input/change), badge dans la page, pas de badge sur `new-password`, capture à la soumission, mode sombre.
- **Jamais chargé dans un vrai Chrome** : manifeste, service worker réel (storage.session, alarms), `chrome.tabs.sendMessage`, `activeTab`, CSP des pages. À faire en premier.

- « Ouvrir le site » (liste + fiche) via `siteUrl()` : http(s) seulement, refuse `javascript:`, `mailto:`, `site@piège`. Vérifié dans le harnais.

## Lancer le harnais
`node dev/serve.mjs 5199` puis http://127.0.0.1:5199/dev/harness.html (popup), /dev/content-harness.html (script de contenu), /dev/import-harness.html (import). Ne pas ouvrir ces fichiers en `file://` : les modules ne se chargent pas.
L'export Dashlane réel de Cyril n'a jamais été lu par Claude (secrets) ; seuls les noms de fichiers et l'en-tête de credentials.csv ont été inspectés.

## Chantier en cours
Charger l'extension non empaquetée : `chrome://extensions` → Mode développeur → « Charger l'extension non empaquetée » → dossier du projet. Vérifier : popup, console du service worker (lien « service worker »), remplissage sur un vrai site en HTTPS, verrouillage auto.

## File d'attente
0. Mise en ligne de l'application (en attente de l'accord de Cyril : création d'un dépôt PUBLIC pour le code + d'un dépôt PRIVÉ vide pour le coffre ; activer Pages « GitHub Actions » ; jeton fine-grained limité au dépôt privé, Contents read/write).
1. Test manuel dans Chrome (voir ci-dessus) puis correctifs.
2. Export CSV et sauvegarde chiffrée du coffre (l'import Dashlane/Bitwarden/Chrome, .zip ou .csv, est fait : `src/core/import.js`, `src/core/zip.js`, page `src/import/`, ouverte depuis Réglages). Le TOTP Dashlane est conservé dans les notes ; pas de vrai support TOTP encore.
3. Effacement du presse-papiers après 30 s (impossible depuis la popup qui se ferme : document offscreen ou alarme).
4. Phrases de passe (liste de mots à fournir), icône du badge selon le thème, champ « mot de passe actuel » sur changement de mot de passe.
5. Argon2 (WASM) à étudier pour remplacer PBKDF2. Firefox (manifest `background.scripts`).
6. Hook garde-fou, `/reprise`, `/fin-de-lot` pour ce projet (proposés, pas créés).

## Décisions et pièges
- Synchro : `api.github.com` est dans `host_permissions` (fiabilité, portée minimale). Le jeton ne sort jamais du service worker (`syncStatus` ne renvoie que le dépôt). Origine Pages `compte.github.io` partagée avec les autres sites Pages du même compte : le coffre y est chiffré, la clé de session est en sessionStorage (verrouillage à la fermeture de l'application) ; un domaine dédié serait mieux mais n'est pas gratuit.
- Fusion : égalité parfaite de `updatedAt` départagée par comparaison du JSON (déterministe des deux côtés). Une entrée modifiée après une suppression sur un autre appareil est conservée.
- `python -` avec heredoc a bloqué le shell sous Windows : utiliser `node` ou l'outil Edit.
- Une page ne parle qu'à la table `contentActions` (entries, fill, captured) ; la popup qu'à `actions`. Le site vient de `sender.url`, jamais du message. HTTPS ou localhost seulement.
- `submit` est un événement « de confiance » même déclenché par `form.requestSubmit()` : une page peut donc faire apparaître un « Enregistrer ? » pour son propre domaine. Accepté : la popup demande confirmation et le domaine est vérifié.
- Le remplissage exige un vrai clic (`isTrusted`). Les clics synthétiques du harnais ne le déclenchent pas : utiliser les outils de clic du navigateur.
- Le service worker MV3 est tué : ne rien garder qu'en `storage`.
- `window.close()` ferme l'onglet dans le harnais : il est neutralisé dans `dev/harness.html`.
- Node 22 : `node --test` veut un glob. Les heredocs Bash avec apostrophes ont échoué : utiliser l'outil Write.
- Le dépôt git parent est le dossier utilisateur ; ce projet a son propre `git init` (aucun commit pour l'instant).
