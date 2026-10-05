"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Eye,
  File,
  Film,
  Folder,
  Image as ImageIcon,
  Loader2,
  Pause,
  Play,
  RefreshCw,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { BatchEstimate } from "@/lib/eta";
import { formatRemaining, formatSize } from "@/lib/format";
import {
  CRF_LEVELS,
  DEFAULT_VIDEO_CRF,
  DEFAULT_VIDEO_PRESET,
  DEFAULT_VIDEO_PROFILE,
  VIDEO_PRESETS,
  VIDEO_TARGET_RATIO,
  describeCrf,
  type VideoPreset,
  type VideoProfile,
} from "@/lib/videoSettings";

type Mode = "image" | "video";

type Entry = {
  name: string;
  path: string;
  type: "directory" | "image" | "video" | "other";
  size?: number;
};

const MODE_NOUN: Record<Mode, string> = { image: "photo(s)", video: "vidéo(s)" };

// Onglet actif bien visible (même accent que les filtres de statut sur
// /jobs) : Radix pose data-state="active", que les styles "data-active:" par
// défaut du composant ne ciblent pas.
const MODE_TAB_CLASS =
  "px-3 data-[state=active]:bg-primary/15 data-[state=active]:text-primary dark:data-[state=active]:text-primary";

const PROFILE_LABEL: Record<VideoProfile, string> = { film: "Film", series: "Série (épisodes)" };

type BatchJob = {
  id: string;
  kind: string;
  status: string;
  original_size: number | null;
  optimized_size: number | null;
};

type BatchSummary = {
  images: number;
  videos: number;
  errors: number;
  cancelled: number;
  originalTotal: number;
  optimizedTotal: number;
};

// Lot en cours de suivi, mémorisé dans le navigateur : un encodage vidéo dure
// des heures, la page a toutes les chances d'être quittée/rechargée entre-
// temps — le suivi (et la modale de bilan) reprend au retour sur Parcourir.
// Simple confort : sans stockage disponible, le suivi reste limité à la page.
const BATCH_STORAGE_KEY = "file-optimizer:batch-ids";

