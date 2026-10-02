import { defineConfig } from "vitest/config";

// Environnement Node (pas de DOM) : ces tests couvrent la logique métier et
// les routes API, pas le rendu React. resolve.tsconfigPaths résout l'alias
// "@/..." (défini dans tsconfig.json) nativement, sans plugin ni duplication.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Chaque fichier de test tourne dans son propre process (isole les
    // singletons globalThis.__db__ / __queueStarted__ de src/lib/db et
    // src/lib/queue/worker.ts, qui dépendent de DATA_DIR/FILES_DIR définis
    // par test).
    pool: "forks",
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
