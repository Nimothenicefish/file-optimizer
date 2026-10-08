import { TriangleAlert } from "lucide-react";
import { connection } from "next/server";
import { dataPersistence } from "@/lib/persistence";

// Bandeau affiché sur toutes les pages si la base (jobs, pause, bilan) ne
// survivra pas à une mise à jour du conteneur (voir src/lib/persistence.ts).
export async function DataPersistenceBanner() {
  // Vérifié à l'exécution dans le conteneur, jamais au build (les montages du
  // conteneur de build n'ont rien à voir avec ceux du NAS).
  await connection();
  const status = dataPersistence();
  if (status.ok) return null;
  return (
    <div className="mt-4 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <p>
        <span className="font-semibold">Base de données non conservée</span> : {status.reason}.
        L&apos;historique des jobs, l&apos;état de pause et le bilan seront perdus à la prochaine mise
        à jour du conteneur. Monte un dossier du NAS sur <code>/data</code> dans
        docker-compose.yml (ex : <code>/volume1/docker/file-optimizer/data:/data</code>).
      </p>
    </div>
  );
}
