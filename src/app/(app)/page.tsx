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
  SearchCheck,
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
import type { AnalysisItem, AnalysisResult } from "@/lib/videoAnalysis";
import { formatRemaining, formatSize } from "@/lib/format";
import {
  AUTO_SERIES_MAX_DURATION_S,
  CRF_LEVELS,
  DEFAULT_VIDEO_CRF,
  DEFAULT_VIDEO_PRESET,
  DEFAULT_VIDEO_PROFILE,
  VIDEO_PRESETS,
  VIDEO_TARGET_RATIO,
  describeCrf,
  isVideoPreset,
  isVideoProfile,
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

const PROFILE_LABEL: Record<VideoProfile, string> = {
  auto: "Auto (d'après la durée)",
  film: "Film",
  series: "Série (épisodes)",
};

const FILM_CAP_TEXT = `film : ${Math.round(VIDEO_TARGET_RATIO * 100)} % de la source (ex : 4 Go → 2,8 Go max)`;
const SERIES_CAP_TEXT =
  "série : d'après la durée de l'épisode (~440 Mo pour 20 min, ~800 Mo pour 50 min)";

function profileCapText(profile: VideoProfile): string {
  if (profile === "film") return `Taille finale plafonnée (${FILM_CAP_TEXT}).`;
  if (profile === "series") {
    return `Taille finale plafonnée (${SERIES_CAP_TEXT}), et jamais plus de ${Math.round(
      VIDEO_TARGET_RATIO * 100
    )} % de la source.`;
  }
  return `Type choisi pour chaque vidéo d'après sa durée : moins de ${
    AUTO_SERIES_MAX_DURATION_S / 60
  } min = épisode de série, sinon film. Taille finale plafonnée (${SERIES_CAP_TEXT} ; ${FILM_CAP_TEXT}).`;
}

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

// Derniers réglages utilisés, retrouvés à la visite suivante (même
// navigateur). Simple confort : chaque valeur est revalidée à la lecture et
// une valeur absente/invalide garde le réglage par défaut.
const SETTINGS_STORAGE_KEY = "file-optimizer:settings";

type StoredSettings = Partial<{
  mode: Mode;
  maxDimension: number;
  quality: number;
  keepOriginal: boolean;
  forceJpeg: boolean;
  videoCrf: number;
  videoPreset: VideoPreset;
  videoProfile: VideoProfile;
  keepVideoSource: boolean;
}>;

function loadStoredSettings(): StoredSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}");
    const intIn = (v: unknown, min: number, max: number) =>
      Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : undefined;
    const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
    return {
      mode: raw.mode === "image" || raw.mode === "video" ? raw.mode : undefined,
      maxDimension: intIn(raw.maxDimension, 100, 20000),
      quality: intIn(raw.quality, 1, 100),
      keepOriginal: bool(raw.keepOriginal),
      forceJpeg: bool(raw.forceJpeg),
      videoCrf: intIn(raw.videoCrf, 0, 51),
      videoPreset: isVideoPreset(raw.videoPreset) ? raw.videoPreset : undefined,
      videoProfile: isVideoProfile(raw.videoProfile) ? raw.videoProfile : undefined,
      keepVideoSource: bool(raw.keepVideoSource),
    };
  } catch {
    return {};
  }
}

function storeSettings(settings: StoredSettings) {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // stockage indisponible (navigation privée...) : réglages non mémorisés
  }
}

