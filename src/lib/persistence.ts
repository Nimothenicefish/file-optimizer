import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/paths";

export type DataPersistence = { ok: true } | { ok: false; reason: string };

// Volume anonyme Docker : créé automatiquement pour "VOLUME /data" (voir
// Dockerfile) quand aucun volume n'est monté sur /data — vit dans
// .../volumes/<64 hex>/_data et disparaît à la recréation du conteneur
// (mise à jour), base comprise. Mesuré sur Docker : un bind mount ou un
// volume nommé ont un chemin lisible, jamais ce motif.
const ANONYMOUS_VOLUME_ROOT = /\/volumes\/[0-9a-f]{64}\/_data$/;

// "\040" dans /proc/self/mountinfo = espace (chemins échappés en octal).
function unescapeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

// Montage contenant `dir` d'après mountinfo (le plus spécifique), ou null.
export function findMount(mountinfo: string, dir: string): { root: string; mountPoint: string } | null {
  let best: { root: string; mountPoint: string } | null = null;
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 5) continue;
    const root = unescapeMountPath(fields[3]);
    const mountPoint = unescapeMountPath(fields[4]);
    const contains = dir === mountPoint || dir.startsWith(mountPoint.endsWith("/") ? mountPoint : mountPoint + "/");
    if (contains && (!best || mountPoint.length > best.mountPoint.length)) best = { root, mountPoint };
  }
  return best;
}

// La base (DATA_DIR) survivra-t-elle à une mise à jour du conteneur ? Faux
// si elle n'est sur aucun volume, ou sur un volume anonyme — typiquement un
// volume monté sur un autre chemin que /data dans docker-compose.yml.
// Toujours vrai hors Docker (npm run dev) : DATA_DIR est alors un dossier
// local ordinaire.
export function checkDataPersistence(
  mountinfo = readMountinfo(),
  dataDir = DATA_DIR,
  inDocker = fs.existsSync("/.dockerenv")
): DataPersistence {
  if (!inDocker || mountinfo == null) return { ok: true };
  const mount = findMount(mountinfo, path.resolve(dataDir));
  if (!mount || mount.mountPoint === "/") {
    return { ok: false, reason: `aucun volume n'est monté sur ${dataDir}` };
  }
  if (ANONYMOUS_VOLUME_ROOT.test(mount.root)) {
    return {
      ok: false,
      reason: `${dataDir} est un volume anonyme (aucun volume de docker-compose.yml n'y est monté)`,
    };
  }
  return { ok: true };
}

function readMountinfo(): string | null {
  try {
    return fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return null;
  }
}

declare global {
  var __dataPersistence__: DataPersistence | undefined;
}

// Les montages ne changent pas pendant la vie du conteneur : vérifié une fois.
export function dataPersistence(): DataPersistence {
  return (globalThis.__dataPersistence__ ??= checkDataPersistence());
}
