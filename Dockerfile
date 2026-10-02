FROM node:22-slim AS base
WORKDIR /app

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
ENV PHOTOS_DIR=/photos
# node:22-slim n'installe pas le paquet "locales" : sans ça, LANG est vide et
# les outils/bibliothèques sensibles au charset peuvent mal décoder un nom de
# fichier non-ASCII selon l'origine du volume monté (partage réseau, NAS).
# C.UTF-8 est un locale glibc intégré (pas besoin du paquet locales/locale-gen).
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
# Pas de dossier public/ (aucun asset statique dans cette app) — contrairement
# à un copier-coller naïf du Dockerfile de scan-page, on ne copie pas un
# dossier vide : git ne suit pas les dossiers vides, "public/" n'existe donc
# pas dans l'image checkoutée en CI, et un COPY dessus échoue ("not found").
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Reste en root : simplifie l'écriture sur les volumes montés depuis l'hôte
# (bind mounts), dont l'UID ne correspond pas forcément à un user fixe dans
# l'image. Acceptable pour un outil auto-hébergé mono-utilisateur.
VOLUME ["/data", "/photos"]
EXPOSE 3000
CMD ["node", "server.js"]
