"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronRight,
  File,
  Folder,
  Image as ImageIcon,
  Loader2,
  ScanSearch,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatSize } from "@/lib/format";

type Entry = {
  name: string;
  path: string;
  type: "directory" | "image" | "other";
  size?: number;
};

type BatchJob = {
  id: string;
  status: string;
  original_size: number | null;
  optimized_size: number | null;
};

type BatchSummary = {
  count: number;
  errors: number;
  originalTotal: number;
  optimizedTotal: number;
};

function breadcrumbs(path: string): Array<{ label: string; path: string }> {
  const parts = path ? path.split("/") : [];
  const crumbs = [{ label: "Racine", path: "" }];
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

export default function BrowsePage() {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [maxDimension, setMaxDimension] = useState(4000);
  const [quality, setQuality] = useState(85);
  const [keepOriginal, setKeepOriginal] = useState(true);

  const [scanning, setScanning] = useState(false);
  const [enqueuing, setEnqueuing] = useState(false);

  const [batchIds, setBatchIds] = useState<string[] | null>(null);
  const [batchProgress, setBatchProgress] = useState({ done: 0, total: 0 });
  const [summary, setSummary] = useState<BatchSummary | null>(null);

  function startBatch(newIds: string[]) {
    if (newIds.length === 0) return;
    setBatchIds((prev) => (prev ? [...prev, ...newIds] : newIds));
  }

  useEffect(() => {
    if (!batchIds || batchIds.length === 0) return;
    let cancelled = false;

    async function poll() {
      const res = await fetch(`/api/jobs?ids=${batchIds!.join(",")}`);
      const data = await res.json();
      if (cancelled) return;
      const jobs: BatchJob[] = data.jobs ?? [];
      const terminal = jobs.filter((j) => j.status !== "pending" && j.status !== "running");
      setBatchProgress({ done: terminal.length, total: batchIds!.length });
      if (jobs.length === batchIds!.length && terminal.length === jobs.length) {
        setSummary({
          count: jobs.length,
          errors: jobs.filter((j) => j.status === "error" || j.status === "cancelled").length,
          originalTotal: jobs.reduce((sum, j) => sum + (j.original_size ?? 0), 0),
          optimizedTotal: jobs.reduce((sum, j) => sum + (j.optimized_size ?? 0), 0),
        });
        setBatchIds(null);
      }
    }

    poll();
    const interval = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [batchIds]);

  const load = useCallback(async (nextPath: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/browse?path=${encodeURIComponent(nextPath)}`);
      const data = await res.json();
      setEntries(data.entries ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  function toggleSelect(entryPath: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(entryPath)) next.delete(entryPath);
      else next.add(entryPath);
      return next;
    });
  }

  function selectAllImagesHere() {
    setSelected((s) => {
      const next = new Set(s);
      for (const e of entries) {
        if (e.type === "image") next.add(e.path);
      }
      return next;
    });
  }

  async function scanFolder() {
    setScanning(true);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, maxDimension, quality, keepOriginal }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error("Échec du scan", { description: data.error });
        return;
      }
      const parts = [`${data.found} photo(s) trouvée(s)`, `${data.queued} mise(s) en file`];
      if (data.skippedAlreadyQueued > 0) parts.push(`${data.skippedAlreadyQueued} déjà en file`);
      toast.success(parts.join(", "));
      startBatch(data.ids ?? []);
    } finally {
      setScanning(false);
    }
  }

  async function optimizeSelection() {
    if (selected.size === 0) return;
    setEnqueuing(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: [...selected], maxDimension, quality, keepOriginal }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error("Échec de la mise en file", { description: data.error });
        return;
      }
      const parts = [`${data.queued} mise(s) en file`];
      if (data.skippedAlreadyQueued > 0) parts.push(`${data.skippedAlreadyQueued} déjà en file`);
      toast.success(parts.join(", "));
      startBatch(data.ids ?? []);
      setSelected(new Set());
    } finally {
      setEnqueuing(false);
    }
  }

  return (
    <div className="flex flex-col gap-5 py-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Parcourir</h2>
        <p className="text-sm text-muted-foreground">
          Scanne un dossier entier (sous-dossiers compris) pour tout optimiser d&apos;un coup, ou
          sélectionne des photos précises en parcourant les dossiers.
        </p>
      </div>

      <div className="panel flex flex-col gap-3 p-4">
        <h3 className="text-sm font-medium">Réglages</h3>
        <div className="flex flex-wrap items-end gap-5">
          <div className="space-y-1.5">
            <Label htmlFor="maxDimension">Taille max (plus grand côté)</Label>
            <div className="flex items-center gap-1.5">
              <Input
                id="maxDimension"
                type="number"
                min={100}
                max={20000}
                value={maxDimension}
                onChange={(e) => setMaxDimension(Number(e.target.value))}
                className="h-8 w-24"
              />
              <span className="text-sm text-muted-foreground">px</span>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quality">Qualité (JPEG/WebP/AVIF)</Label>
            <Input
              id="quality"
              type="number"
              min={1}
              max={100}
              value={quality}
              onChange={(e) => setQuality(Number(e.target.value))}
              className="h-8 w-20"
            />
          </div>
          <Label className="flex items-center gap-2 pb-1.5">
            <Checkbox checked={keepOriginal} onCheckedChange={(c) => setKeepOriginal(c === true)} />
            Conserver les originaux (dossier &quot;origin&quot;)
          </Label>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1 text-sm">
        {breadcrumbs(path).map((crumb, i, arr) => (
          <span key={crumb.path} className="flex items-center gap-1">
            <button
              onClick={() => setPath(crumb.path)}
              className={
                i === arr.length - 1
                  ? "rounded-md px-1.5 py-0.5 font-medium text-foreground"
                  : "rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              }
            >
              {crumb.label}
            </button>
            {i < arr.length - 1 && <ChevronRight className="size-3.5 text-muted-foreground/60" />}
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={scanFolder} disabled={scanning} className="gap-1.5">
          <ScanSearch className="size-4" />
          {scanning ? "Scan en cours…" : "Scanner ce dossier (récursif)"}
        </Button>
        <Button onClick={selectAllImagesHere} variant="outline">
          Sélectionner les photos de ce dossier
        </Button>
      </div>

      <div className="panel overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th className="w-10 px-4 py-2" />
              <th className="px-4 py-2 font-medium">Nom</th>
              <th className="px-4 py-2 font-medium">Taille</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">
                  Chargement…
                </td>
              </tr>
            )}
            {!loading &&
              entries.map((entry) => (
                <tr key={entry.path} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-2">
                    {entry.type === "image" && (
                      <Checkbox
                        checked={selected.has(entry.path)}
                        onCheckedChange={() => toggleSelect(entry.path)}
                      />
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {entry.type === "directory" ? (
                      <button
                        onClick={() => setPath(entry.path)}
                        className="flex items-center gap-2 font-medium text-foreground hover:text-primary"
                      >
                        <Folder className="size-4 text-primary" />
                        {entry.name}
                      </button>
                    ) : (
                      <span
                        className={`flex items-center gap-2 ${entry.type === "other" ? "text-muted-foreground" : ""}`}
                      >
                        {entry.type === "image" ? (
                          <ImageIcon className="size-4 text-muted-foreground" />
                        ) : (
                          <File className="size-4 text-muted-foreground" />
                        )}
                        {entry.name}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{formatSize(entry.size)}</td>
                </tr>
              ))}
            {!loading && entries.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">
                  Dossier vide.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected.size > 0 && (
        <div className="panel sticky bottom-4 flex flex-wrap items-center gap-3 p-4">
          <span className="text-sm font-medium">{selected.size} photo(s) sélectionnée(s)</span>
          <Button variant="outline" size="sm" onClick={() => setSelected(new Set())} className="gap-1.5">
            <X className="size-4" />
            Vider la sélection
          </Button>
          <Button onClick={optimizeSelection} disabled={enqueuing} className="ml-auto">
            {enqueuing ? "Mise en file…" : `Optimiser la sélection (${selected.size})`}
          </Button>
        </div>
      )}

      {batchIds && (
        <div className="panel sticky bottom-4 flex items-center gap-3 p-4">
          <Loader2 className="size-4 animate-spin text-primary" />
          <span className="text-sm font-medium">
            Optimisation en cours… {batchProgress.done} / {batchProgress.total}
          </span>
        </div>
      )}

      <Dialog open={summary != null} onOpenChange={(open) => !open && setSummary(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-5 text-primary" />
              Optimisation terminée
            </DialogTitle>
            <DialogDescription>
              {summary?.count} photo(s) traitée(s)
              {summary && summary.errors > 0 ? `, dont ${summary.errors} en erreur` : ""}.
            </DialogDescription>
          </DialogHeader>
          {summary && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="panel p-3">
                <p className="text-xs text-muted-foreground">Avant</p>
                <p className="text-lg font-semibold">{formatSize(summary.originalTotal)}</p>
              </div>
              <div className="panel p-3">
                <p className="text-xs text-muted-foreground">Après</p>
                <p className="text-lg font-semibold">{formatSize(summary.optimizedTotal)}</p>
              </div>
              <div className="col-span-2 rounded-xl border border-primary/30 bg-primary/10 p-3 text-center">
                <p className="text-xs text-muted-foreground">Espace gagné</p>
                <p className="text-2xl font-bold text-primary">
                  {formatSize(Math.max(0, summary.originalTotal - summary.optimizedTotal))}
                </p>
                {summary.originalTotal > 0 && (
                  <p className="text-xs text-muted-foreground">
                    -
                    {Math.round(
                      ((summary.originalTotal - summary.optimizedTotal) / summary.originalTotal) * 100
                    )}
                    %
                  </p>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
