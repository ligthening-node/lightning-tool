// Mines blocks once a transaction has waited in bitcoind's mempool for a few seconds, so regtest
// payments confirm on their own. The wait leaves the pending state visible on the Payments page.

import { fileURLToPath } from "node:url";

// === Config

const RPC_URL = "http://127.0.0.1:18443";
const RPC_AUTH = `Basic ${Buffer.from("lightning:lightning").toString("base64")}`;
const WALLET = "regtest";
const CHECK_EVERY_MS = 2000;
// ldk-node marks an on-chain payment succeeded after 6 confirmations.
const BLOCKS_PER_BATCH = 6;
// How long a transaction stays pending before it is mined. AUTOMINE_DELAY_MS overrides it.
const MIN_WAIT_MS = Number(process.env.AUTOMINE_DELAY_MS ?? 10_000);

// === Helpers

export async function rpc(path, method, params = []) {
  const res = await fetch(`${RPC_URL}${path}`, {
    method: "POST",
    headers: { authorization: RPC_AUTH, "content-type": "text/plain" },
    body: JSON.stringify({ jsonrpc: "1.0", id: "automine", method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

export async function mineBatch() {
  // Creating fails when the wallet exists, loading fails when it is loaded: either is fine.
  await rpc("/", "createwallet", [WALLET]).catch(() => {});
  await rpc("/", "loadwallet", [WALLET]).catch(() => {});
  const address = await rpc(`/wallet/${WALLET}`, "getnewaddress");
  await rpc(`/wallet/${WALLET}`, "generatetoaddress", [BLOCKS_PER_BATCH, address]);
}

// === Public

/** Returns a function that stops the loop. Errors are logged once per change, not every tick. */
export function startAutoMine(log = console.log) {
  let busy = false;
  /** txid -> when the loop first saw it in the mempool. */
  const firstSeen = new Map();
  let lastError = "";
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const pending = await rpc("/", "getrawmempool");
      const now = Date.now();
      for (const txid of pending) if (!firstSeen.has(txid)) firstSeen.set(txid, now);
      for (const txid of firstSeen.keys()) if (!pending.includes(txid)) firstSeen.delete(txid);
      const ripe = pending.filter((txid) => now - firstSeen.get(txid) >= MIN_WAIT_MS);
      if (ripe.length > 0) {
        await mineBatch();
        log(`mined ${BLOCKS_PER_BATCH} blocks for ${ripe.length} pending transaction(s)`);
      }
      lastError = "";
    } catch (err) {
      if (err.message !== lastError) log(`stopped by error, will keep retrying: ${err.message}`);
      lastError = err.message;
    } finally {
      busy = false;
    }
  }, CHECK_EVERY_MS);
  return () => clearInterval(timer);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startAutoMine((msg) => console.log(`[automine] ${msg}`));
}
