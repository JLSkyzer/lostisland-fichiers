# Lost Island Fichiers

Logiciel de transfert de fichiers de l'équipe du serveur Minecraft **Lost Island RP**, à la manière de WinSCP.
Il gère les **fichiers du jeu** : le dossier du serveur dont la racine correspond à l'intérieur du dossier
`.lostisland` des joueurs (`mods` → leur dossier mods, `config` → config, etc.), que le launcher leur distribue.

Il passe par l'API du site (`https://lostisland.eriniumlab.com/api/fichiers`, contrat dans
`docs/api-logiciel-fichiers.md` du dépôt du site) et contourne la limite de 100 Mo par requête de Cloudflare
en découpant les gros fichiers.

Tout changement est reçu par les joueurs au prochain « Jouer » du launcher. Les jars du dossier `optionalmod`
deviennent des mods optionnels.

## Connexion

Avec un **compte d'accès**, créé par l'administrateur du site dans **Admin → Fichiers du jeu → Accès par
logiciel** (le même compte que pour WinSCP). Les identifiants sont vérifiés auprès du site à la connexion.

« Se souvenir de moi » garde le mot de passe chiffré par le système (`safeStorage` : DPAPI sous Windows,
trousseau sous macOS, libsecret sous Linux). Il n'est jamais écrit en clair : sans chiffrement disponible, il
n'est pas retenu. La déconnexion l'oublie.

## Utilisation

- À gauche le PC, à droite le serveur. Double-clic ou Entrée pour ouvrir un dossier ; double-clic sur un
  fichier pour le transférer de l'autre côté. Sélection par clic, Ctrl+clic, Maj+clic, Ctrl+A.
- Transférer : boutons « Envoyer » et « Télécharger », touche F6, ou glisser-déposer d'un volet à l'autre
  (sur un dossier de la liste pour viser ce dossier). Des fichiers peuvent aussi être glissés depuis
  l'explorateur du système vers le volet du serveur. Les dossiers partent entiers.
- Ne sont jamais envoyés : les fichiers et dossiers cachés (nom commençant par « . »), `Thumbs.db` et
  `desktop.ini`. Ils apparaissent en grisé côté PC.
- La file des transferts, en bas, montre progression, vitesse et état ; deux transferts à la fois au plus ;
  chacun s'annule par sa croix.
- Côté serveur : nouveau dossier (F7), renommer (F2), supprimer (Suppr, après confirmation). Côté PC :
  nouveau dossier, ouvrir dans l'explorateur, choisir un autre dossier.

## Gros fichiers

Jusqu'à 90 Mo, un fichier part en une requête. Au-delà, il est découpé en morceaux de 50 Mo exactement,
envoyés dans l'ordre avec un même identifiant d'envoi ; le dernier déclenche l'assemblage sur le serveur.
Chaque morceau est retenté 3 fois en cas de coupure (4 essais en tout).

**Reprise** : l'identifiant d'un envoi en cours est gardé dans `envois-en-cours.json` (dossier de données du
logiciel), sous la clé chemin distant + taille + date de modification locale. Si l'envoi est interrompu
(coupure, annulation, fermeture), le relancer demande au serveur les morceaux déjà reçus et n'envoie que les
autres. Un fichier modifié entre-temps repart de zéro. Le serveur efface les morceaux abandonnés au bout d'un
jour.

Les téléchargements passent par un fichier temporaire `.lipart`, renommé une fois complet.

## Synchronisation

« Synchroniser » rend le dossier du serveur ouvert identique au dossier du PC ouvert. Rien n'est fait avant
l'aperçu :

1. Parcours du dossier local, liste du serveur avec les empreintes SHA-1.
2. Aperçu : fichiers **à envoyer** (absents du serveur), **à remplacer** (taille ou empreinte SHA-1
   différente, calculée localement en flux), **à supprimer** sur le serveur (absents du PC).
3. Application seulement après confirmation, dans la file des transferts.

Une case permet de ne rien supprimer. Un dossier du serveur absent du PC est supprimé d'un coup.

## Développement

```bash
npm install
npm start         # l'application
npm run essai     # essais automatiques (sans réseau : serveur factice local, outils/serveur-factice.js)
```

Variables d'essai, ignorées dans l'application installée :

| Variable | Effet |
|---|---|
| `LI_ESSAI=1` | Démarre un serveur factice local garni d'un faux contenu, et ouvre l'écran principal sans compte. Réglages à part, dans le dossier temporaire. |
| `LI_ESSAI=connexion` | Même chose, mais montre l'écran de connexion (compte factice : `essai` / `essai`). |
| `LI_ESSAI_SCENARIO` | `selection`, `file`, `sync`, `suppression`, `renommer` : met l'interface dans cet état. |
| `LI_ESSAI_LENTEUR` | Ralentit les envois du serveur factice (ms par 64 Kio), pour voir la progression. |
| `LI_CAPTURE=fichier.png` | Photographie la fenêtre après `LI_CAPTURE_MS` ms (6000 par défaut), puis quitte. |
| `LI_API` | Autre adresse de l'API. |

En essai et en capture, la fenêtre s'ouvre sur un écran secondaire s'il y en a un.

Organisation : `src/main/contrat.js` (règles du contrat, fonctions pures), `api.js` (client HTTP),
`transferts.js` (file), `operations.js` (préparation des transferts et de la synchronisation),
`reprises.js`, `local.js`, `stockage.js`, `maj.js` ; l'interface dans `src/renderer`, sans aucune ressource
externe (CSP stricte, polices du système).

## Publier une version

Changer `version` dans `package.json`, commiter, puis pousser un tag :

```bash
git tag v0.1.0 && git push origin v0.1.0
```

La CI (`.github/workflows/construire.yml`) vérifie, lance les essais, construit Windows (installateur NSIS),
macOS (dmg et zip universels) et Linux (AppImage), et les publie dans une version GitHub de
`JLSkyzer/lostisland-fichiers`. Au démarrage suivant, chaque logiciel installé propose la mise à jour, la
télécharge, l'installe et se relance (Windows et Linux par electron-updater, macOS par remplacement de
l'application, comme le launcher).

Les installateurs ne sont pas signés : Windows affiche « éditeur inconnu » au premier lancement ; macOS demande
d'ouvrir l'application par clic droit → Ouvrir, et elle doit être rangée dans Applications pour se mettre à
jour.
