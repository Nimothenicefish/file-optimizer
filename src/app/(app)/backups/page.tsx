"use client";

import { useEffect, useState } from "react";
import { Film, Image as ImageIcon, Loader2, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { BackupEntry } from "@/lib/backups";
import { formatSize } from "@/lib/format";

export default function BackupsPage() {
  const [entries, setEntries] = useState<BackupEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/backups");
      const data = await res.json();
      setEntries(data.entries ?? []);
      setSelected((s) => new Set([...s].filter((p) => data.entries?.some((e: BackupEntry) => e.path === p))));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  // Une sauvegarde sans fichier optimisé est la seule copie restante : jamais
  // sélectionnable (et refusée par le serveur de toute façon).
  const deletable = (entries ?? []).filter((e) => e.optimizedPath != null);
  const selectedEntries = deletable.filter((e) => selected.has(e.path));
  const selectedBytes = selectedEntries.reduce((sum, e) => sum + e.size, 0);
  const totalBytes = (entries ?? []).reduce((sum, e) => sum + e.size, 0);
  const allSelected = deletable.length > 0 && selectedEntries.length === deletable.length;

  function toggle(entryPath: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(entryPath)) next.delete(entryPath);
      else next.add(entryPath);
      return next;
    });
  }

  async function deleteSelected() {
    setDeleting(true);
    try {
      const res = await fetch("/api/backups/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: selectedEntries.map((e) => e.path) }),
      });
      const data = await res.json();
      toast.success(`${data.deleted} sauvegarde(s) supprimée(s), ${formatSize(data.freedBytes)} libérés`);
      if (data.refused?.length > 0) {
        toast.error(`${data.refused.length} refusée(s)`, {
          description: data.refused.map((r: { path: string; reason: string }) => `${r.path} : ${r.reason}`).join("\n"),
        });
      }
      setSelected(new Set());
      setConfirming(false);
      await load();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-5 py-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Sauvegardes</h2>
        <p className="text-sm text-muted-foreground">
          Sources vidéo conservées (<code>.mkv.bkp</code>) et originaux photo (dossiers{" "}
          <code>origin/</code>). La place n&apos;est vraiment libérée qu&apos;une fois supprimées :
          vérifie d&apos;abord le fichier optimisé.
        </p>
      </div>

      <div className="panel flex flex-wrap items-center gap-3 p-4">
        <div>
          <p className="text-xs text-muted-foreground">Place occupée par les sauvegardes</p>
          <p className="text-2xl font-bold text-primary">{formatSize(entries ? totalBytes : null)}</p>
          <p className="text-xs text-muted-foreground">{entries?.length ?? 0} sauvegarde(s)</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={load} disabled={loading} className="ml-auto" aria-label="Actualiser">
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSelected(allSelected ? new Set() : new Set(deletable.map((e) => e.path)))}
          disabled={deletable.length === 0}
        >
          {allSelected ? "Tout désélectionner" : "Tout sélectionner"}
        </Button>
        <Button
          size="sm"
          onClick={() => setConfirming(true)}
          disabled={selectedEntries.length === 0}
          className="gap-1.5"
        >
          <Trash2 className="size-4" />
          Supprimer la sélection ({selectedEntries.length} · {formatSize(selectedBytes)})
        </Button>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full table-fixed text-sm">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th className="w-10 px-4 py-2" />
              <th className="px-4 py-2 font-medium">Sauvegarde</th>
              <th className="w-24 px-4 py-2 font-medium">Taille</th>
              <th className="px-4 py-2 font-medium">Fichier optimisé</th>
            </tr>
          </thead>
          <tbody>
            {entries == null && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                  <Loader2 className="mx-auto size-4 animate-spin" />
                </td>
              </tr>
            )}
            {entries?.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                  Aucune sauvegarde : toute la place gagnée est déjà libérée.
                </td>
              </tr>
            )}
            {entries?.map((entry) => (
              <tr key={entry.path} className="border-b border-border/60 align-top last:border-0 hover:bg-muted/40">
                <td className="px-4 py-2">
                  {entry.optimizedPath && (
                    <Checkbox checked={selected.has(entry.path)} onCheckedChange={() => toggle(entry.path)} />
                  )}
                </td>
                <td className="px-4 py-2">
                  <span className="flex items-start gap-2 font-mono text-xs break-all">
                    {entry.kind === "video" ? (
                      <Film className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ImageIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    )}
                    {entry.path}
                  </span>
                </td>
                <td className="px-4 py-2 text-muted-foreground">{formatSize(entry.size)}</td>
                <td className="px-4 py-2 text-xs">
                  {entry.optimizedPath ? (
                    <span className="block font-mono break-all text-muted-foreground">
                      {entry.optimizedPath}
                      <span className="block font-sans text-foreground">
                        {formatSize(entry.optimizedSize)}
                      </span>
                    </span>
                  ) : (
                    <span className="flex items-start gap-1.5 text-warning">
                      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                      Fichier optimisé introuvable : seule copie, suppression bloquée.
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Supprimer {selectedEntries.length} sauvegarde(s) ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {formatSize(selectedBytes)} seront libérés. Suppression définitive : seules les
              versions optimisées resteront. À faire seulement après avoir vérifié qu&apos;elles te
              conviennent.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                deleteSelected();
              }}
              disabled={deleting}
            >
              {deleting ? "Suppression…" : "Supprimer définitivement"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
