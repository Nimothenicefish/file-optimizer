// Taille par défaut (plus grand côté, en pixels) au-delà de laquelle une
// image est redimensionnée pendant le décodage (voir src/lib/pipeline/
// optimizeImage.ts). Demander le resize() dans le même pipeline sharp que le
// décodage permet le "shrink-on-load" de libvips/libjpeg : la mémoire
// nécessaire dépend de la taille de SORTIE, pas de la taille source — une
// photo démesurée (ou aux métadonnées corrompues) ne peut pas faire exploser
// la mémoire du conteneur. Éditable par l'utilisateur par job (voir le
// formulaire d'optimisation) ; cette constante n'est que la valeur par défaut
// proposée dans l'UI.
export const DEFAULT_MAX_DIMENSION = 4000;

// Garde-fou résiduel contre des métadonnées de dimensions aberrantes/
// corrompues (pas un levier mémoire : le resize() s'en charge) — très
// généreux, ne bloque aucune photo réelle même à très haute résolution.
export const MAX_INPUT_PIXELS = 2_000_000_000;

export const DEFAULT_QUALITY = 85;
