import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestApp, setupTestApp } from "../helpers/testApp";

let tmpDir: string;
let loginRoute: typeof import("@/app/api/auth/login/route");

beforeAll(async () => {
  const app = await setupTestApp("file-optimizer-login-test-");
  tmpDir = app.tmpDir;
  loginRoute = await import("@/app/api/auth/login/route");
});

afterAll(() => {
  cleanupTestApp(tmpDir);
});

function loginRequest(password: string) {
  return loginRoute.POST(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test-admin", password }),
    })
  );
}

describe("anti-bruteforce login", () => {
  it("les 5 premières tentatives échouées passent librement (401, pas de blocage)", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await loginRequest("wrong");
      expect(res.status).toBe(401);
    }
  });

  it("la 6e tentative échouée déclenche le seuil : la suivante est bloquée même avec le bon mot de passe", async () => {
    const sixth = await loginRequest("wrong");
    expect(sixth.status).toBe(401);

    const blocked = await loginRequest("test-secret");
    expect(blocked.status).toBe(429);
    const data = await blocked.json();
    expect(data.error).toMatch(/Trop de tentatives/);
  });

  it("le blocage disparaît une fois le délai écoulé, et une connexion réussie remet le compteur à zéro", async () => {
    const { db } = await import("@/lib/db");
    // Simule l'écoulement du délai plutôt que d'attendre réellement 5s.
    db.prepare("UPDATE login_attempts SET last_failed_at = datetime('now', '-1 hour') WHERE id = 1").run();

    const res = await loginRequest("test-secret");
    expect(res.status).toBe(200);

    const row = db.prepare("SELECT failed_count, last_failed_at FROM login_attempts WHERE id = 1").get() as {
      failed_count: number;
      last_failed_at: string | null;
    };
    expect(row.failed_count).toBe(0);
    expect(row.last_failed_at).toBeNull();
  });
});
