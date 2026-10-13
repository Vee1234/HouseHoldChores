// Renders the PNG icons the manifest and iOS need from public/icons/icon.svg.
import sharp from "sharp";
import { readFile } from "node:fs/promises";

const dir = new URL("../public/icons/", import.meta.url);
const svg = await readFile(new URL("icon.svg", dir));

const render = (size, file) => sharp(svg, { density: 384 }).resize(size, size).png().toFile(new URL(file, dir).pathname);

await render(192, "icon-192.png");
await render(512, "icon-512.png");
// iOS adds its own rounded corners, so give it a square, full-bleed version.
const square = Buffer.from(svg.toString().replace('rx="112"', 'rx="0"'));
await sharp(square, { density: 384 }).resize(180, 180).png().toFile(new URL("apple-touch-icon.png", dir).pathname);
// Maskable: shrink the artwork into the safe zone on a matching background.
const inner = await sharp(square, { density: 384 }).resize(400, 400).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: "#fbe7cf" } })
  .composite([{ input: inner, gravity: "center" }])
  .png()
  .toFile(new URL("icon-maskable-512.png", dir).pathname);
// Android status-bar badge: a white silhouette on transparent.
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><path d="M14 46 48 18l34 28" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><rect x="24" y="44" width="48" height="36" rx="8" fill="#fff"/></svg>`;
await sharp(Buffer.from(badge)).resize(96, 96).png().toFile(new URL("badge-96.png", dir).pathname);
console.log("Icons written to public/icons/");
