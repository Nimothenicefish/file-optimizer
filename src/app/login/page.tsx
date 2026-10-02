"use client";

import { Suspense, useState, type FormEvent } from "react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ASSET_VERSION } from "@/lib/asset-version";

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
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="username">Identifiant</Label>
        <Input
          id="username"
          autoComplete="username"
          autoFocus
          required
          className="h-10"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Mot de passe</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          className="h-10"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" size="lg" className="group h-10 w-full gap-2" disabled={submitting}>
        {submitting ? <Loader2 className="size-4 animate-spin" /> : <Lock className="size-4" />}
        Se connecter
        {!submitting && <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />}
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <div className="relative">
            <div className="absolute inset-0 -z-10 scale-150 rounded-full bg-primary/30 blur-2xl" />
            <Image
              src={`/logo.png?v=${ASSET_VERSION}`}
              alt=""
              width={72}
              height={72}
              className="rounded-[20px] shadow-xl"
              priority
            />
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">File Optimizer</h1>
            <p className="text-sm text-muted-foreground">Optimisation de photos en masse</p>
          </div>
        </div>

        <div className="panel p-6">
          <Suspense>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
