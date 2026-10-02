// Prepares the regtest stack so the only thing left to do in the UI is make a payment:
// funds the main node, then opens CHANNELS channels to the peer and mines until they are usable.

import { rpc } from "./automine.mjs";

// === Config

const MAIN_API = "http://127.0.0.1:3001";
const PEER_API = "http://127.0.0.1:3002";
const PEER_ADDRESS = "127.0.0.1:9736";
const WALLET = "regtest";
const CHANNELS = Number(process.env.CHANNELS ?? 5);
const CHANNEL_SAT = 200_000;
const FUND_BTC = 1;
const PEER_FUND_BTC = 0.1;
const PEER_MIN_SAT = 1_000_000;
// The peer refuses more than 4 unfunded channels at once, so each channel is confirmed before the next.
const CONFIRM_BLOCKS = 6;
const USABLE_TIMEOUT_MS = 180_000;

// === Helpers

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function api(base, token, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${json?.error?.message ?? res.status}`);
  return json;
}

async function mine(blocks) {
  await rpc("/", "createwallet", [WALLET]).catch(() => {});
  await rpc("/", "loadwallet", [WALLET]).catch(() => {});
  const address = await rpc(`/wallet/${WALLET}`, "getnewaddress");
  await rpc(`/wallet/${WALLET}`, "generatetoaddress", [blocks, address]);
}

async function syncBoth(token) {
  // A sync call can outlast the timeout while the node is catching up; the next call picks it up.
  await Promise.all(
    [MAIN_API, PEER_API].map((base) => api(base, token, "POST", "/node/sync").catch(() => {})),
  );
}

async function waitFor(check, timeoutMs, intervalMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function usableCount(token) {
  const channels = await api(MAIN_API, token, "GET", "/channels");
  return channels.filter((c) => c.is_usable).length;
}

// === Public

export async function bootstrapChannels(token, log) {
  // Coinbase outputs need 100 confirmations, so an empty wallet gets 101 blocks first.
  await rpc("/", "createwallet", [WALLET]).catch(() => {});
  await rpc("/", "loadwallet", [WALLET]).catch(() => {});
  const balance = await rpc(`/wallet/${WALLET}`, "getbalance");
  if (balance < FUND_BTC + 1) await mine(101);

  const existing = (await api(MAIN_API, token, "GET", "/channels")).length;
  const missing = CHANNELS - existing;
  if (missing <= 0) {
    log(`bootstrap: ${existing} channel(s) already exist, nothing to open`);
    return true;
  }

  const wallet = await api(MAIN_API, token, "GET", "/wallet/balance");
  if (Number(wallet.onchain_spendable_sat) < missing * CHANNEL_SAT * 1.1) {
    const { address } = await api(MAIN_API, token, "POST", "/wallet/address");
    await rpc(`/wallet/${WALLET}`, "sendtoaddress", [address, FUND_BTC]);
    await mine(CONFIRM_BLOCKS);
    log(`bootstrap: funded main node with ${FUND_BTC} BTC`);
    await syncBoth(token);
  }

  const peer = await api(PEER_API, token, "GET", "/node/status");
  // The peer UI can open channels too, so it needs coins of its own.
  const peerWallet = await api(PEER_API, token, "GET", "/wallet/balance");
  if (Number(peerWallet.onchain_spendable_sat) < PEER_MIN_SAT) {
    const { address } = await api(PEER_API, token, "POST", "/wallet/address");
    await rpc(`/wallet/${WALLET}`, "sendtoaddress", [address, PEER_FUND_BTC]);
    await mine(CONFIRM_BLOCKS);
    log(`bootstrap: funded peer node with ${PEER_FUND_BTC} BTC`);
    await syncBoth(token);
  }
  for (let i = existing + 1; i <= CHANNELS; i++) {
    await api(MAIN_API, token, "POST", "/channels", {
      node_id: peer.node_id,
      address: PEER_ADDRESS,
      amount_sat: String(CHANNEL_SAT),
    });
    // Let the funding transaction reach the mempool before it is mined.
    await sleep(3000);
    await mine(CONFIRM_BLOCKS);
    await syncBoth(token);
    const ok = await waitFor(async () => (await usableCount(token)) >= i, USABLE_TIMEOUT_MS);
    if (!ok) {
      log(`bootstrap: channel ${i}/${CHANNELS} did not become usable in time`);
      return false;
    }
    log(`bootstrap: channel ${i}/${CHANNELS} usable`);
  }
  return true;
}
