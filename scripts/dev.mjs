// Starts the whole local regtest stack: Docker, Polar, bitcoind, main node, peer node, frontend.
// Run with: npm run dev

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startAutoMine } from "./automine.mjs";
import { bootstrapChannels } from "./bootstrap.mjs";

// === Config

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = join(ROOT, "backend");
const FRONTEND = join(ROOT, "frontend");
const ENV_FILE = join(FRONTEND, ".env.local");
const POLAR_DIR = join(homedir(), "Downloads", "squashfs-root");
// Node data (seeds, channels, payments) lives in the project, not /tmp, so a reboot does not wipe it.
const DATA_ROOT = join(ROOT, ".regtest-data");

const DOCKER_TIMEOUT_MS = 180_000;
const BITCOIND_PORT = 18443;
const WATCHDOG_EVERY_MS = 10_000;

const children = [];
let stopAutoMine = null;
let stopWatchdog = null;
const status = [];

// === Helpers

function log(msg) {
  console.log(`[dev] ${msg}`);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isPortOpen(port) {
  return new Promise((res) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    sock.once("connect", () => {
      sock.destroy();
      res(true);
    });
    sock.once("error", () => res(false));
  });
}

async function waitFor(check, timeoutMs, intervalMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return true;
    await sleep(intervalMs);
  }
  return false;
}

function pipeWithPrefix(stream, prefix) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) console.log(`[${prefix}] ${line}`);
  });
}

function startManaged(name, cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  pipeWithPrefix(child.stdout, name);
  pipeWithPrefix(child.stderr, name);
  child.on("exit", (code) => log(`${name} exited with code ${code}`));
  children.push(child);
  return child;
}

// === Preflight

function loadToken() {
  if (!existsSync(ENV_FILE)) {
    const token = run("openssl", ["rand", "-hex", "32"]).stdout.trim();
    writeFileSync(ENV_FILE, `LN_API_TOKEN=${token}\n`);
    log(`created ${ENV_FILE}`);
  }
  const match = readFileSync(ENV_FILE, "utf8").match(/^LN_API_TOKEN=(.+)$/m);
  if (!match || match[1].trim().length < 16) {
    throw new Error("LN_API_TOKEN in frontend/.env.local is missing or shorter than 16 characters");
  }
  return match[1].trim();
}

// === Docker

function dockerRunning() {
  return run("docker", ["info"]).status === 0;
}

async function ensureDocker() {
  if (dockerRunning()) {
    status.push(["docker", true, "already running"]);
    return;
  }
  log("Docker is not running, starting Docker Desktop");
  const started = run("systemctl", ["--user", "start", "docker-desktop"]);
  if (started.status !== 0) log(`systemctl failed: ${started.stderr.trim()}`);
  const ok = await waitFor(() => dockerRunning(), DOCKER_TIMEOUT_MS);
  status.push(["docker", ok, ok ? "started" : "failed to start"]);
  if (!ok) throw new Error("Docker did not become ready in time");
}

// === Polar

function polarRunning() {
  return run("pgrep", ["-f", "squashfs-root/polar"]).status === 0;
}

function ensurePolar() {
  if (polarRunning()) {
    status.push(["polar", true, "already running"]);
    return;
  }
  if (!existsSync(join(POLAR_DIR, "polar"))) {
    status.push(["polar", false, `not found in ${POLAR_DIR}`]);
    return;
  }
  log("Polar is not running, starting it");
  const child = spawn("./polar", ["--no-sandbox"], {
    cwd: POLAR_DIR,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  status.push(["polar", true, "started"]);
}

// === Reset

/**
 * Wipes the regtest chain (bitcoind volume) and both nodes' data, so every run starts clean and the
 * nodes can never be ahead of the chain. RESET=0 keeps the existing data.
 */
async function resetState(token) {
  for (const port of [3001, 3002]) {
    if (await isPortOpen(port)) {
      throw new Error(`a node is still listening on :${port}, stop the old stack before a reset (or run with RESET=0)`);
    }
  }
  log("reset: removing bitcoind volume and .regtest-data");
  const res = run("docker", ["compose", "down", "-v"], {
    cwd: ROOT,
    env: { ...process.env, LN_API_TOKEN: token },
    stdio: "inherit",
  });
  if (res.status !== 0) throw new Error("docker compose down -v failed");
  rmSync(DATA_ROOT, { recursive: true, force: true });
  status.push(["reset", true, "chain and node data wiped (RESET=0 to keep)"]);
}

// === bitcoind

async function ensureBitcoind(token) {
  if (await isPortOpen(BITCOIND_PORT)) {
    status.push(["bitcoind", true, `already listening on :${BITCOIND_PORT}`]);
    return;
  }
  log("starting bitcoind");
  const res = run("docker", ["compose", "up", "-d", "--wait", "bitcoind"], {
    cwd: ROOT,
    env: { ...process.env, LN_API_TOKEN: token },
    stdio: "inherit",
  });
  const ok = res.status === 0;
  status.push(["bitcoind", ok, ok ? "started" : "failed"]);
  if (!ok) throw new Error("docker compose failed to start bitcoind");
}

/**
 * Keeps bitcoind up. If its container stops (Docker restarted, or it was stopped by hand) every node
 * sync fails with "connection refused", so bring it back instead of waiting for someone to notice.
 */
function startBitcoindWatchdog(token) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || (await isPortOpen(BITCOIND_PORT))) return;
    if (!dockerRunning()) return; // Docker itself is down; nothing to start yet
    busy = true;
    log("watchdog: bitcoind is not answering, starting it again");
    const res = run("docker", ["compose", "up", "-d", "--wait", "bitcoind"], {
      cwd: ROOT,
      env: { ...process.env, LN_API_TOKEN: token },
    });
    log(res.status === 0 ? "watchdog: bitcoind is back" : `watchdog: could not start bitcoind: ${res.stderr.trim().slice(0, 200)}`);
    busy = false;
  }, WATCHDOG_EVERY_MS);
  return () => clearInterval(timer);
}