function loadStoredBatch(): string[] | null {
  try {
    const ids = JSON.parse(localStorage.getItem(BATCH_STORAGE_KEY) ?? "null");
    return Array.isArray(ids) && ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

function storeBatch(ids: string[] | null) {
  try {
    if (ids && ids.length > 0) localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify(ids));
    else localStorage.removeItem(BATCH_STORAGE_KEY);
  } catch {
    // stockage indisponible (navigation privée...) : suivi non persistant
  }
}

function summaryLabel(summary: BatchSummary): string {
  const parts: string[] = [];
  if (summary.images > 0) parts.push(`${summary.images} photo(s)`);
  if (summary.videos > 0) parts.push(`${summary.videos} vidéo(s)`);
  return `${parts.join(" et ") || "Aucun fichier"} traitée(s)`;
}

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
  const [forceJpeg, setForceJpeg] = useState(false);

  // Mode "Photos" ou "Vidéos MKV" : détermine ce qui est sélectionnable/
  // scanné et les réglages affichés — jamais les deux à la fois, pour qu'un
  // scan de photos n'embarque pas un encodage vidéo de plusieurs heures.
  const [mode, setMode] = useState<Mode>("image");
  const [videoCrf, setVideoCrf] = useState(DEFAULT_VIDEO_CRF);
  const [videoPreset, setVideoPreset] = useState<VideoPreset>(DEFAULT_VIDEO_PRESET);
  const [videoProfile, setVideoProfile] = useState<VideoProfile>(DEFAULT_VIDEO_PROFILE);
  const [keepVideoSource, setKeepVideoSource] = useState(false);

  const [scanning, setScanning] = useState(false);
  const [enqueuing, setEnqueuing] = useState(false);

  const [batchIds, setBatchIds] = useState<string[] | null>(null);
  const [batchProgress, setBatchProgress] = useState<BatchEstimate | null>(null);
  const [queuePaused, setQueuePaused] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [summary, setSummary] = useState<BatchSummary | null>(null);

  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const imageEntries = entries.filter((e) => e.type === "image");
  const previewIndex = imageEntries.findIndex((e) => e.path === previewPath);
  const previewEntry = previewIndex >= 0 ? imageEntries[previewIndex] : null;

  function showPreviewAt(index: number) {
    if (imageEntries.length === 0) return;
    const next = (index + imageEntries.length) % imageEntries.length;
    setPreviewPath(imageEntries[next].path);
  }

  useEffect(() => {
    if (!previewEntry) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") showPreviewAt(previewIndex - 1);
      else if (e.key === "ArrowRight") showPreviewAt(previewIndex + 1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewIndex, previewEntry]);

  function startBatch(newIds: string[]) {
    if (newIds.length === 0) return;
    setBatchIds((prev) => (prev ? [...prev, ...newIds] : newIds));
  }

  useEffect(() => {
    const stored = loadStoredBatch();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- lecture du stockage navigateur, indisponible au rendu serveur
    if (stored) setBatchIds(stored);
  }, []);

  useEffect(() => {
    storeBatch(batchIds);
    if (!batchIds || batchIds.length === 0) return;
    let cancelled = false;

    async function poll() {
      const res = await fetch(`/api/jobs?ids=${batchIds!.join(",")}`);
      const data = await res.json();
      if (cancelled) return;
      const jobs: BatchJob[] = data.jobs ?? [];
      const terminal = jobs.filter((j) => j.status !== "pending" && j.status !== "running");
      setBatchProgress(data.batch ?? null);
      setQueuePaused(Boolean(data.paused));
      // Comparé aux jobs RETROUVÉS (pas aux ids demandés) : un job supprimé
      // depuis /jobs entre-temps ne bloque pas le bilan indéfiniment.
      if (terminal.length === jobs.length) {
        if (jobs.length === 0) {
          setBatchIds(null);
          return;
        }
        setSummary({
          images: jobs.filter((j) => j.kind !== "video").length,
          videos: jobs.filter((j) => j.kind === "video").length,
          errors: jobs.filter((j) => j.status === "error").length,
          cancelled: jobs.filter((j) => j.status === "cancelled").length,
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

  async function resumeQueue() {
    setResuming(true);
    try {
      const res = await fetch("/api/queue-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: false }),
      });
      const data = await res.json();
      setQueuePaused(Boolean(data.paused));
      toast.success("Traitement repris");
    } finally {
      setResuming(false);
    }
  }

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

  function selectAllHere() {
    setSelected((s) => {
      const next = new Set(s);
      for (const e of entries) {
        if (e.type === mode) next.add(e.path);
      }
      return next;
    });
  }

  function changeMode(nextMode: Mode) {
    setMode(nextMode);
    setSelected(new Set());
  }

  const settings = {
    maxDimension,
    quality,
    keepOriginal,
    forceJpeg,
    videoCrf,
    videoPreset,
    videoProfile,
    keepVideoSource,
  };

  async function scanFolder() {
    setScanning(true);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, mode, ...settings }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error("Échec du scan", { description: data.error });
        return;
      }
      const parts = [`${data.found} ${MODE_NOUN[mode]} trouvée(s)`, `${data.queued} mise(s) en file`];
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
        body: JSON.stringify({ paths: [...selected], ...settings }),
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
          sélectionne des fichiers précis en parcourant les dossiers.
        </p>
      </div>

      <Tabs value={mode} onValueChange={(v) => changeMode(v as Mode)}>
        <TabsList>
          <TabsTrigger value="image" className={MODE_TAB_CLASS}>
            <ImageIcon />
            Photos
          </TabsTrigger>
          <TabsTrigger value="video" className={MODE_TAB_CLASS}>
            <Film />
            Vidéos MKV
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {mode === "video" ? (
        <div className="panel flex flex-col gap-3 p-4">
          <h3 className="text-sm font-medium">Réglages vidéo (ré-encodage x265)</h3>
          <div className="flex flex-wrap items-end gap-5">
            <div className="space-y-1.5">
              <Label>Type de vidéo</Label>
              <Select value={videoProfile} onValueChange={(v) => setVideoProfile(v as VideoProfile)}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PROFILE_LABEL) as VideoProfile[]).map((p) => (
                    <SelectItem key={p} value={p}>
                      {PROFILE_LABEL[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-1">
                <Label htmlFor="videoCrf">Qualité (CRF, plus bas = meilleur)</Label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="À quoi correspond le CRF ?"
                    >
                      <CircleHelp className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="block max-w-sm space-y-2 p-3">
                    <p>
                      Le CRF fixe la qualité visée, pas la taille : x265 donne à chaque scène le
                      débit nécessaire pour atteindre cette qualité. Plus il est bas, plus
                      l&apos;image est fidèle et plus le fichier est gros. Repère : +6 ≈ fichier ~2×
                      plus petit.
                    </p>
                    <ul className="space-y-1">
                      {CRF_LEVELS.map((level, i) => (
                        <li key={level.max}>
                          <span className="font-semibold">
                            {i === 0 ? `≤ ${level.max}` : `${CRF_LEVELS[i - 1].max + 1}–${level.max}`}{" "}
                            · {level.label}
                          </span>{" "}
                          : {level.detail}
                        </li>
                      ))}
                    </ul>
                    <p>
                      Le plafond de taille du type de vidéo s&apos;applique toujours en plus : un CRF
                      bas ne fait jamais dépasser la taille maximale visée.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </div>
              <Input
                id="videoCrf"
                type="number"
                min={0}
                max={51}
                value={videoCrf}
                onChange={(e) => setVideoCrf(Number(e.target.value))}
                className="h-8 w-20"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Vitesse d&apos;encodage (preset)</Label>
              <Select value={videoPreset} onValueChange={(v) => setVideoPreset(v as VideoPreset)}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VIDEO_PRESETS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Label className="flex items-center gap-2 pb-1.5">
              <Checkbox
                checked={keepVideoSource}
                onCheckedChange={(c) => setKeepVideoSource(c === true)}
              />
              Conserver la source (renommée en .mkv.bkp)
            </Label>
          </div>
          <p className="text-xs">
            <span className="font-medium text-primary">
              CRF {videoCrf} · {describeCrf(videoCrf).label}
            </span>{" "}
            <span className="text-muted-foreground">: {describeCrf(videoCrf).detail}.</span>
          </p>
          <p className="text-xs text-muted-foreground">
            Seule la piste vidéo est ré-encodée en x265 : toutes les pistes audio, sous-titres,
            chapitres et polices sont recopiés à l&apos;identique, avec leurs horodatages d&apos;origine
            (vérifiés après encodage — au moindre écart, la source n&apos;est pas touchée).{" "}
            {videoProfile === "film"
              ? `Taille finale plafonnée à ${Math.round(VIDEO_TARGET_RATIO * 100)} % de la source (ex : 4 Go → 2,8 Go max).`
              : `Taille finale plafonnée d'après la durée de l'épisode (~440 Mo pour 20 min, ~800 Mo pour 50 min), et jamais plus de ${Math.round(VIDEO_TARGET_RATIO * 100)} % de la source.`}{" "}
            Un fichier déjà en HEVC/AV1/VP9 n&apos;est ré-encodé que s&apos;il est encore lourd pour
            son type (film : plus de ~1,4 Go par heure ; série : au-dessus du plafond), et jamais un
            fichier déjà produit par l&apos;app. L&apos;encodage tourne en priorité
            minimale pour ne pas gêner le NAS : compter plusieurs heures par film ; un preset plus
            rapide encode plus vite mais compresse moins.
          </p>
          {!keepVideoSource && (
            <p className="text-xs text-warning">
              Sans conservation de la source, le fichier d&apos;origine est remplacé définitivement
              par la version x265.
            </p>
          )}
        </div>
      ) : (
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
            <Label className="flex items-center gap-2 pb-1.5">
              <Checkbox checked={forceJpeg} onCheckedChange={(c) => setForceJpeg(c === true)} />
              Forcer la conversion en JPG
            </Label>
          </div>
          {forceJpeg && (
            <p className="text-xs text-muted-foreground">
              Convertit les PNG/WebP/AVIF en JPG (gain de place quasi garanti grâce à la compression
              à perte, mais perd la transparence éventuelle — fond blanc à la place). Sans effet sur
              un fichier déjà en JPEG.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
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
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => load(path)}
          disabled={loading}
          aria-label="Rafraîchir le dossier"
        >
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={scanFolder} disabled={scanning} className="gap-1.5">
          <ScanSearch className="size-4" />
          {scanning ? "Scan en cours…" : "Scanner ce dossier (récursif)"}
        </Button>
        <Button onClick={selectAllHere} variant="outline">
          Sélectionner les {mode === "video" ? "vidéos" : "photos"} de ce dossier
        </Button>
      </div>

      <div className="panel overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th className="w-10 px-4 py-2" />
              <th className="px-4 py-2 font-medium">Nom</th>
              <th className="px-4 py-2 font-medium">Taille</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                  Chargement…
                </td>
              </tr>
            )}
            {!loading &&
              entries.map((entry) => (
                <tr key={entry.path} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-2">
                    {entry.type === mode && (
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
                        className={`flex items-center gap-2 ${entry.type !== mode ? "text-muted-foreground" : ""}`}
                      >
                        {entry.type === "image" ? (
                          <ImageIcon className="size-4 text-muted-foreground" />
                        ) : entry.type === "video" ? (
                          <Film className="size-4 text-muted-foreground" />
                        ) : (
                          <File className="size-4 text-muted-foreground" />
                        )}
                        {entry.name}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{formatSize(entry.size)}</td>
                  <td className="px-4 py-2 text-right">
                    {entry.type === "image" && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setPreviewPath(entry.path)}
                        aria-label="Voir l'image"
                      >
                        <Eye className="size-4" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            {!loading && entries.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                  Dossier vide.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected.size > 0 && (
        <div className="panel sticky bottom-4 flex flex-wrap items-center gap-3 p-4">
          <span className="text-sm font-medium">
            {selected.size} {MODE_NOUN[mode]} sélectionnée(s)
          </span>
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
        <div className="panel sticky bottom-4 flex flex-col gap-2 p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {queuePaused ? (
              <Pause className="size-4 text-warning" />
            ) : (
              <Loader2 className="size-4 animate-spin text-primary" />
            )}
            <span className="text-sm font-medium">
              {queuePaused ? "Traitement en pause" : "Optimisation en cours…"}{" "}
              {batchProgress && `${batchProgress.done} / ${batchProgress.total}`}
            </span>
            {batchProgress && (
              <span className="ml-auto text-sm text-muted-foreground">
                {Math.floor(batchProgress.percent)} %
                {!queuePaused && batchProgress.remainingMs != null && batchProgress.remainingMs > 0
                  ? ` · ${formatRemaining(batchProgress.remainingMs)} restant`
                  : ""}
              </span>
            )}
            {queuePaused && (
              <Button size="sm" onClick={resumeQueue} disabled={resuming} className="gap-1.5">
                <Play className="size-4" />
                {resuming ? "…" : "Reprendre"}
              </Button>
            )}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full transition-[width] duration-700 ${queuePaused ? "bg-warning" : "bg-primary"}`}
              style={{ width: `${batchProgress?.percent ?? 0}%` }}
            />
          </div>
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
              {summary && summaryLabel(summary)}
              {summary && summary.errors > 0 ? `, dont ${summary.errors} en erreur` : ""}
              {summary && summary.cancelled > 0 ? `, ${summary.cancelled} annulé(s)` : ""}.
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

      <Dialog open={previewEntry != null} onOpenChange={(open) => !open && setPreviewPath(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="truncate pr-8">{previewEntry?.name}</DialogTitle>
            <DialogDescription>
              {formatSize(previewEntry?.size)}
              {imageEntries.length > 1 ? ` · ${previewIndex + 1} / ${imageEntries.length}` : ""}
            </DialogDescription>
          </DialogHeader>
          {previewEntry && (
            <div className="relative flex items-center justify-center">
              {imageEntries.length > 1 && (
                <Button
                  variant="outline"
                  size="icon"
                  className="absolute left-2 top-1/2 -translate-y-1/2 bg-background/80"
                  onClick={() => showPreviewAt(previewIndex - 1)}
                  aria-label="Image précédente"
                >
                  <ChevronLeft className="size-4" />
                </Button>
              )}
              {/* eslint-disable-next-line @next/next/no-img-element -- source dynamique sous FILES_DIR, pas un asset Next optimisable */}
              <img
                src={`/api/file?path=${encodeURIComponent(previewEntry.path)}`}
                alt={previewEntry.name}
                className="max-h-[70vh] w-auto rounded-lg object-contain"
              />
              {imageEntries.length > 1 && (
                <Button
                  variant="outline"
                  size="icon"
                  className="absolute right-2 top-1/2 -translate-y-1/2 bg-background/80"
                  onClick={() => showPreviewAt(previewIndex + 1)}
                  aria-label="Image suivante"
                >
                  <ChevronRight className="size-4" />
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
