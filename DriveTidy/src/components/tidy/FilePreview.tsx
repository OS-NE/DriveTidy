import { useEffect, useRef, useState } from "react";
import { Box, FileText, Music, Archive, File } from "lucide-react";
import { thumbnailDataUrl, type ScannedFile } from "@/lib/fs";
import { categoryOf } from "@/lib/organize";

// Decode one preview at a time, rather than dozens of full-size photos together.
let previewQueue: Promise<unknown> = Promise.resolve();

export function FilePreview({ file, className = "" }: { file: ScannedFile; className?: string }) {
  const [url, setUrl] = useState<string>();
  const ref = useRef<HTMLDivElement>(null);
  const cat = categoryOf(file.name);
  useEffect(() => {
    if (cat !== "Images" && cat !== "Videos") return;
    let u: string | undefined;
    let alive = true;
    setUrl(undefined);
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      previewQueue = previewQueue.catch(() => {}).then(async () => {
        if (!alive) return;
        if (cat === "Images") {
          const preview = await thumbnailDataUrl(file, 192);
          if (alive) setUrl(preview);
        } else {
          const f = await file.handle.getFile();
          if (!alive) return;
          u = URL.createObjectURL(f);
          setUrl(u);
        }
      }).catch(() => {});
    }, { rootMargin: "100px" });
    if (ref.current) observer.observe(ref.current);
    return () => {
      alive = false;
      observer.disconnect();
      if (u) URL.revokeObjectURL(u);
    };
  }, [file, cat]);

  const box = `relative overflow-hidden rounded-md border border-border bg-muted ${className}`;
  if (cat === "Images" && url) return <div ref={ref} className={box}><img src={url} alt={file.name} className="h-full w-full object-cover" loading="lazy" /></div>;
  if (cat === "Videos" && url) return <div ref={ref} className={box}><video src={url} className="h-full w-full object-cover" muted controls preload="none" /></div>;
  const Icon = cat === "Documents" ? FileText : cat === "Audio" ? Music : cat === "Archives" ? Archive : cat === "3D Print" ? Box : File;
  return (
    <div ref={ref} className={`${box} flex items-center justify-center`}>
      <Icon className="h-8 w-8 text-muted-foreground" />
    </div>
  );
}
