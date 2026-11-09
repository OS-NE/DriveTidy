import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

export const RESULTS_PAGE_SIZE = 50;

export function ResultsPager({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / RESULTS_PAGE_SIZE));
  if (pages === 1) return null;
  return (
    <div className="flex items-center justify-end gap-3 py-2">
      <span className="font-mono text-xs text-muted-foreground">Page {page + 1} of {pages} · {total} files</span>
      <Button size="icon" variant="outline" aria-label="Previous results" disabled={page === 0} onClick={() => onPage(page - 1)}><ChevronLeft /></Button>
      <Button size="icon" variant="outline" aria-label="Next results" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}><ChevronRight /></Button>
    </div>
  );
}