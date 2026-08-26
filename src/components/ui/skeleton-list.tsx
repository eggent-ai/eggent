import { Skeleton } from "@/components/ui/skeleton";

/**
 * The shape of what is coming, instead of the word "Loading".
 *
 * A spinner and a label say "wait"; a skeleton says "a list of five things is
 * about to be here", which is the difference between a pause and a promise.
 * Rows vary slightly in width so the block reads as content rather than as a
 * progress bar lying on its side.
 */
export function SkeletonList({ rows = 4, className = "" }: { rows?: number; className?: string }) {
  const widths = ["w-3/4", "w-full", "w-2/3", "w-5/6", "w-1/2"];
  return (
    <div className={`space-y-3 ${className}`} aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="size-8 shrink-0 rounded-md" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className={`h-3.5 ${widths[index % widths.length]}`} />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A single block, for a pane that holds one thing rather than a list. */
export function SkeletonBlock({ className = "" }: { className?: string }) {
  return (
    <div className={`space-y-3 ${className}`} aria-hidden="true">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
