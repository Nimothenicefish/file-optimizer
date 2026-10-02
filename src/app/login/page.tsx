"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";

function LoginForm() {
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Échec de la connexion");
        return;
      }
      // Rechargement complet (pas de router.push) : repasse par le
      // middleware avec le cookie de session tout juste posé.
      window.location.href = next;
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-6 shadow-sm"
      >
        <h1 className="mb-1 text-lg font-semibold text-zinc-900">Optimize files</h1>
        <p className="mb-5 text-sm text-zinc-500">Connexion requise</p>

        <label className="mb-3 flex flex-col gap-1 text-sm text-zinc-700">
          Identifiant
          <input
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="rounded border border-zinc-300 px-3 py-2"
            required
          />
        </label>

        <label className="mb-4 flex flex-col gap-1 text-sm text-zinc-700">
          Mot de passe
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded border border-zinc-300 px-3 py-2"
            required
          />
        </label>

        {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {submitting ? "Connexion…" : "Se connecter"}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
