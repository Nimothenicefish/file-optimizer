"use client";

import { useEffect, useState } from "react";
import { Ban, Pause, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatGain, formatRemaining, formatSize } from "@/lib/format";
import type { KindStats, Stats } from "@/lib/stats";

type Job = {
  id: string;
  file_path: string;
  status: string;
  max_dimension: number;
  quality: number;
  keep_original: number;
  force_jpeg: number;
  kind: string;
  video_crf: number | null;
  video_preset: string | null;
  video_profile: string | null;
  progress: number | null;
  cancel_requested: number;
  remaining_ms: number | null;
  paused_at: number | null;
  original_size: number | null;
  optimized_size: number | null;
  error: string | null;
  log: string;
  created_at: string;
};

const STATUS_LABEL: Record<string, string> = {
  pending: "en attente",
  running: "en cours",
  done: "terminé",
  error: "erreur",
  cancelled: "annulé",
};

const STATUS_VARIANT: Record<string, "secondary" | "default" | "destructive" | "outline"> = {
  pending: "secondary",
  running: "default",
  done: "outline",
  error: "destructive",
  cancelled: "secondary",
};

const PAGE_SIZE = 25;

const PROFILE_LABEL: Record<string, string> = { auto: "auto", film: "film", series: "série" };

// Bilan cumulé d'un type de média (voir src/lib/stats.ts) : survit à la
// suppression des jobs terminés.
function KindStatsCard({ label, stats }: { label: string; stats: KindStats }) {
  const avgGain =
    stats.originalBytes > 0 ? Math.round((stats.savedBytes / stats.originalBytes) * 100) : null;
  return (
    <div className="rounded-xl border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{formatSize(stats.savedBytes)} gagnés</p>
      <p className="text-xs text-muted-foreground">
        {stats.optimized} réduit(s) sur {stats.processed} traité(s)
        {avgGain != null ? ` · -${avgGain} % en moyenne` : ""}
      </p>
    </div>
  );
}