// === Nodes

function nodeEnv(token, extra) {
  return {
    ...process.env,
    LN_API_TOKEN: token,
    LN_RPC_USER: "lightning",
    LN_RPC_PASSWORD: "lightning",
    ...extra,
  };
}

async function ensureNode(name, apiPort, env, token) {
  if (await isPortOpen(apiPort)) {
    status.push([name, true, `already listening on :${apiPort}`]);
    return;
  }
  mkdirSync(env.LN_DATA_DIR, { recursive: true });
  log(`starting ${name} on :${apiPort} (first run may compile)`);
  startManaged(name, "cargo", ["run", "-p", "api-server"], {
    cwd: BACKEND,
    env: nodeEnv(token, env),
  });
  const ok = await waitFor(() => isPortOpen(apiPort), 600_000, 3000);
  status.push([name, ok, ok ? `listening on :${apiPort}` : "did not start in time"]);
}

// === Frontend

async function ensureFrontend(name, port, env = {}) {
  if (await isPortOpen(port)) {
    status.push([name, true, `already listening on :${port}`]);
    return;
  }
  log(`starting ${name} on :${port}`);
  startManaged(name, "pnpm", ["dev", "--port", String(port)], {
    cwd: FRONTEND,
    env: { ...process.env, ...env },
  });
  const ok = await waitFor(() => isPortOpen(port), 120_000);
  status.push([name, ok, ok ? `listening on :${port}` : "did not start in time"]);
}

// === Shutdown

function shutdown() {
  if (stopAutoMine !== null) stopAutoMine();
  if (stopWatchdog !== null) stopWatchdog();
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGINT");
  }
  setTimeout(() => process.exit(0), 1500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// === Main

function printStatus() {
  console.log("\n[dev] ===== status =====");
  for (const [name, ok, note] of status) {
    console.log(`[dev] ${ok ? "OK  " : "FAIL"} ${name.padEnd(9)} ${note}`);
  }
  console.log("[dev] main UI http://localhost:3000, peer UI http://localhost:3003");
  console.log("[dev] Ctrl+C stops processes started here\n");
}

async function main() {
  const token = loadToken();

  await ensureDocker();
  ensurePolar();
  if (process.env.RESET !== "0") await resetState(token);
  await ensureBitcoind(token);
  stopWatchdog = startBitcoindWatchdog(token);
  status.push(["watchdog", true, "restarts bitcoind if it stops"]);

  // Sequential so the two cargo runs do not fight over the build lock.
  await ensureNode("backend", 3001, { LN_DATA_DIR: join(DATA_ROOT, "main-node") }, token);
  await ensureNode(
    "peer",
    3002,
    {
      LN_DATA_DIR: join(DATA_ROOT, "peer-node"),
      LN_API_PORT: "3002",
      LN_LISTEN_ADDRESS: "127.0.0.1:9736",
      LN_NODE_ALIAS: "regtest-peer",
    },
    token,
  );
  // Regtest blocks only come from us, and payments show once confirmed. AUTOMINE=0 turns it off.
  if (process.env.AUTOMINE !== "0") {
    stopAutoMine = startAutoMine((msg) => log(`automine: ${msg}`));
    status.push(["automine", true, "mines a block for each transaction (AUTOMINE=0 to disable)"]);
  }
  await ensureFrontend("frontend", 3000, { NODE_LABEL: "Main node" });
  // The peer UI talks to the peer node and needs its own build folder to avoid the dev lock.
  await ensureFrontend("peer-ui", 3003, {
    LN_API_URL: "http://127.0.0.1:3002",
    NODE_LABEL: "Peer node",
    NEXT_DIST_DIR: ".next-peer",
  });

  // Funds the main node and opens the channels, so the UI only has to make payments. BOOTSTRAP=0 skips it.
  if (process.env.BOOTSTRAP !== "0") {
    try {
      const ok = await bootstrapChannels(token, log);
      status.push(["channels", ok, ok ? "main node funded, channels to the peer usable" : "not all channels became usable"]);
    } catch (err) {
      status.push(["channels", false, err.message]);
    }
  }

  printStatus();
  if (children.length === 0 && stopAutoMine === null && stopWatchdog === null) process.exit(0);
}

main().catch((err) => {
  console.error(`[dev] ${err.message}`);
  printStatus();
  shutdown();
});
