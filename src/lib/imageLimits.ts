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

// Au-delà de ce rapport longueur/largeur, une image est "très allongée"
// (bande de webtoon/manga, capture d'écran défilante, panorama) : la taille
// max s'applique alors à son PLUS PETIT côté. Appliquée au plus grand, elle
// écraserait la largeur (720x15000 -> 192x4000 avec 4000px) et rendrait le
// contenu flou, texte illisible.
export const ELONGATED_RATIO = 3;

export type ResizePlan = {
  // Côté à ramener à maxDimension (l'autre suit, proportions conservées).
  side: "width" | "height";
  elongated: boolean;
};

// Faut-il redimensionner, et selon quel côté ? null si l'image respecte déjà
// la limite (jamais d'agrandissement).
export function planResize(width: number, height: number, maxDimension: number): ResizePlan | null {
  if (width <= 0 || height <= 0) return null;
  const elongated = Math.max(width, height) / Math.min(width, height) > ELONGATED_RATIO;
  // Image classique : on limite le plus grand côté ; très allongée : le plus
  // petit.
  const limitWidth = elongated ? width <= height : width >= height;
  const limited = limitWidth ? width : height;
  if (limited <= maxDimension) return null;
  return { side: limitWidth ? "width" : "height", elongated };
}