// Libellé d'un job en cours : étape et avancement (vidéo), null sinon.
function runningLabel(job: Job): string | null {
  if (job.status !== "running") return null;
  if (job.cancel_requested) return "annulation…";
  if (job.progress == null) return job.paused_at != null ? "en pause" : null;
  if (job.progress >= 100) return job.paused_at != null ? "en pause (vérification)" : "vérification…";
  return `${job.paused_at != null ? "en pause" : "en cours"} ${Math.floor(job.progress)} %`;
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [deletingPending, setDeletingPending] = useState(false);
  const [deletingDone, setDeletingDone] = useState(false);
  const [deletingCancelled, setDeletingCancelled] = useState(false);
  const [logJobId, setLogJobId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [togglingPause, setTogglingPause] = useState(false);

  async function load() {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (statusFilter) params.set("status", statusFilter);
    const res = await fetch(`/api/jobs?${params.toString()}`);
    const data = await res.json();
    setJobs(data.jobs ?? []);
    setTotal(data.total ?? 0);
    setStatusCounts(data.statusCounts ?? {});
    setPaused(Boolean(data.paused));
    setStats(data.stats ?? null);
  }

  async function togglePause() {
    setTogglingPause(true);
    try {
      const res = await fetch("/api/queue-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: !paused }),
      });
      const data = await res.json();
      setPaused(Boolean(data.paused));
      toast.success(data.paused ? "Traitement mis en pause" : "Traitement repris");
    } finally {
      setTogglingPause(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, statusFilter]);

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // En attente (annulé immédiatement) ou en cours (interrompu par le worker
  // dans la seconde, fichier d'origine laissé intact).
  const isCancellable = (j: Job) => j.status === "pending" || j.status === "running";
  const cancellableIds = jobs.filter(isCancellable).map((j) => j.id);

  async function cancelJobs(ids: string[]) {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const res = await fetch("/api/jobs/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      const parts: string[] = [];
      if (data.cancelled > 0) parts.push(`${data.cancelled} job(s) annulé(s)`);
      if (data.cancelling > 0) parts.push(`${data.cancelling} job(s) en cours d'interruption`);
      toast.success(parts.join(", ") || "Rien à annuler (job déjà terminé)");
      setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))));
      await load();
    } finally {
      setBusy(false);
    }
  }

  function cancelSelected() {
    return cancelJobs([...selected].filter((id) => cancellableIds.includes(id)));
  }

  async function deletePending() {
    setDeletingPending(true);
    try {
      const res = await fetch("/api/jobs/delete-pending", { method: "POST" });
      const data = await res.json();
      toast.success(`${data.deleted} job(s) en attente supprimé(s)`);
      await load();
    } finally {
      setDeletingPending(false);
    }
  }

  async function deleteDone() {
    setDeletingDone(true);
    try {
      const res = await fetch("/api/jobs/delete-done", { method: "POST" });
      const data = await res.json();
      toast.success(`${data.deleted} job(s) terminé(s) supprimé(s)`);
      await load();
    } finally {
      setDeletingDone(false);
    }
  }

  async function deleteCancelled() {
    setDeletingCancelled(true);
    try {
      const res = await fetch("/api/jobs/delete-cancelled", { method: "POST" });
      const data = await res.json();
      toast.success(`${data.deleted} job(s) annulé(s) supprimé(s)`);
      await load();
    } finally {
      setDeletingCancelled(false);
    }
  }

  // Retire un job terminé/en erreur/annulé de l'historique (aucun fichier
  // touché) ; un job en attente ou en cours doit d'abord être annulé.
  async function deleteJob(id: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/jobs/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      });
      const data = await res.json();
      if (data.deleted > 0) toast.success("Job supprimé");
      if (logJobId === id) setLogJobId(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const logJob = jobs.find((j) => j.id === logJobId) ?? null;

  return (
    <div className="flex flex-col gap-5 py-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Traitements</h2>
        <p className="text-sm text-muted-foreground">
          Un job = une photo ou une vidéo en cours d&apos;optimisation ou déjà traitée.
        </p>
      </div>

      {stats && (
        <div className="panel grid gap-3 p-4 sm:grid-cols-3">
          <div className="rounded-xl border border-primary/30 bg-primary/10 p-3">
            <p className="text-xs text-muted-foreground">Espace gagné au total</p>
            <p className="text-2xl font-bold text-primary">
              {formatSize(stats.image.savedBytes + stats.video.savedBytes)}
            </p>
            <p className="text-xs text-muted-foreground">
              {stats.image.processed + stats.video.processed} fichier(s) traité(s)
            </p>
          </div>
          <KindStatsCard label="Photos" stats={stats.image} />
          <KindStatsCard label="Vidéos" stats={stats.video} />
        </div>
      )}

      <div className="panel flex flex-wrap items-center gap-3 p-4">
        <Button
          variant={paused ? "default" : "outline"}
          size="sm"
          onClick={togglePause}
          disabled={togglingPause}
          className="gap-1.5"
        >
          {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
          {togglingPause ? "…" : paused ? "Reprendre le traitement" : "Mettre en pause le traitement"}
        </Button>
        {paused && (
          <span className="text-sm text-warning">
            En pause — aucun nouveau job ne démarre ; une vidéo en cours est gelée et reprendra
            là où elle en est (une photo en cours se termine).
          </span>
        )}
      </div>

      <div className="panel flex flex-wrap items-center gap-4 p-4 text-sm">
        {(["pending", "running", "done", "error", "cancelled"] as const).map((status) => (
          <button
            key={status}
            onClick={() => {
              setStatusFilter(status === statusFilter ? "" : status);
              setPage(1);
            }}
            className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 ${
              statusFilter === status
                ? "bg-primary/15 font-medium text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {STATUS_LABEL[status]} : {statusCounts[status] ?? 0}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={cancelSelected}
          disabled={busy || selected.size === 0}
          className="gap-1.5"
        >
          <Ban className="size-4" />
          Annuler la sélection ({selected.size})
        </Button>
        <Button variant="outline" size="sm" onClick={deletePending} disabled={deletingPending} className="gap-1.5">
          <Trash2 className="size-4" />
          {deletingPending ? "Suppression…" : "Supprimer les jobs en attente"}
        </Button>
        <Button variant="outline" size="sm" onClick={deleteDone} disabled={deletingDone} className="gap-1.5">
          <Trash2 className="size-4" />
          {deletingDone ? "Suppression…" : "Supprimer les jobs terminés"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={deleteCancelled}
          disabled={deletingCancelled}
          className="gap-1.5"
        >
          <Trash2 className="size-4" />
          {deletingCancelled ? "Suppression…" : "Supprimer les jobs annulés"}
        </Button>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th className="px-4 py-2" />
              <th className="px-4 py-2 font-medium">Fichier</th>
              <th className="px-4 py-2 font-medium">Statut</th>
              <th className="px-4 py-2 font-medium">Avant</th>
              <th className="px-4 py-2 font-medium">Après</th>
              <th className="px-4 py-2 font-medium">Gain</th>
              <th className="px-4 py-2 font-medium">Créé le</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                <td className="px-4 py-2">
                  {isCancellable(job) && (
                    <Checkbox checked={selected.has(job.id)} onCheckedChange={() => toggle(job.id)} />
                  )}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-foreground">{job.file_path}</td>
                <td className="px-4 py-2">
                  <Badge variant={STATUS_VARIANT[job.status] ?? "secondary"}>
                    {runningLabel(job) ?? STATUS_LABEL[job.status] ?? job.status}
                  </Badge>
                  {job.status === "running" && !job.cancel_requested && job.remaining_ms != null && job.remaining_ms > 0 && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {formatRemaining(job.remaining_ms)} restant
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-muted-foreground">{formatSize(job.original_size)}</td>
                <td className="px-4 py-2 text-muted-foreground">{formatSize(job.optimized_size)}</td>
                <td className="px-4 py-2 text-muted-foreground">
                  {formatGain(job.original_size, job.optimized_size)}
                </td>
                <td className="px-4 py-2 text-muted-foreground">{job.created_at}</td>
                <td className="px-4 py-2 text-right">
                  <div className="flex justify-end gap-2">
                    {job.status === "running" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => cancelJobs([job.id])}
                        disabled={busy || job.cancel_requested === 1}
                        className="gap-1.5"
                      >
                        <Ban className="size-4" />
                        Annuler
                      </Button>
                    )}
                    <Button variant="outline" size="sm" onClick={() => setLogJobId(job.id)}>
                      Détails
                    </Button>
                    {!isCancellable(job) && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => deleteJob(job.id)}
                        disabled={busy}
                        aria-label="Supprimer ce job"
                        title="Supprimer ce job (le fichier n'est pas touché)"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {jobs.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-muted-foreground">
                  Aucun job.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{total} job(s) au total</span>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            ← Précédent
          </Button>
          <span className="text-muted-foreground">
            Page {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
          >
            Suivant →
          </Button>
        </div>
      </div>

      <Dialog open={logJob != null} onOpenChange={(open) => !open && setLogJobId(null)}>
        {/* grid-cols-1 = minmax(0, 1fr) : sans lui, la colonne de la grille
            s'élargit jusqu'au contenu le plus large (long chemin, longue
            ligne de log) et déborde de la modale. */}
        <DialogContent className="max-h-[85vh] grid-cols-1 overflow-hidden sm:max-w-2xl">
          <DialogHeader className="min-w-0">
            {/* Chemin complet sur plusieurs lignes (lisible en entier) ; pr-8
                laisse la place au bouton de fermeture. */}
            <DialogTitle className="pr-8 font-mono text-sm leading-snug break-all">
              {logJob?.file_path}
            </DialogTitle>
            <DialogDescription className="break-words">
              {logJob?.kind === "video" ? (
                <>
                  Vidéo x265 ({PROFILE_LABEL[logJob.video_profile ?? ""] ?? "film"}) · CRF :{" "}
                  {logJob.video_crf} · Preset : {logJob.video_preset} · Conserve
                  la source (.mkv.bkp) : {logJob.keep_original ? "oui" : "non"}
                </>
              ) : (
                <>
                  Taille max : {logJob?.max_dimension}px · Qualité : {logJob?.quality} · Conserve
                  l&apos;original : {logJob?.keep_original ? "oui" : "non"} · Force JPG :{" "}
                  {logJob?.force_jpeg ? "oui" : "non"}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] min-w-0 overflow-x-hidden overflow-y-auto rounded-lg bg-muted p-3 text-xs break-words whitespace-pre-wrap text-foreground">
            {logJob?.log || "(vide)"}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}
