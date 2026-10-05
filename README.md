# file-optimizer

App web self-hébergée pour optimiser en masse des photos (redimensionnement +
compression) et des vidéos MKV (ré-encodage x265), avec conservation
optionnelle des originaux. Même principe que
[scan-page](../scan-page) : Next.js, SQLite (file de jobs persistée),
authentification par session, Docker.

## Fonctionnement

- **Parcourir** (`/`) : navigue dans la bibliothèque montée en volume
  (`FILES_DIR`), dossier par dossier, en mode **Photos** ou **Vidéos MKV**
  (le mode choisit ce qui est sélectionnable/scanné : jamais les deux à la
  fois, pour qu'un scan de photos n'embarque pas un encodage vidéo de
  plusieurs heures).
  - **Scanner ce dossier (récursif)** : trouve toutes les photos sous le
    dossier courant (sous-dossiers compris) et les met en file d'un coup.
  - **Sélection manuelle** : coche des photos précises en parcourant les
    dossiers (la sélection s'accumule tant qu'elle n'est pas vidée ou
    envoyée), puis "Optimiser la sélection".
  - Réglages communs aux deux : taille max (plus grand côté, en pixels),
    qualité (JPEG/WebP/AVIF ; un PNG est toujours recompressé sans perte,
    indépendamment de ce réglage), conservation des originaux, conversion
    forcée en JPG (désactivée par défaut).
- **Traitements** (`/jobs`) : liste des jobs (un job = un fichier, avec
  l'avancement en % pendant l'encodage d'une vidéo), filtrable
  par statut, avec détails (log, taille avant/après) et actions groupées
  (annuler les jobs sélectionnés, supprimer tous les jobs en
  attente/terminés).
  - **Pause** : aucun nouveau job ne démarre, et une vidéo en cours
    d'encodage est **gelée** (process ffmpeg suspendu) puis reprise là où
    elle en était — rien n'est perdu ni réécrit, la vérification finale
    habituelle s'applique toujours. ffmpeg garde sa mémoire pendant la pause
    (CPU à 0). Une photo en cours n'est pas gelée (traitée dans l'app
    elle-même, en quelques secondes) : elle se termine. Un redémarrage du
    conteneur pendant la pause fait perdre l'encodage en cours (job en
    erreur, source intacte).
  - **Avancement et temps restant** : % et temps restant estimé pour la
    vidéo en cours (sur /jobs) et pour le lot entier (barre sur Parcourir,
    qui reprend après un rafraîchissement). Estimation d'après la vitesse
    déjà mesurée (photos : durée moyenne ; vidéos : temps par octet source,
    appliqué à la taille des vidéos restantes), pauses déduites —
    approximative, surtout en début de lot.
  - **Annuler** un job en attente le retire de la file ; annuler le job **en
    cours** l'interrompt dans la seconde (vidéo : ffmpeg arrêté, fichier
    temporaire supprimé ; photo : abandon juste avant l'écriture). Le fichier
    d'origine reste toujours intact : il n'est remplacé qu'à la toute fin,
    une fois le résultat prêt et vérifié.

### Formats pris en charge

JPEG, PNG, WebP, AVIF — chacun est ré-encodé dans **son propre format**
(jamais de conversion vers un format universel) : un PNG garde sa
transparence, un WebP reste un WebP. Un fichier dans un autre format
(TIFF, BMP, GIF...) n'est ni listé comme image ni pris en compte par le scan
récursif.

### Forcer la conversion en JPG

