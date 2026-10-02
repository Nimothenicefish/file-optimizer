"use client";

import { useCallback, useEffect, useState } from "react";

type Entry = {
  name: string;
  path: string;
  type: "directory" | "image" | "other";
  size?: number;
};

function formatSize(bytes?: number): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} Go`;
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

  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [enqueuing, setEnqueuing] = useState(false);
  const [enqueueMessage, setEnqueueMessage] = useState<string | null>(null);

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
    setScanMessage(null);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, maxDimension, quality, keepOriginal }),
      });
      const data = await res.json();
      if (!res.ok) {
        setScanMessage(data.error ?? "Échec du scan");
        return;
      }
      const parts = [`${data.found} photo(s) trouvée(s)`, `${data.queued} mise(s) en file`];
      if (data.skippedAlreadyQueued > 0) {
        parts.push(`${data.skippedAlreadyQueued} déjà en file`);
      }
      setScanMessage(parts.join(", "));
    } finally {
      setScanning(false);
    }
  }

  async function optimizeSelection() {
    if (selected.size === 0) return;
    setEnqueuing(true);
    setEnqueueMessage(null);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paths: [...selected],
          maxDimension,
          quality,
          keepOriginal,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEnqueueMessage(data.error ?? "Échec de la mise en file");
        return;
      }
      const parts = [`${data.queued} mise(s) en file`];
      if (data.skippedAlreadyQueued > 0) {
        parts.push(`${data.skippedAlreadyQueued} déjà en file`);
      }
      setEnqueueMessage(parts.join(", "));
      setSelected(new Set());
    } finally {
      setEnqueuing(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">Parcourir</h2>
        <p className="text-sm text-zinc-500">
          Scanne un dossier entier (sous-dossiers compris) pour tout optimiser d&apos;un coup, ou
          sélectionne des photos précises en parcourant les dossiers.
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4">
        <h3 className="text-sm font-medium">Réglages</h3>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            Taille max (côté le plus grand)
            <input
              type="number"
              min={100}
              max={20000}
              value={maxDimension}
              onChange={(e) => setMaxDimension(Number(e.target.value))}
              className="w-24 rounded border border-zinc-300 px-2 py-1"
            />
            px
          </label>
          <label className="flex items-center gap-2">
            Qualité (JPEG/WebP/AVIF)
            <input
              type="number"
              min={1}
              max={100}
              value={quality}
              onChange={(e) => setQuality(Number(e.target.value))}
              className="w-20 rounded border border-zinc-300 px-2 py-1"
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={keepOriginal}
              onChange={(e) => setKeepOriginal(e.target.checked)}
            />
            Conserver les originaux (dossier &quot;origin&quot;)
          </label>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {breadcrumbs(path).map((crumb, i, arr) => (
          <span key={crumb.path} className="flex items-center gap-2">
            <button
              onClick={() => setPath(crumb.path)}
              className={i === arr.length - 1 ? "font-medium text-zinc-900" : "text-zinc-500 hover:text-zinc-900"}
            >
              {crumb.label}
            </button>
            {i < arr.length - 1 && <span className="text-zinc-300">/</span>}
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={scanFolder}
          disabled={scanning}
          className="rounded bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {scanning ? "Scan en cours…" : "Scanner ce dossier (récursif)"}
        </button>
        <button
          onClick={selectAllImagesHere}
          className="rounded border border-zinc-300 px-3 py-1.5 text-sm"
        >
          Sélectionner les photos de ce dossier
        </button>
        {scanMessage && <span className="text-sm text-zinc-600">{scanMessage}</span>}
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-zinc-500">
            <tr>
              <th className="px-4 py-2" />
              <th className="px-4 py-2">Nom</th>
              <th className="px-4 py-2">Taille</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-zinc-400">
                  Chargement…
                </td>
              </tr>
            )}
            {!loading &&
              entries.map((entry) => (
                <tr key={entry.path} className="border-t border-zinc-100">
                  <td className="px-4 py-2">
                    {entry.type === "image" && (
                      <input
                        type="checkbox"
                        checked={selected.has(entry.path)}
                        onChange={() => toggleSelect(entry.path)}
                      />
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {entry.type === "directory" ? (
                      <button
                        onClick={() => setPath(entry.path)}
                        className="text-zinc-900 underline"
                      >
                        📁 {entry.name}
                      </button>
                    ) : (
                      <span className={entry.type === "other" ? "text-zinc-400" : ""}>
                        {entry.type === "image" ? "🖼️" : "📄"} {entry.name}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-zinc-400">{formatSize(entry.size)}</td>
                </tr>
              ))}
            {!loading && entries.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-zinc-400">
                  Dossier vide.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected.size > 0 && (
        <div className="sticky bottom-4 flex flex-wrap items-center gap-3 rounded-lg border border-zinc-300 bg-white p-4 shadow-md">
          <span className="text-sm font-medium">{selected.size} photo(s) sélectionnée(s)</span>
          <button
            onClick={() => setSelected(new Set())}
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm"
          >
            Vider la sélection
          </button>
          <button
            onClick={optimizeSelection}
            disabled={enqueuing}
            className="rounded bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {enqueuing ? "Mise en file…" : `Optimiser la sélection (${selected.size})`}
          </button>
          {enqueueMessage && <span className="text-sm text-zinc-600">{enqueueMessage}</span>}
        </div>
      )}
    </div>
  );
}
