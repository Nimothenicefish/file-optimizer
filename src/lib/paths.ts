import path from "node:path";

// Base SQLite uniquement — jamais les fichiers eux-mêmes, pour que la base
// puisse être réinitialisée/déplacée sans jamais toucher à la bibliothèque.
// Volume Docker séparé de FILES_DIR.
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), "data");

// Racine de la bibliothèque à parcourir/optimiser (photos, puis vidéos) —
// volume Docker monté en lecture/écriture (l'app modifie les fichiers en place).
export const FILES_DIR = process.env.FILES_DIR
  ? path.resolve(process.env.FILES_DIR)
  : path.join(process.cwd(), "files");