function analysisDecision(item: AnalysisItem): string {
  switch (item.action) {
    case "encode":
      return `encodée (${item.sizeProfile === "series" ? "série" : "film"}, ≤ ${formatSize(
        item.targetSize
      )})`;
    case "skip":
      return "laissée telle quelle";
    case "queued":
      return "déjà en file";
    default:
      return "illisible";
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
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<(AnalysisResult & { path: string }) | null>(null);
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

  // Lecture une seule fois au montage (le stockage navigateur n'existe pas
  // au rendu serveur), puis sauvegarde à chaque changement — jamais avant la
  // lecture, sinon les valeurs par défaut écraseraient celles mémorisées.
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  useEffect(() => {
    const stored = loadStoredSettings();
    /* eslint-disable react-hooks/set-state-in-effect -- lecture du stockage navigateur, indisponible au rendu serveur */
    if (stored.mode) setMode(stored.mode);
    if (stored.maxDimension != null) setMaxDimension(stored.maxDimension);
    if (stored.quality != null) setQuality(stored.quality);
    if (stored.keepOriginal != null) setKeepOriginal(stored.keepOriginal);
    if (stored.forceJpeg != null) setForceJpeg(stored.forceJpeg);
    if (stored.videoCrf != null) setVideoCrf(stored.videoCrf);
    if (stored.videoPreset) setVideoPreset(stored.videoPreset);
    if (stored.videoProfile) setVideoProfile(stored.videoProfile);
    if (stored.keepVideoSource != null) setKeepVideoSource(stored.keepVideoSource);
    setSettingsLoaded(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  useEffect(() => {
    if (settingsLoaded) storeSettings({ mode, ...settings });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settingsLoaded,
    mode,
    maxDimension,
    quality,
    keepOriginal,
    forceJpeg,
    videoCrf,
    videoPreset,
    videoProfile,
    keepVideoSource,
  ]);

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

  // Analyse préalable (vidéos) : ce qui serait encodé/ignoré, gain minimum,
  // durée estimée — rien n'est mis en file avant confirmation.
  async function analyzeFolder() {
    setAnalyzing(true);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, videoProfile }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error("Échec de l'analyse", { description: data.error });
        return;
      }
      setAnalysis({ ...data, path });
    } finally {
      setAnalyzing(false);
    }
  }

  async function launchAnalyzed() {
    if (!analysis) return;
    const paths = analysis.items.filter((i) => i.action === "encode").map((i) => i.path);
    setAnalysis(null);
    await enqueuePaths(paths);
  }

  async function optimizeSelection() {
    if (selected.size === 0) return;
    if (await enqueuePaths([...selected])) setSelected(new Set());
  }

  async function enqueuePaths(paths: string[]): Promise<boolean> {
    if (paths.length === 0) return false;
    setEnqueuing(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths, ...settings }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error("Échec de la mise en file", { description: data.error });
        return false;
      }
      const parts = [`${data.queued} mise(s) en file`];
      if (data.skippedAlreadyQueued > 0) parts.push(`${data.skippedAlreadyQueued} déjà en file`);
      toast.success(parts.join(", "));
      startBatch(data.ids ?? []);
      return true;
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
            {profileCapText(videoProfile)}{" "}
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
        {mode === "video" && (
          <Button onClick={analyzeFolder} disabled={analyzing} variant="outline" className="gap-1.5">
            {analyzing ? <Loader2 className="size-4 animate-spin" /> : <SearchCheck className="size-4" />}
            {analyzing ? "Analyse en cours…" : "Analyser ce dossier"}
          </Button>
        )}
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

      <Dialog open={analysis != null} onOpenChange={(open) => !open && setAnalysis(null)}>
        <DialogContent className="max-h-[85vh] grid-cols-1 overflow-hidden sm:max-w-3xl">
          <DialogHeader className="min-w-0">
            <DialogTitle className="flex items-center gap-2">
              <SearchCheck className="size-5 text-primary" />
              Analyse de « {analysis?.path || "Racine"} »
            </DialogTitle>
            <DialogDescription>
              {analysis?.items.length ?? 0} vidéo(s) trouvée(s) — rien n&apos;est lancé tant que tu ne
              confirmes pas.
            </DialogDescription>
          </DialogHeader>
          {analysis && (
            <>
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div className="panel p-3">
                  <p className="text-xs text-muted-foreground">À encoder</p>
                  <p className="text-lg font-semibold">{analysis.toEncode}</p>
                </div>
                <div className="panel p-3">
                  <p className="text-xs text-muted-foreground">Taille actuelle</p>
                  <p className="text-lg font-semibold">{formatSize(analysis.encodeBytes)}</p>
                </div>
                <div className="rounded-xl border border-primary/30 bg-primary/10 p-3">
                  <p className="text-xs text-muted-foreground">Place libérée (au moins)</p>
                  <p className="text-lg font-semibold text-primary">
                    {formatSize(analysis.minSavedBytes)}
                  </p>
                </div>
                <div className="panel p-3">
                  <p className="text-xs text-muted-foreground">Durée estimée</p>
                  <p className="text-lg font-semibold">
                    {analysis.estimatedMs == null
                      ? "inconnue"
                      : analysis.estimatedMs === 0
                        ? "—"
                        : formatRemaining(analysis.estimatedMs)}
                  </p>
                </div>
              </div>
              {analysis.estimatedMs == null && analysis.toEncode > 0 && (
                <p className="text-xs text-muted-foreground">
                  Durée estimée disponible après un premier encodage vidéo (vitesse mesurée sur ce
                  NAS).
                </p>
              )}
              <div className="min-w-0 max-h-[40vh] overflow-y-auto rounded-lg border">
                <table className="w-full table-fixed text-xs">
                  <thead className="sticky top-0 bg-popover text-left text-muted-foreground">
                    <tr className="border-b">
                      <th className="px-3 py-2 font-medium">Fichier</th>
                      <th className="w-20 px-3 py-2 font-medium">Durée</th>
                      <th className="w-20 px-3 py-2 font-medium">Taille</th>
                      <th className="w-32 px-3 py-2 font-medium">Décision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.items.map((item) => (
                      <tr key={item.path} className="border-b border-border/60 align-top last:border-0">
                        <td className="px-3 py-2 break-all">
                          {item.path}
                          {item.reason && (
                            <span className="mt-0.5 block break-words text-muted-foreground">
                              {item.reason}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {item.durationS != null ? `${Math.round(item.durationS / 60)} min` : "—"}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{formatSize(item.size)}</td>
                        <td className="px-3 py-2">{analysisDecision(item)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" onClick={() => setAnalysis(null)}>
                  Fermer
                </Button>
                <Button onClick={launchAnalyzed} disabled={analysis.toEncode === 0 || enqueuing}>
                  Lancer l&apos;optimisation ({analysis.toEncode})
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

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
