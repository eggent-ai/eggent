import { cn } from "@/lib/utils";

// The pixel egg of src/app/icon.svg, read onto its own grid: W white, Y yolk,
// g shade, "." empty. Kept as rows because the animation moves whole rows.
const EGG_ROWS = [
  "....Wg....",
  "...WWWg...",
  "..WWWWWg..",
  ".WWWWWWWg.",
  ".WWWYYWWg.",
  "WWWYWY.WWg",
  "WWWYYY.WWg",
  "WWWYYY.WWg",
  "WWWW..WWWg",
  ".WWWWWWWg.",
  ".gWWWWWgg.",
  "..gWWWgg..",
  "...gggg...",
];

const FILL: Record<string, string> = { W: "#FFFFFF", Y: "#FCD12D", g: "#C9C9C9" };

// The egg sits centred on a 16-unit tile; one unit is one pixel of the egg.
const OFFSET_X = 3;
const OFFSET_Y = 1.5;

interface EggentMarkProps {
  /** Rows of the egg turn one after another, like the layers of a cube. */
  working?: boolean;
  className?: string;
  label?: string;
}

/** Eggent's pixel egg on its black tile, still or working. */
export function EggentMark({ working = false, className, label }: EggentMarkProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("shrink-0", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      shapeRendering="crispEdges"
    >
      <rect width="16" height="16" rx="3.5" fill="#000" />
      {EGG_ROWS.map((row, y) => (
        <g
          key={y}
          className={working ? "eggent-mark-row" : undefined}
          style={
            working
              ? ({
                  "--eggent-twist": y % 2 === 0 ? "1px" : "-1px",
                  animationDelay: `${y * 70}ms`,
                } as React.CSSProperties)
              : undefined
          }
        >
          {Array.from(row).map((cell, x) =>
            cell === "." ? null : (
              // A hair taller than a pixel, so scaled rows never show a seam between them.
              <rect key={x} x={OFFSET_X + x} y={OFFSET_Y + y} width="1" height="1.06" fill={FILL[cell]} />
            )
          )}
        </g>
      ))}
    </svg>
  );
}
