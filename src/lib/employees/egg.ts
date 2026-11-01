/**
 * Each AI employee is a variation of Eggent's pixel egg: its own colour, a
 * face, and one small mark of its trade. One SVG string, so the signup page
 * (a copy lives in the cloud) and the app draw the same character.
 * Client-safe: no imports.
 */

// The egg of eggent-mark.tsx: W white, Y yolk, g shade, "." empty.
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

interface EggLook {
  tile: string;
  yolk: string;
  /** Extra pixels on the egg's own grid: [x, y, colour]. */
  marks: Array<[number, number, string]>;
}

const INK = "#141414";

const LOOKS: Record<string, EggLook> = {
  // Eyes turned to the side: looking at the market.
  marketer: { tile: "#FF7A1A", yolk: "#FFB21A", marks: [[4, 3, INK], [6, 3, INK]] },
  // A pink cheek: the one who talks to an audience.
  channel: { tile: "#8B5CF6", yolk: "#FCD12D", marks: [[3, 3, INK], [5, 3, INK], [2, 4, "#FF8FB8"]] },
  // Glasses: reads the small print.
  lawyer: { tile: "#2563EB", yolk: "#FCD12D", marks: [[2, 3, INK], [3, 3, INK], [4, 3, "#7A7A7A"], [5, 3, INK], [6, 3, INK]] },
  // An antenna: always listening for news.
  analyst: { tile: "#16A34A", yolk: "#FCD12D", marks: [[3, 3, INK], [5, 3, INK], [4, -1, "#FCD12D"], [4, 0, "#9A9A9A"]] },
  // Blushing on both sides: whoever you need it to be.
  custom: { tile: "#EC4899", yolk: "#FFD84D", marks: [[3, 3, INK], [5, 3, INK], [1, 4, "#FF9CC7"], [7, 4, "#FF9CC7"]] },
};

const FALLBACK: EggLook = { tile: "#111111", yolk: "#FCD12D", marks: [[3, 3, INK], [5, 3, INK]] };

export function employeeColor(id: string): string {
  return (LOOKS[id] ?? FALLBACK).tile;
}

/** The employee's egg on its coloured tile, as an SVG document string. */
export function employeeEggSvg(id: string, label = ""): string {
  const look = LOOKS[id] ?? FALLBACK;
  const fill: Record<string, string> = { W: "#FFFFFF", Y: look.yolk, g: "#D6D6D6" };
  const ox = 3;
  const oy = 2;
  const cells: string[] = [];
  EGG_ROWS.forEach((row, y) => {
    Array.from(row).forEach((cell, x) => {
      if (cell !== ".") cells.push(`<rect x="${ox + x}" y="${oy + y}" width="1" height="1.06" fill="${fill[cell]}"/>`);
    });
  });
  for (const [x, y, colour] of look.marks) cells.push(`<rect x="${ox + x}" y="${oy + y}" width="1" height="1" fill="${colour}"/>`);
  const a11y = label ? `role="img" aria-label="${label.replace(/"/g, "&quot;")}"` : `aria-hidden="true"`;
  return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" ${a11y}><rect width="16" height="16" rx="4" fill="${look.tile}"/>${cells.join("")}</svg>`;
}
