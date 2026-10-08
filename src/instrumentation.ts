export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // libvips (utilisé par sharp) dimensionne par défaut son pool de threads
    // interne sur le nombre de cœurs CPU, même pour traiter une seule image à
    // la fois — indépendant du fait que les jobs applicatifs soient déjà
    // strictement séquentiels (voir startWorker : un seul job en cours à la
    // fois). Sur un NAS à CPU faible, un simple appel sharp() peut à lui seul
    // saturer tous les cœurs disponibles. Forcé à 1 : aucune perte de
    // parallélisme réel, juste un pic CPU par image en moins.
    const sharp = (await import("sharp")).default;
    sharp.concurrency(1);

    const { dataPersistence } = await import("@/lib/persistence");
    const persistence = dataPersistence();
    if (!persistence.ok) {
      console.warn(
        `ATTENTION : base de données non conservée (${persistence.reason}) — monte un dossier du NAS sur /data.`
      );
    }

    const { startWorker } = await import("@/lib/queue/worker");
    startWorker();
  }
}
