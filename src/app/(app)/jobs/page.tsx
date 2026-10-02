"use client";

import { useEffect, useState } from "react";

type Job = {
  id: string;
  file_path: string;
  status: string;
  max_dimension: number;
  quality: number;
  keep_original: number;
  original_size: number | null;
  optimized_size: number | null;
  error: string | null;
  log: string;
  created_at: string;
};

const STATUS_LABEL: Record<string, string> = {
  pending: "en attente",
  running: "en cours",
  done: "terminé ✅",
  error: "erreur ❌",
  cancelled: "annulé",
};

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-zinc-100 text-zinc-600",
  running: "bg-blue-100 text-blue-700",
  done: "bg-green-100 text-green-700",
  error: "bg-red-100 text-red-700",
  cancelled: "bg-zinc-100 text-zinc-500",
};

function formatSize(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function formatGain(before: number | null, after: number | null): string {
  if (before == null || after == null || before === 0) return "—";
  const pct = ((before - after) / before) * 100;
  return `${pct >= 0 ? "-" : "+"}${Math.abs(pct).toFixed(0)}%`;
}

const PAGE_SIZE = 25;

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [deletingPending, setDeletingPending] = useState(false);
  const [deletingDone, setDeletingDone] = useState(false);
  const [logJobId, setLogJobId] = useState<string | null>(null);

  async function load() {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (statusFilter) params.set("status", statusFilter);
    const res = await fetch(`/api/jobs?${params.toString()}`);
    const data = await res.json();
    setJobs(data.jobs ?? []);
    setTotal(data.total ?? 0);
    setStatusCounts(data.statusCounts ?? {});
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

  const pendingIds = jobs.filter((j) => j.status === "pending").map((j) => j.id);

  async function cancelSelected() {
    const ids = [...selected].filter((id) => pendingIds.includes(id));
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const res = await fetch("/api/jobs/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      setMessage(`${data.cancelled} job(s) annulé(s).`);
      setSelected(new Set());
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function deletePending() {
    setDeletingPending(true);
    try {
      const res = await fetch("/api/jobs/delete-pending", { method: "POST" });
      const data = await res.json();
      setMessage(`${data.deleted} job(s) en attente supprimé(s).`);
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
      setMessage(`${data.deleted} job(s) terminé(s) supprimé(s).`);
      await load();
    } finally {
      setDeletingDone(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const logJob = jobs.find((j) => j.id === logJobId) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">Traitements</h2>
        <p className="text-sm text-zinc-500">
          Un job = une photo en cours d&apos;optimisation ou déjà traitée.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-zinc-200 bg-white p-4 text-sm">
        {(["pending", "running", "done", "error", "cancelled"] as const).map((status) => (
          <button
            key={status}
            onClick={() => {
              setStatusFilter(status === statusFilter ? "" : status);
              setPage(1);
            }}
            className={`flex items-center gap-1.5 ${
              statusFilter === status ? "font-medium text-zinc-900 underline" : "text-zinc-500"
            }`}
          >
            {STATUS_LABEL[status]} : {statusCounts[status] ?? 0}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={cancelSelected}
          disabled={busy || selected.size === 0}
          className="rounded border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          Annuler la sélection ({selected.size})
        </button>
        <button
          onClick={deletePending}
          disabled={deletingPending}
          className="rounded border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {deletingPending ? "Suppression…" : "Supprimer tous les jobs en attente"}
        </button>
        <button
          onClick={deleteDone}
          disabled={deletingDone}
          className="rounded border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {deletingDone ? "Suppression…" : "Supprimer tous les jobs terminés"}
        </button>
        {message && <span className="text-sm text-zinc-600">{message}</span>}
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-zinc-500">
            <tr>
              <th className="px-4 py-2" />
              <th className="px-4 py-2">Fichier</th>
              <th className="px-4 py-2">Statut</th>
              <th className="px-4 py-2">Avant</th>
              <th className="px-4 py-2">Après</th>
              <th className="px-4 py-2">Gain</th>
              <th className="px-4 py-2">Créé le</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} className="border-t border-zinc-100">
                <td className="px-4 py-2">
                  {job.status === "pending" && (
                    <input
                      type="checkbox"
                      checked={selected.has(job.id)}
                      onChange={() => toggle(job.id)}
                    />
                  )}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-zinc-700">{job.file_path}</td>
                <td className="px-4 py-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_BADGE[job.status]}`}
                  >
                    {STATUS_LABEL[job.status] ?? job.status}
                  </span>
                </td>
                <td className="px-4 py-2 text-zinc-500">{formatSize(job.original_size)}</td>
                <td className="px-4 py-2 text-zinc-500">{formatSize(job.optimized_size)}</td>
                <td className="px-4 py-2 text-zinc-500">
                  {formatGain(job.original_size, job.optimized_size)}
                </td>
                <td className="px-4 py-2 text-zinc-400">{job.created_at}</td>
                <td className="px-4 py-2 text-right">
                  <button
                    onClick={() => setLogJobId(job.id)}
                    className="rounded border border-zinc-300 px-2 py-1 text-xs"
                  >
                    Détails
                  </button>
                </td>
              </tr>
            ))}
            {jobs.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-zinc-400">
                  Aucun job.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-zinc-500">{total} job(s) au total</span>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="rounded border border-zinc-300 px-3 py-1.5 disabled:opacity-40"
          >
            ← Précédent
          </button>
          <span className="text-zinc-500">
            Page {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="rounded border border-zinc-300 px-3 py-1.5 disabled:opacity-40"
          >
            Suivant →
          </button>
        </div>
      </div>

      {logJob && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setLogJobId(null)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
              <h3 className="text-sm font-semibold">{logJob.file_path}</h3>
              <button
                onClick={() => setLogJobId(null)}
                className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
              >
                ✕
              </button>
            </div>
            <div className="overflow-auto p-4">
              <p className="mb-2 text-xs text-zinc-500">
                Taille max : {logJob.max_dimension}px · Qualité : {logJob.quality} · Conserve
                l&apos;original : {logJob.keep_original ? "oui" : "non"}
              </p>
              <pre className="whitespace-pre-wrap break-all text-xs text-zinc-700">
                {logJob.log || "(vide)"}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