Désactivée par défaut. JPEG est une compression à perte plus agressive qu'un
PNG recompressé sans perte : certains fichiers (captures d'écran, graphiques)
ne gagnent presque rien en PNG mais chutent nettement une fois convertis en
JPG — cette option permet d'être sûr de gagner de la place dans ces cas-là.
Sans effet sur un fichier déjà en JPEG. La transparence éventuelle (PNG/WebP/
AVIF) est perdue : le fond transparent est aplati en blanc. Le fichier résultat
change d'extension (`photo.png` → `photo.jpg`) ; en cas de collision avec un
fichier du même nom déjà présent, un suffixe numérique est ajouté. Le garde-fou
"jamais plus gros qu'avant" (voir ci-dessous) s'applique aussi à cette
conversion : si le JPG obtenu n'est pas plus petit, le fichier d'origine est
gardé tel quel.

### Jamais de fichier plus gros qu'avant

Un ré-encodage ne réduit pas toujours la taille (photo déjà bien compressée
par le téléphone/l'appareil, qualité demandée supérieure à celle d'origine).
Si le résultat n'est pas plus petit que l'original, le fichier est laissé
intact — aucun dossier `origin/` créé puisqu'il n'y a rien à sauvegarder.

### Conservation des originaux

Quand l'option "Conserver les originaux" est activée (par défaut), le fichier
d'origine est déplacé dans un sous-dossier `origin/` créé **dans le même
dossier** que la photo (ex: `vacances/photo.jpg` → original déplacé vers
`vacances/origin/photo.jpg`, la version optimisée prend la place de
`vacances/photo.jpg`). Un dossier `origin/` n'est jamais lui-même
parcouru/scanné : ses fichiers ne sont jamais ré-optimisés par erreur.

### Vidéos MKV (x265)

Seule la piste vidéo est ré-encodée en x265/HEVC ; **toutes** les autres
pistes (audio multiples, sous-titres de tout type, polices ASS en pièces
jointes, chapitres, langues, drapeaux "par défaut"/"forcé") sont recopiées
telles quelles, sans ré-encodage. `-copyts` conserve l'horodatage d'origine
de chaque paquet : aucun décalage audio/sous-titres, même quand la source en
contient un volontaire (sans lui, ffmpeg recale la vidéo ré-encodée et les
pistes copiées différemment de quelques ms dès que la source ne démarre pas
pile à 0).

- **Vérification avant remplacement** : après l'encodage, le résultat est
  comparé à la source (même pistes dans le même ordre, mêmes codecs pour les
  pistes copiées, même nombre de paquets, même horodatage du premier paquet
  de chaque piste, même durée). Au moindre écart, le résultat est jeté et la
  source reste intacte (job en erreur, détail dans le log).
- **Taille** : le CRF (22 par défaut) décide de la qualité ; le débit vidéo
  est en plus plafonné pour que le fichier final ne dépasse pas une taille
  maximale, selon le **type de vidéo** choisi :
  - **Film** : 70 % de la source (4 Go → 2,8 Go max, souvent bien moins) ;
  - **Série (épisodes)** : 200 Mo + 12 Mo par minute (~440 Mo pour un
    épisode de 20 min, ~800 Mo pour 50 min), et jamais plus de 70 % de la
    source.

  En dessous du plafond, tant mieux. Seule exception :
  pistes audio copiées si lourdes (TrueHD...) que la cible est inatteignable
  sans dégrader franchement l'image — signalé dans le log. Le garde-fou
  "jamais plus gros qu'avant" s'applique aussi.
- **Déjà en HEVC/AV1/VP9** : laissé intact s'il est déjà compact pour son
  type (un second encodage perdrait en qualité pour un gain faible) — film :
  jusqu'à ~22 Mo par minute (~3 Mbit/s, ~1,4 Go par heure) ; série : sous le
  plafond série. Au-dessus (ex: épisode HEVC de 1,7 Go pour 45 min), il est
  ré-encodé comme les autres.
- **Jamais ré-encodé deux fois** : chaque fichier produit porte le tag MKV
  `FILE_OPTIMIZER` (réglages utilisés) ; un fichier qui le porte est
  toujours laissé tel quel.
- **Conserver la source** (désactivé par défaut) : la source est renommée en
  `film.mkv.bkp` à côté du résultat (`film_1.mkv.bkp` si une sauvegarde
  existe déjà). Sans cette option, la source est remplacée définitivement.
- Encodage dans `film.mkv.part` (même dossier, renommé atomiquement à la
  fin) ; espace disque vérifié avant de commencer, en gardant toujours au
  moins 2 Go libres sur le volume. Un encodage coupé par un
  redémarrage du conteneur supprime ce fichier temporaire au démarrage
  suivant. Ni `.bkp` ni `.part` ne sont jamais listés comme vidéos.
- **Ménager le NAS** : ffmpeg/ffprobe tournent en priorité CPU minimale
  (`nice 19`) et en classe d'E/S disque "idle" (`ionice -c 3`), en plus des
  limites dures du conteneur (RAM, cœur épinglé, nombre de process — voir
  docker-compose.yml). La vitesse passe après la stabilité : plusieurs
  heures par film sur un seul cœur ; le preset `fast`/`faster` va plus vite
  au prix d'un fichier un peu plus gros. Les métadonnées HDR10 statiques et
  Dolby Vision ne sont pas garanties : éviter ce mode sur des sources HDR.

### Protection mémoire (shrink-on-load)

Comme scan-page : demander le redimensionnement **dans le même pipeline**
sharp que le décodage (plutôt qu'après coup) permet le "shrink-on-load" de
libvips — la mémoire nécessaire dépend de la taille de **sortie**, pas de la
taille de la photo source. Une photo démesurée (ou aux métadonnées
corrompues) ne peut donc pas faire exploser la mémoire du conteneur ; voir
`src/lib/pipeline/optimizeImage.ts`.

## Développement

Nécessite `ffmpeg`/`ffprobe` avec libx265 dans le PATH (mode vidéo et tests ;
déjà inclus dans l'image Docker).

```bash
cp .env.example .env   # renseigner AUTH_USER/AUTH_PASSWORD
npm install
npm run dev
```

`npm test` lance la suite de tests (aussi exécutée automatiquement avant
`npm run build`, via le script "prebuild").

## CI/CD — image Docker publiée automatiquement

À chaque push sur `main` (et sur les tags `v*`), le workflow
[`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml)
build l'image (`linux/amd64`) et la publie sur GitHub Container Registry :

```
ghcr.io/nimothenicefish/file-optimizer:latest
```

Aucun secret à configurer : le workflow utilise le `GITHUB_TOKEN` fourni
automatiquement par GitHub Actions (permission `packages: write`).

**Rendre le package accessible en pull depuis le NAS** : par défaut un package
GHCR est privé. Soit le rendre public (repo GitHub → onglet *Packages* →
`file-optimizer` → *Package settings* → *Change visibility* → *Public*), soit
se connecter depuis le NAS avec un token :

```bash
echo <PERSONAL_ACCESS_TOKEN avec le scope read:packages> | docker login ghcr.io -u Nimothenicefish --password-stdin
```

### Versionnage sémantique automatique (`v1.4.2`, `1.4`, `1`)

En plus de `latest` (qui continue de suivre `main` sur chaque push), un
commit préfixé `patch:`/`minor:`/`major:` poussé sur `main` déclenche
automatiquement une nouvelle version, gérée par
[`.github/workflows/auto-release.yml`](.github/workflows/auto-release.yml) :
il lit les commits depuis le dernier tag `vX.Y.Z`, calcule le tag suivant
selon le préfixe le plus élevé trouvé (`major` > `minor` > `patch`), le
pousse, déclenche `docker-publish.yml` pour ce tag (qui publie alors
`v1.4.2`, `v1.4` et `v1` en plus de `latest` — le tag Docker garde le "v" du
tag git, à utiliser tel quel pour déployer, ex: `image:
ghcr.io/nimothenicefish/file-optimizer:v1.4.2` dans Portainer/docker-compose),
puis crée la GitHub Release correspondante.

- `patch:` — correctif de bug, aucun nouveau comportement.
- `minor:` — nouvelle fonctionnalité rétrocompatible.
- `major:` — changement cassant (migration DB non rétrocompatible,
  changement de contrat d'API/URL, etc.).
- Un commit sans préfixe ne déclenche aucune release (juste le build
  habituel de `latest`).

Un tag `vX.Y.Z` poussé manuellement (`git tag vX.Y.Z && git push origin
vX.Y.Z`) fonctionne toujours indépendamment de ce mécanisme.

## Déployer sur le NAS

Copier `docker-compose.yml` sur le NAS, créer un fichier `.env` à côté (même
dossier) avec `AUTH_USER`/`AUTH_PASSWORD`, adapter le chemin hôte du volume
photos, puis :

```bash
docker compose pull      # récupère l'image publiée par la CI, pas de build sur le NAS
docker compose up -d
```

Une mise à jour se fait avec les deux mêmes commandes après un nouveau push
sur `main`.

**Limites de ressources** : `docker-compose.yml` fixe des limites dures
(`mem_limit`/`memswap_limit`/`cpuset`/`pids_limit`), reprises du réglage déjà
mesuré sur scan-page (même pipeline sharp) comme point de départ — à ajuster
après avoir observé l'usage réel de cette app (`docker stats`). Sans ces
limites, un traitement qui dérape peut saturer tout le NAS au lieu de rester
contenu à ce conteneur.
