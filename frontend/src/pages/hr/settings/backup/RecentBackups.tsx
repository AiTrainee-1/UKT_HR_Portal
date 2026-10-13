import { useState } from "react";
import { Database, Download, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { downloadAuthedFile, type BackupFileItem } from "@/lib/api-client/custom-hooks";
import { formatSize } from "./preview";

const VISIBLE = 3;

/**
 * The newest backups the server still has (disk and database copies merged, newest first) with a Download each. A
 * download is always a fresh fetch from the server: the database copy first, else the file in the backup folder.
 */
export function RecentBackups({ backups }: { backups: BackupFileItem[] }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const visible = expanded ? backups : backups.slice(0, VISIBLE);
  const hiddenCount = backups.length - visible.length;

  const download = async (file: string) => {
    setDownloading(file);
    try {
      await downloadAuthedFile(`/api/backup/download/${encodeURIComponent(file)}`, file, () => token);
    } catch (e) {
      toast({
        title: "Download failed",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setDownloading(null);
    }
  };

  if (backups.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-gray-500" data-testid="backup-list-empty">
        No backups yet.
      </p>
    );
  }

  return (
    <div className="space-y-2" data-view-safe>
      <div className="divide-y rounded-lg border" data-testid="backup-list">
        {visible.map((b) => (
          <div key={b.file} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
            <div className="min-w-0">
              <span className="block truncate font-mono text-gray-700">{b.file}</span>
              <span className="flex flex-wrap items-center gap-x-2 text-gray-400">
                {formatSize(b.sizeBytes)} · {new Date(b.createdAt).toLocaleString("en-IN")}
                {b.inDatabase ? (
                  <span className="inline-flex items-center gap-0.5 text-emerald-700" title="Kept in the database">
                    <Database size={10} /> survives a redeploy
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-0.5 text-amber-700" title="Only in the backup folder">
                    <HardDrive size={10} /> only on the server disk
                  </span>
                )}
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              disabled={downloading === b.file}
              onClick={() => download(b.file)}
            >
              <Download size={13} />
              {downloading === b.file ? "Downloading…" : "Download"}
            </Button>
          </div>
        ))}
      </div>
      {hiddenCount > 0 && (
        <button type="button" onClick={() => setExpanded(true)} className="text-xs font-semibold text-blue-700">
          … {hiddenCount} more
        </button>
      )}
      {expanded && backups.length > VISIBLE && (
        <button type="button" onClick={() => setExpanded(false)} className="text-xs font-semibold text-blue-700">
          Show less
        </button>
      )}
    </div>
  );
}
