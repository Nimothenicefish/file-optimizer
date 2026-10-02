import path from "node:path";

// Base SQLite uniquement — jamais les photos elles-mêmes, pour que la base
// puisse être réinitialisée/déplacée sans jamais toucher à la bibliothèque de
// photos (et inversement). Volume Docker séparé de PHOTOS_DIR.
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), "data");

// Racine de la bibliothèque de photos à parcourir/optimiser — volume Docker
// monté en lecture/écriture (l'app modifie les fichiers en place).
export const PHOTOS_DIR = process.env.PHOTOS_DIR
  ? path.resolve(process.env.PHOTOS_DIR)
  : path.join(process.cwd(), "photos");
