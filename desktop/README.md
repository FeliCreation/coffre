# Coffre : saisie automatique pour Windows

Petit logiciel de la zone de notification. Raccourci **Ctrl+Alt+K** depuis n'importe quel logiciel : il propose vos identifiants
et les **tape** dans la fenêtre qui était active (identifiant, Tab, mot de passe). Pas d'enregistreur de frappe : il ne lit rien,
il écrit seulement quand vous choisissez un identifiant.

## Installation
Prérequis : Windows 10/11 avec « .NET 8 Desktop Runtime » (déjà présent si le SDK .NET 8 est installé).

1. Compilez : `dotnet publish desktop/CoffreAutoType -c Release -o desktop/dist` (ou téléchargez le résultat de l'onglet Actions du dépôt).
2. Lancez `CoffreAutoType.exe` : une icône apparaît dans la zone de notification.
3. Ctrl+Alt+K → saisissez le dépôt (`compte/nom-du-dépôt`) et un jeton GitHub (lecture seule suffit) → « Télécharger mon coffre ».
4. Ensuite, Ctrl+Alt+K → mot de passe maître → choisissez l'identifiant → Entrée.

Clic droit sur l'icône : « Lancer au démarrage de Windows », réglages du dépôt, verrouillage, quitter.

## Raccourcis dans la fenêtre
- **Entrée** : identifiant + Tab + mot de passe ; **Ctrl+Entrée** : mot de passe seul ; **Maj+Entrée** : identifiant seul.
- Les identifiants dont le titre ou le site apparaît dans le titre de la fenêtre visée passent en premier.

## Sécurité
- Lecture seule : ce logiciel ne modifie jamais le coffre (la synchro est faite par l'extension ou l'application web).
- Le coffre déchiffré n'existe qu'en mémoire ; verrouillage après 5 minutes sans usage, au verrouillage de session Windows et à la fermeture.
- Le jeton GitHub est protégé par DPAPI (lié à votre session Windows). La copie du coffre en cache reste chiffrée.
- Avant de taper, le logiciel ramène la fenêtre d'origine au premier plan et **vérifie qu'elle est active** ; sinon il ne tape rien.
- Les touches Ctrl/Alt/Maj/Windows doivent être relâchées avant la saisie.

## Tests
- `npm run test:desktop` : un coffre créé par le code JavaScript est relu à l'identique (PBKDF2, AES-GCM, Unicode, erreurs, client GitHub).
- `npm run e2e:desktop` : raccourci global réel, déverrouillage et saisie réelle dans une fenêtre de test (interactif, ~12 s).
