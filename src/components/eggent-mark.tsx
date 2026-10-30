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

// Without its tile the egg takes the colour of the text around it, faintly, and
// keeps only the yolk: a quiet mark that sits beside a line of muted text
// instead of a second dark spot next to the agent's avatar. The body is the
// lighter tone and the rim the darker one, so the two swap in a dark theme.
const QUIET_FILL: Record<string, { fill: string; className?: string }> = {
  W: { fill: "currentColor", className: "opacity-20 dark:opacity-55" },
  Y: { fill: "#FCD12D" },
  g: { fill: "currentColor", className: "opacity-45 dark:opacity-25" },
};

// The egg sits centred on a 16-unit tile; one unit is one pixel of the egg.
const OFFSET_X = 3;
const OFFSET_Y = 1.5;

interface EggentMarkProps {
  /** Rows of the egg turn one after another, like the layers of a cube. */
  working?: boolean;
  /** "tile" is the brand mark on black; "quiet" is the egg alone in the text's colour. */
  tone?: "tile" | "quiet";
  className?: string;
  label?: string;
}

/** Eggent's pixel egg, on its black tile or alone, still or working. */
export function EggentMark({ working = false, tone = "tile", className, label }: EggentMarkProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("shrink-0", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      shapeRendering="crispEdges"
    >
      {tone === "tile" ? <rect width="16" height="16" rx="3.5" fill="#000" /> : null}
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
              <rect
                key={x}
                x={OFFSET_X + x}
                y={OFFSET_Y + y}
                width="1"
                height="1.06"
                fill={tone === "tile" ? FILL[cell] : QUIET_FILL[cell].fill}
                className={tone === "tile" ? undefined : QUIET_FILL[cell].className}
              />
            )
          )}
        </g>
      ))}
    </svg>
  );
}
