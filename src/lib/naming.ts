// Dossier de cache créé automatiquement par Synology DSM (miniatures/indexation
// des médias) dans chaque dossier qu'il scanne — à ignorer partout où l'app
// parcourt un volume potentiellement monté depuis un partage Synology.
export function isSynologyEaDir(name: string): boolean {
  return /^@?eadir$/i.test(name);
}

// Dossier créé par cette app elle-même pour conserver les originaux (voir
// src/lib/pipeline/optimizeImage.ts) — jamais traité comme un dossier à
// parcourir/scanner pour y trouver des photos à optimiser.
export const ORIGIN_FOLDER_NAME = "origin";
