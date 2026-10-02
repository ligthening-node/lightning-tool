// Renders scene.html into frontend/public/media/market-flow.webm (and a poster) with the ffmpeg that
// Playwright ships. Run from the repo root: node scripts/market-video/render.mjs
// The loop is seamless, so the last frame leads straight back into the first.

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const outDir = join(root, "frontend/public/media");
const FPS = 24;
const SECONDS = 12;
const FRAMES = FPS * SECONDS;

// Playwright is a dev dependency of the frontend.
const { chromium } = await import(join(root, "frontend/node_modules/@playwright/test/index.mjs"));
const cache = join(homedir(), ".cache", "ms-playwright");
const ffmpegDir = readdirSync(cache).find((d) => d.startsWith("ffmpeg-"));
if (ffmpegDir === undefined) throw new Error("Playwright's ffmpeg was not found; run: pnpm exec playwright install ffmpeg");
const ffmpeg = join(cache, ffmpegDir, "ffmpeg-linux");

mkdirSync(outDir, { recursive: true });
const video = join(outDir, "market-flow.webm");
const poster = join(outDir, "market-flow-poster.jpg");

// This ffmpeg build has no pipe input, but it reads a stream of images from a plain file.
const frames = join(mkdtempSync(join(tmpdir(), "market-video-")), "frames.bin");
const sink = createWriteStream(frames);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`file://${join(here, "scene.html")}`);
const canvas = page.locator("#c");
for (let i = 0; i < FRAMES; i++) {
  await page.evaluate(([f, n]) => window.drawFrame(f, n), [i, FRAMES]);
  const png = await canvas.screenshot({ type: "jpeg", quality: 92 });
  if (!sink.write(png)) await new Promise((r) => sink.once("drain", r));
  if (i === 0) await canvas.screenshot({ path: poster, type: "jpeg", quality: 80 });
}
await new Promise((r) => sink.end(r));
await browser.close();

await new Promise((res, rej) => {
  const encoder = spawn(
    ffmpeg,
    ["-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(FPS), "-i", frames, "-vf", "scale=960:540",
     "-c:v", "libvpx", "-b:v", "0", "-crf", "34", "-deadline", "good", "-cpu-used", "2", "-pix_fmt", "yuv420p", "-an", video],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  encoder.on("exit", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`))));
});
rmSync(dirname(frames), { recursive: true, force: true });
console.log(`wrote ${video}`);
