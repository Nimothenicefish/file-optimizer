# trixie (Debian 13) plutôt que bookworm : son ffmpeg 7.1 recopie les pistes
# audio Opus avec leur horodatage exact, là où le 5.1 de bookworm les décale
# de quelques ms par rapport à la vidéo ré-encodée (mesuré — voir
# src/lib/pipeline/optimizeVideo.ts, qui rejetterait alors le résultat).
FROM node:22-trixie-slim AS base
WORKDIR /app
# ffmpeg/ffprobe (avec libx265) : ré-encodage des vidéos MKV (voir
# src/lib/pipeline/optimizeVideo.ts). Dans "base" et pas seulement dans
# "runner" : les tests vidéo tournent aussi au build (prebuild -> npm test).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
# better-sqlite3 compile ses bindings natifs via node-gyp (nécessite python3 + un compilateur C++).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS builder
COPY . .
# Échoue (et arrête le build de l'image) si les tests échouent — voir le
# script "prebuild" de package.json, exécuté automatiquement avant "build".
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV FILES_DIR=/files
# node:22-trixie-slim n'installe pas le paquet "locales" : sans ça, LANG est vide et
# les outils/bibliothèques sensibles au charset peuvent mal décoder un nom de
# fichier non-ASCII selon l'origine du volume monté (partage réseau, NAS).
# C.UTF-8 est un locale glibc intégré (pas besoin du paquet locales/locale-gen).
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# output: "standalone" ne copie PAS public/ automatiquement (seuls les
# fichiers tracés par Next y sont inclus) — sans cette ligne, logo/icônes/
# manifest répondent 404 en production alors qu'ils fonctionnent en `next dev`
# (qui sert public/ directement depuis l'arbre source, pas depuis standalone).
COPY --from=builder /app/public ./public

# Reste en root : simplifie l'écriture sur les volumes montés depuis l'hôte
# (bind mounts), dont l'UID ne correspond pas forcément à un user fixe dans
# l'image. Acceptable pour un outil auto-hébergé mono-utilisateur.
VOLUME ["/data", "/files"]
EXPOSE 3000
CMD ["node", "server.js"]
