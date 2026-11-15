# Coffre — gestionnaire de mots de passe (extension MV3)

Extension navigateur (Chrome/Edge, MV3), JavaScript pur en modules ES, **zéro dépendance, zéro serveur** (coût d'hébergement = 0, contrainte dure). Tests : `npm test` (Node 22, `node:test`).

## Fonctions visées
1. Coffre chiffré local. 2. Générateur. 3. Remplissage automatique. 4. Partage sécurisé.

## Architecture (décisions prises)
- `src/core/` : logique pure, testée sous Node, sans API navigateur (Web Crypto uniquement).
  - `crypto.js` AES-256-GCM, PBKDF2-SHA256 600 000 itérations, AAD par usage.
  - `vault.js` clé aléatoire du coffre enveloppée par le mot de passe maître (changer de mot de passe = ré-envelopper). Entrées, recherche, correspondance de domaine stricte (sous-domaines oui, `evil-site.fr` non).
  - `generator.js` tirage sans biais, un caractère de chaque type garanti, estimation de force.
  - `share.js` ECDH P-256 + HKDF + AES-GCM. Codes texte `coffre-pub:1:` et `coffre-share:1:`, expiration 72 h par défaut, empreintes à comparer par un autre canal.
- `src/background/service-worker.js` : seul détenteur du coffre déchiffré ; clé de session dans `storage.session` (mémoire, invisible des pages) ; verrouillage auto par alarme (15 min) ; messages acceptés des seules pages de l'extension.
- **Partage sans serveur** : on échange des codes texte par n'importe quel canal. Un partage « en direct » avec serveur est exclu (coût).
- **Synchro sans serveur** : le coffre chiffré est un fichier d'un dépôt GitHub privé (`core/github.js`, `core/sync.js`), fusionné entrée par entrée (`Vault.mergeRemote`). Le jeton est dans la partie chiffrée du coffre (`data.sync`).
- **Application web** `app/` (téléphone et PC, PWA sur GitHub Pages) : mêmes popup et service worker que l'extension, avec un faux `chrome` (`app/shim.js`). Pas de remplissage dans les autres applications (limite assumée).
- **Logiciel Windows** `desktop/CoffreAutoType` : saisie automatique par raccourci global dans n'importe quel logiciel ; lecture seule du coffre synchronisé (voir `desktop/README.md`).
- `src/popup/` interface (DOM construit sans `innerHTML`) ; `src/content/content.js` badge + remplissage + capture (shadow DOM fermé) ; `dev/` faux `chrome` et harnais navigateur, non livrés.
- **Remplissage** : jamais silencieux. L'utilisateur clique ; entrées proposées uniquement pour le domaine correspondant ; pas de remplissage dans les iframes tierces.

## Règles
- Aucun secret en clair dans le stockage ni dans les journaux ; `list`/`search` ne renvoient jamais mot de passe ni notes (seul `reveal` le fait).
- PBKDF2 réduit (1000) seulement dans les tests.
- Interface neuve : maquette validée avant de coder (maquette en 5 écrans présentée dans la conversation du 2026-11-14 : verrouillé, coffre, générateur, partage, remplissage sur page ; validation en attente).

Voir `REPRISE.md` pour l'état et la file d'attente.
