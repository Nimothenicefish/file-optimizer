# file-optimizer

App web self-hébergée pour optimiser en masse des photos (redimensionnement +
compression), avec conservation optionnelle des originaux. Même principe que
[scan-page](../scan-page) : Next.js, SQLite (file de jobs persistée),
authentification par session, Docker.

## Fonctionnement

- **Parcourir** (`/`) : navigue dans la bibliothèque de photos montée en
  volume (`PHOTOS_DIR`), dossier par dossier.
  - **Scanner ce dossier (récursif)** : trouve toutes les photos sous le
    dossier courant (sous-dossiers compris) et les met en file d'un coup.
  - **Sélection manuelle** : coche des photos précises en parcourant les
    dossiers (la sélection s'accumule tant qu'elle n'est pas vidée ou
    envoyée), puis "Optimiser la sélection".
  - Réglages communs aux deux : taille max (plus grand côté, en pixels),
    qualité (JPEG/WebP/AVIF ; un PNG est toujours recompressé sans perte,
    indépendamment de ce réglage), conservation des originaux.
- **Traitements** (`/jobs`) : liste des jobs (un job = une photo), filtrable
  par statut, avec détails (log, taille avant/après) et actions groupées
  (annuler les jobs en attente sélectionnés, supprimer tous les jobs en
  attente/terminés).

### Formats pris en charge

JPEG, PNG, WebP, AVIF — chacun est ré-encodé dans **son propre format**
(jamais de conversion vers un format universel) : un PNG garde sa
transparence, un WebP reste un WebP. Un fichier dans un autre format
(TIFF, BMP, GIF...) n'est ni listé comme image ni pris en compte par le scan
récursif.

### Conservation des originaux

Quand l'option "Conserver les originaux" est activée (par défaut), le fichier
d'origine est déplacé dans un sous-dossier `origin/` créé **dans le même
dossier** que la photo (ex: `vacances/photo.jpg` → original déplacé vers
`vacances/origin/photo.jpg`, la version optimisée prend la place de
`vacances/photo.jpg`). Un dossier `origin/` n'est jamais lui-même
parcouru/scanné : ses fichiers ne sont jamais ré-optimisés par erreur.

### Protection mémoire (shrink-on-load)

Comme scan-page : demander le redimensionnement **dans le même pipeline**
sharp que le décodage (plutôt qu'après coup) permet le "shrink-on-load" de
libvips — la mémoire nécessaire dépend de la taille de **sortie**, pas de la
taille de la photo source. Une photo démesurée (ou aux métadonnées
corrompues) ne peut donc pas faire exploser la mémoire du conteneur ; voir
`src/lib/pipeline/optimizeImage.ts`.

## Développement

```bash
cp .env.example .env   # renseigner AUTH_USER/AUTH_PASSWORD
npm install
npm run dev
```

`npm test` lance la suite de tests (aussi exécutée automatiquement avant
`npm run build`, via le script "prebuild").

## Déployer sur le NAS

Copier `docker-compose.yml` sur le NAS, créer un fichier `.env` à côté (même
dossier) avec `AUTH_USER`/`AUTH_PASSWORD`, adapter le chemin hôte du volume
photos, puis :

```bash
docker compose up -d --build
```

**Limites de ressources** : `docker-compose.yml` fixe des limites dures
(`mem_limit`/`memswap_limit`/`cpuset`/`pids_limit`), reprises du réglage déjà
mesuré sur scan-page (même pipeline sharp) comme point de départ — à ajuster
après avoir observé l'usage réel de cette app (`docker stats`). Sans ces
limites, un traitement qui dérape peut saturer tout le NAS au lieu de rester
contenu à ce conteneur.
