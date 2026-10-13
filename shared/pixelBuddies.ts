// Pixel-art buddies. Each sprite is a 16×16 grid; every letter is a palette
// colour and "." is transparent. "e" marks the eyes (two pixels tall) so the
// renderer can swap them for happy ^ ^ eyes while dancing.

export interface PixelBuddy {
  id: string;
  name: string;
  /** The matching emoji, for places that can only show text (notifications, menus). */
  emoji: string;
  palette: Record<string, string>;
  grid: string[];
  /** Palette letter that fills in behind closed eyes (defaults to the body, "b"). */
  eyeFill?: string;
}

const OUTLINE = "#3b2a20";
const BLUSH = "#f2a0a8";

export const PIXEL_BUDDIES: PixelBuddy[] = [
  {
    id: "bear",
    name: "Biscuit the bear",
    emoji: "🐻",
    palette: { o: OUTLINE, b: "#b8784a", l: "#ecc9a0", p: BLUSH, e: OUTLINE, n: OUTLINE, w: "#ffffff" },
    grid: [
      "................",
      "..ooo......ooo..",
      ".obbbo....obbbo.",
      ".obpboooooobpbo.",
      "..obbbbbbbbbbo..",
      ".obbbbbbbbbbbbo.",
      ".obbebbbbbbebbo.",
      ".obbebbbbbbebbo.",
      ".obbbbllllbbbbo.",
      ".obpbllnnllbpbo.",
      ".obbbbllllbbbbo.",
      "..obbbbbbbbbbo..",
      "...oobbbbbboo...",
      "..obbllllllbbo..",
      "..obbo....obbo..",
      "...oo......oo...",
    ],
  },
  {
    id: "bunny",
    name: "Clover the bunny",
    emoji: "🐰",
    palette: { o: OUTLINE, b: "#f4ede4", l: "#ffffff", p: "#f6b6c0", e: OUTLINE, n: "#e07a8a", w: "#ffffff" },
    grid: [
      "...oo....oo.....",
      "..obpo..obpo....",
      "..obpo..obpo....",
      "..obpo..obpo....",
      "..obbooooobbo...",
      ".obbbbbbbbbbbo..",
      ".obbbbbbbbbbbo..",
      ".obbebbbbbebbo..",
      ".obbebbbbbebbo..",
      ".opbbbbnbbbbpo..",
      ".obbbbbbbbbbbo..",
      "..obbbbbbbbbo...",
      "...oobbbbboo....",
      "..obblllllbbo...",
      "..obbo...obbo...",
      "...oo.....oo....",
    ],
  },
  {
    id: "fox",
    name: "Pip the fox",
    emoji: "🦊",
    palette: { o: OUTLINE, b: "#e8803e", l: "#fff4e6", p: BLUSH, e: OUTLINE, n: OUTLINE, w: "#ffffff" },
    grid: [
      "................",
      ".oo..........oo.",
      ".obo........obo.",
      ".obbo......obbo.",
      ".obbboooooobbbo.",
      ".obbbbbbbbbbbbo.",
      "obbbbbbbbbbbbbbo",
      "obbebbbbbbbbebbo",
      "obbebbbbbbbbebbo",
      "olllbbbbbbbblllo",
      ".ollllllllllllo.",
      "..oolllnnllloo..",
      "....oollllloo...",
      "...obbbllbbbo...",
      "...obbo..obbo...",
      "....oo....oo....",
    ],
  },
  {
    id: "cat",
    name: "Mochi the cat",
    emoji: "🐱",
    palette: { o: OUTLINE, b: "#9a9aa6", l: "#e9e6ee", p: BLUSH, e: OUTLINE, n: "#e88a9a", w: "#ffffff" },
    grid: [
      "................",
      "..o..........o..",
      "..oo........oo..",
      "..obo......obo..",
      "..obpoooooopbo..",
      ".obbbbbbbbbbbbo.",
      ".obbbbbbbbbbbbo.",
      ".obbebbbbbbebbo.",
      ".obbebbbbbbebbo.",
      ".opbbbbnnbbbbpo.",
      ".obbbbllllbbbbo.",
      "..obbbbbbbbbbo..",
      "...oobbbbbboo...",
      "..obbllllllbbo..",
      "..obbo....obbo..",
      "...oo......oo...",
    ],
  },
  {
    id: "frog",
    name: "Lily the frog",
    emoji: "🐸",
    palette: { o: OUTLINE, b: "#79b84f", l: "#d6eda0", p: BLUSH, e: OUTLINE, n: "#c0405a", w: "#ffffff" },
    eyeFill: "w",
    grid: [
      "................",
      "...oooo..oooo...",
      "..owwwwooowwwwo.",
      "..owweeoboweewo.",
      "..owweeoboweewo.",
      ".obooooobbooooo.",
      ".obbbbbbbbbbbbo.",
      "obbbbbbbbbbbbbbo",
      "obpbbbbbbbbbbpbo",
      "obbonbbbbbbbnobo",
      ".obbonnnnnnnobo.",
      "..obboooooobbo..",
      "..obllllllllbo..",
      ".obbllllllllbbo.",
      ".oobbo....obboo.",
      "..ooo......ooo..",
    ],
  },
  {
    id: "chick",
    name: "Sunny the chick",
    emoji: "🐥",
    palette: { o: OUTLINE, b: "#ffd447", l: "#fff1a8", p: BLUSH, e: OUTLINE, n: "#f08a24", w: "#ffffff" },
    grid: [
      "................",
      ".......oo.......",
      "......obbo......",
      "....oooboooo....",
      "...obbbbbbbbo...",
      "..obbbbbbbbbbo..",
      "..obbebbbbebbo..",
      ".obbbebbbbebbbo.",
      ".obpbbbnnbbbpbo.",
      ".obbbbnnnnbbbbo.",
      ".obbbbbnnbbbbbo.",
      ".obbllbbbbllbbo.",
      "..obbllllllbbo..",
      "...obbbbbbbbo...",
      "....oonooonoo...",
      "......n...n.....",
    ],
  },
  {
    id: "lion",
    name: "Leo the lion",
    emoji: "🦁",
    palette: { o: OUTLINE, b: "#f2b94b", m: "#c8662a", l: "#fde7b8", p: BLUSH, e: OUTLINE, n: OUTLINE, w: "#ffffff" },
    grid: [
      "....oooooooo....",
      "..oommmmmmmmoo..",
      ".ommmmmmmmmmmmo.",
      ".ommoooooooommo.",
      "ommobbbbbbbbommo",
      "ommobbbbbbbbommo",
      "ommbebbbbbbebmmo",
      "ommbebbbbbbebmmo",
      "ommbpbllllbpbmmo",
      "ommbbllnnllbbmmo",
      ".ommbbllllbbmmo.",
      ".ommmobbbbommmo.",
      "..oommoooommoo..",
      "...obbbbbbbbo...",
      "...obbo..obbo...",
      "....oo....oo....",
    ],
  },
  {
    id: "dog",
    name: "Waffles the dog",
    emoji: "🐶",
    palette: { o: OUTLINE, b: "#e0b07a", m: "#8a5a36", l: "#f8e6cc", p: BLUSH, e: OUTLINE, n: OUTLINE, w: "#ffffff" },
    grid: [
      "................",
      "...oooooooooo...",
      "..ombbbbbbbbmo..",
      ".ommbbbbbbbbmmo.",
      ".ommbbbbbbbbmmo.",
      ".ommbebbbbebmmo.",
      ".ommbebbbbebmmo.",
      ".ommbbllllbbmmo.",
      "..ombpllllpbmo..",
      "..oobllnnllboo..",
      "....obllllbo....",
      "....oobbbboo....",
      "...obbllllbbo...",
      "...obbllllbbo...",
      "...obbo..obbo...",
      "....oo....oo....",
    ],
  },
  {
    id: "elephant",
    name: "Peanut the elephant",
    emoji: "🐘",
    palette: { o: OUTLINE, b: "#a9bccf", l: "#e3b8c4", p: BLUSH, e: OUTLINE, n: OUTLINE, w: "#ffffff" },
    grid: [
      "................",
      ".....oooooo.....",
      "..ooobbbbbbooo..",
      ".ollobbbbbbollo.",
      "olllobbbbbbolllo",
      "olllbebbbbeblllo",
      "olllbebbbbeblllo",
      "olllbpbbbbpblllo",
      ".ollobbbbbbollo.",
      "..ooobbbbbbooo..",
      "...obwobbowbo...",
      "..obbbobbobbbo..",
      "..obbbobbobbbo..",
      "..obbboooobbbo..",
      "..obbo....obbo..",
      "...oo......oo...",
    ],
  },
  {
    id: "deer",
    name: "Hazel the deer",
    emoji: "🦌",
    palette: { o: OUTLINE, b: "#c98a52", a: "#7a5230", l: "#f6e2c8", p: "#f2a8b0", e: OUTLINE, n: OUTLINE, w: "#fff6ea" },
    grid: [
      "...a.a....a.a...",
      "...aaa....aaa...",
      "....a......a....",
      "..oooooooooooo..",
      ".obbbbbbbbbbbbo.",
      "obpbbbbbbbbbbpbo",
      ".obbebbbbbbebbo.",
      ".obbebbbbbbebbo.",
      ".obpbbllllbbpbo.",
      "..obbllnnllbbo..",
      "...oobllllboo...",
      "....obbbbbbo....",
      "...obwbbbbwbo...",
      "...obbllllbbo...",
      "...obo....obo...",
      "...oo......oo...",
    ],
  },
];

