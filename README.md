# Lightning Tool

A Rust for Bitcoin capstone that teaches how Lightning payments work: invoices first, then channels, routing and liquidity. See [plan.md](plan.md) for the design.

- **Decoder (v0.1.0):** a hand-written BOLT11 parser and validator in Rust, running in the browser as WebAssembly. Paste an invoice, see every field, the signature check and the expiry.
- **Node (v0.2.0):** an [ldk-node](https://github.com/lightningdevkit/ldk-node) Lightning node on regtest or signet behind a localhost REST API, with a web UI for the wallet, channels, invoices, payments and live events. Every invoice goes through the decoder before it is paid.

## Layout

| Path | What |
|---|---|
| `backend/crates/invoice-core` | The decoder. No I/O, no clock. |
| `backend/crates/invoice-cli` | `invoice-cli decode <invoice> [--json]` |
| `backend/crates/invoice-wasm` | wasm-bindgen wrapper for the browser |
| `backend/crates/node-core` | ldk-node wrapper |
| `backend/crates/api-server` | axum REST API and SSE events |
| `frontend/` | Next.js app (App Router, TypeScript, pnpm) |

## Run the decoder

```sh
cd frontend && pnpm install && pnpm dev     # http://localhost:3000/decode
cargo run -p invoice-cli -- decode lnbc...  # from backend/
```

## Run the full stack on regtest

Needs Docker. The compose file starts bitcoind (regtest), your node, a second node to open channels with, and the web app. Every port is published on `127.0.0.1` only.

```sh
export LN_API_TOKEN=$(openssl rand -hex 32)
docker compose up --build
```

Open http://localhost:3000, then:

1. **Wallet:** press *New address*, then fund it: `backend/scripts/regtest.sh fund <address> 0.02`.
2. **Peer:** get the second node's id with `backend/scripts/regtest.sh peer node/status`.
3. **Channels:** connect to `api-peer:9735` with that id, open a channel, then `backend/scripts/regtest.sh mine 6`.
4. **Receive / Send:** create an invoice and pay it from the other node (`regtest.sh peer payments '{"invoice":"lnbcrt..."}'`), or create one on the peer (`regtest.sh peer invoices '{"amount_msat":"10000000","description":"tip"}'`) and pay it on the Send page.
5. **Payments** shows the history; toasts in the corner show live events.

### Without Docker

Run bitcoind (or a [Polar](https://lightningpolar.com) network) on regtest, then:

```sh
cd backend
LN_API_TOKEN=$(openssl rand -hex 32) LN_RPC_PASSWORD=<rpc password> cargo run -p api-server
cd ../frontend
LN_API_TOKEN=<same token> pnpm dev
```

### Configuration

Read by `api-server` (all `LN_*`):

| Variable | Default | |
|---|---|---|
| `LN_API_TOKEN` | required | Bearer token, at least 16 characters. Also set on the Next.js server. |
| `LN_RPC_PASSWORD` | required | bitcoind RPC password |
| `LN_RPC_USER` / `LN_RPC_HOST` / `LN_RPC_PORT` | `polaruser` / `127.0.0.1` / `18443` | |
| `LN_NETWORK` | `regtest` | `regtest` or `signet`. Mainnet is not supported. |
| `LN_DATA_DIR` | `./ldk-data` | Node state and seed |
| `LN_LISTEN_ADDRESS` | `127.0.0.1:9735` | Lightning peer port |
| `LN_API_PORT` | `3001` | The API binds to loopback only (`LN_API_BIND=container` is for Docker) |
| `LN_MAX_PAY_MSAT` | `1000000000` | Largest payment the API will send (1,000,000 sat) |
| `LN_NODE_ALIAS` | `lightning-tool` | |

The Next.js server reads `LN_API_URL` (default `http://127.0.0.1:3001`) and `LN_API_TOKEN`.

## Backing up the node

The node's state lives in `LN_DATA_DIR` (the `node-data` volume in Docker). Losing it loses the funds.

- `keys_seed` is the wallet seed. Anyone with this file controls the funds. Keep copies offline and never commit or share it. No API endpoint returns it.
- `ldk_node_data.sqlite` holds channel state. Restoring an **old** copy of it can make the node broadcast a revoked state, which lets the peer take the whole channel balance. Only restore from a backup taken after the last channel update, or better: close channels first, then back up.
- Stop the node (`docker compose stop api`) before copying so the files are consistent:

```sh
docker compose stop api
docker run --rm -v capstoneproject_node-data:/data -v "$PWD":/backup debian:bookworm-slim \
  tar czf /backup/node-data-$(date +%F).tgz -C /data .
docker compose start api
```

## Tests

```sh
cd backend && cargo test --workspace                 # unit, spec vectors, oracle, tampering, proptest, API
cd frontend && pnpm test                             # Vitest
cd frontend && pnpm e2e                              # Playwright, decoder (no node needed)
```

Regtest integration test with two real nodes (needs `docker compose up -d bitcoind`):

```sh
cd backend && cargo test -p node-core --test regtest -- --ignored --nocapture
```

Browser test of the whole flow against the running compose stack:

```sh
cd frontend && E2E_REGTEST=1 pnpm exec playwright test --project=regtest
```

## Security notes

- The API needs a bearer token held by the Next.js server; the browser never sees it, and the proxy only forwards an allow-list of routes.
- Before paying, the server re-checks the invoice with the decoder: signature, network, expiry, amount limit and (optionally) the payee.
- Invoice descriptions are untrusted input and are rendered as text.

## Maintenance

Upgrade the rust-lightning crates together (ldk-node, lightning, lightning-invoice) and rerun every test. Watch the [BOLTs repository](https://github.com/lightning/bolts) for invoice format changes. Regenerate the WASM package and TypeScript types with `backend/scripts/build-wasm.sh`.