const SIZE = 16;

/**
 * Builds an SVG for a buddy. With `happy`, each eye becomes a closed "^": the
 * eye's top-left pixel is the peak, with one pixel down-left and down-right.
 */
export function buddySvg(buddy: PixelBuddy, happy = false): string {
  const fills = new Map<string, string>();
  const at = (x: number, y: number) => buddy.grid[y]?.[x];
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const ch = at(x, y);
      if (ch && ch !== ".") fills.set(`${x},${y}`, ch === "e" && happy ? (buddy.eyeFill ?? "b") : ch);
    }
  if (happy)
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++)
        if (at(x, y) === "e" && at(x, y - 1) !== "e" && at(x - 1, y) !== "e")
          for (const [dx, dy] of [[0, 0], [-1, 1], [1, 1]]) fills.set(`${x + dx},${y + dy}`, "e");
  const rects = [...fills].map(([key, ch]) => {
    const [x, y] = key.split(",");
    return `<rect x="${x}" y="${y}" width="1" height="1" fill="${buddy.palette[ch] ?? "#f0f"}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}

export const DEFAULT_BUDDY = "bear";

export const buddyById = (id: string | null | undefined): PixelBuddy =>
  PIXEL_BUDDIES.find((b) => b.id === id) ?? PIXEL_BUDDIES[0];

export const isBuddyId = (id: unknown): id is string => PIXEL_BUDDIES.some((b) => b.id === id);
