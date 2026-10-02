# Run guide (local regtest)

Run all commands from the project root unless a `cd` says otherwise. Everything listens on `127.0.0.1` only.

## 0. One-time setup

The frontend and the backend must share the same `LN_API_TOKEN` (at least 16 characters).

```bash
echo "LN_API_TOKEN=$(openssl rand -hex 32)" > frontend/.env.local
```

`frontend/.env.local` is gitignored. Every command below reads the token from it:

```bash
export LN_API_TOKEN=$(grep ^LN_API_TOKEN frontend/.env.local | cut -d= -f2)
```

## 1. bitcoind (regtest, Docker)

The backend needs it. RPC user and password are both `lightning`.

Compose validates every service, so `LN_API_TOKEN` must be exported even though only bitcoind starts:

```bash
export LN_API_TOKEN=$(grep ^LN_API_TOKEN frontend/.env.local | cut -d= -f2)
docker compose up -d --wait bitcoind
```

Without the export it fails with `required variable LN_API_TOKEN is missing a value`.

## 2. Backend (main node)

API on `127.0.0.1:3001`, Lightning on `127.0.0.1:9735`.

```bash
cd backend

export LN_API_TOKEN=$(grep ^LN_API_TOKEN ../frontend/.env.local | cut -d= -f2)

LN_API_TOKEN=$LN_API_TOKEN \
LN_RPC_USER=lightning \
LN_RPC_PASSWORD=lightning \
LN_DATA_DIR=../.regtest-data/main-node \
cargo run -p api-server
```

If it fails with `The given network address is invalid`, port 9735 is already taken, usually by an api-server that is still running. Stop it and retry.

## 3. Frontend

Runs at http://localhost:3000. Restart it after any change to `.env.local`.

```bash
cd frontend
npm run dev        # or: pnpm dev
```

## 4. Second node (peer)

API on `127.0.0.1:3002`, Lightning on `127.0.0.1:9736`. It needs its own data dir and its own ports, so it does not clash with the main node.

```bash
cd backend

export LN_API_TOKEN=$(grep ^LN_API_TOKEN ../frontend/.env.local | cut -d= -f2)

LN_API_TOKEN=$LN_API_TOKEN \
LN_RPC_USER=lightning \
LN_RPC_PASSWORD=lightning \
LN_DATA_DIR=../.regtest-data/peer-node \
LN_API_PORT=3002 \
LN_LISTEN_ADDRESS=127.0.0.1:9736 \
LN_NODE_ALIAS=regtest-peer \
cargo run -p api-server
```

Keep the same `LN_DATA_DIR` to keep the same node id and channels. A new path creates a brand-new node.

To run any of the above in the background, use the built binary and log to a file:

```bash
cd backend
LN_API_TOKEN=$LN_API_TOKEN LN_RPC_USER=lightning LN_RPC_PASSWORD=lightning \
LN_DATA_DIR=../.regtest-data/main-node \
setsid nohup ./target/debug/api-server > api.log 2>&1 < /dev/null &
```

## 5. Verify the stack

Everything from the sections above must be up: frontend `:3000`, main node `:3001`, peer `:3002`, bitcoind `:18443`.

```bash
export LN_API_TOKEN=$(grep ^LN_API_TOKEN frontend/.env.local | cut -d= -f2)
H="authorization: Bearer $LN_API_TOKEN"
BTC="docker exec capstoneproject-bitcoind-1 bitcoin-cli -regtest -rpcuser=lightning -rpcpassword=lightning"

ss -ltn | grep -E ':(3000|3001|3002|9735|9736|18443)\b'      # all six ports listening
curl -s -o /dev/null -w "frontend %{http_code}\n" localhost:3000
$BTC getblockcount                                             # chain height
curl -s -H "$H" 127.0.0.1:3001/node/status                     # main node
curl -s -H "$H" 127.0.0.1:3002/node/status                     # peer
```

Both nodes must report `"is_synced":true` and the same `block_height` as `getblockcount`.

If a node shows `block_height` below the chain height after bitcoind (re)starts, it is still catching up. Trigger a sync and poll until it matches (about 1 minute for roughly 1200 blocks; the sync call can hit curl's timeout, that is fine):

```bash
curl -s -m 60 -X POST -H "$H" 127.0.0.1:3001/node/sync
curl -s -m 60 -X POST -H "$H" 127.0.0.1:3002/node/sync
curl -s -H "$H" 127.0.0.1:3001/node/status
```

## 6. Fund an address and send a transfer (tested)

Test address, generated in the app and owned by the main node (3001):
`bcrt1qhaashnnu379ezmytrqfp7q8q4r6s7gxra5p9gg`

Set these in every new terminal before running the `curl` commands below. Each shell starts without them, and a missing `$H` gives `missing or invalid bearer token`:


```bash
export LN_API_TOKEN=$(grep ^LN_API_TOKEN frontend/.env.local | cut -d= -f2)
H="authorization: Bearer $LN_API_TOKEN"
```
```bash
curl -s -H "$H" 127.0.0.1:3001/wallet/balance; echo
````


### 6.1 Fund it from bitcoind's wallet

`fund` sends coins from the bitcoind `regtest` wallet and mines 6 blocks to confirm. It creates the wallet and mines 101 blocks first if the wallet is empty.

```bash
backend/scripts/regtest.sh fund bcrt1qhaashnnu379ezmytrqfp7q8q4r6s7gxra5p9gg 0.1
```

Expected: `sent 0.1 BTC to bcrt1q... in <txid> (confirmed)`.

The node only sees new blocks on its next sync (it also syncs on its own every few seconds). Force one and check the balance:

````bash
export LN_API_TOKEN=$(grep ^LN_API_TOKEN frontend/.env.local | cut -d= -f2)
H="authorization: Bearer $LN_API_TOKEN"

curl -s -X POST -H "$H" 127.0.0.1:3001/node/sync
curl -s -H "$H" 127.0.0.1:3001/wallet/balance

````



```bash
sleep 12
curl -s -X POST -H "$H" 127.0.0.1:3001/node/sync
curl -s -H "$H" 127.0.0.1:3001/wallet/balance
```

Result: `onchain_total_sat` and `onchain_spendable_sat` are `10000000` (0.1 BTC). The peer balance (`:3002`) is still `0`.

### 6.2 Get a receive address on the peer

```bash
curl -s -X POST -H "$H" 127.0.0.1:3002/wallet/address
```

Returns `{"address":"bcrt1q..."}`. Run it yourself, the address changes per node data dir. The one used in this test was `bcrt1qxhddvq696l5zp5guclmgg46wewscgj4wrcsw9m`.

### 6.3 Send 0.01 BTC from main node to peer

`amount_sat` is a string. `1000000` sats is 0.01 BTC.

```bash
PEER_ADDR=bcrt1qxhddvq696l5zp5guclmgg46wewscgj4wrcsw9m   # paste the address from 6.2
curl -s -X POST -H "$H" -H 'content-type: application/json' \
  --data "{\"address\":\"$PEER_ADDR\",\"amount_sat\":\"1000000\"}" \
  127.0.0.1:3001/wallet/send
```
````bash
export LN_API_TOKEN=$(grep ^LN_API_TOKEN frontend/.env.local | cut -d= -f2)
H="authorization: Bearer $LN_API_TOKEN"
````

# 1. Main node's address (bcrt1qre209s... belongs to it)
````bash
MAIN_ADDR=bcrt1qre209s3x42m4lge7m3mhpqwkwyhafms8p3u4rs
````
# 2. Send 0.005 BTC (500000 sats) from the peer
````bash
curl -s -X POST -H "$H" -H 'content-type: application/json' \
  --data "{\"address\":\"$MAIN_ADDR\",\"amount_sat\":\"500000\"}" \
  127.0.0.1:3002/wallet/send

````



Returns `{"txid":"..."}`.

### 6.4 Confirm it and check both balances

```bash
backend/scripts/regtest.sh mine 6
sleep 12
curl -s -X POST -H "$H" 127.0.0.1:3001/node/sync
curl -s -X POST -H "$H" 127.0.0.1:3002/node/sync
curl -s -H "$H" 127.0.0.1:3001/wallet/balance
curl -s -H "$H" 127.0.0.1:3002/wallet/balance
```

Observed:

| Node | `onchain_total_sat` |
| --- | --- |
| main (3001) | `8999857` |
| peer (3002) | `1000000` |

Main dropped by `1000143`: the `1000000` sent plus a `143` sat fee.

### 6.6 Send from the peer back to the main node (tested)

Same call as 6.3, aimed at the peer's API (`:3002`) with a main-node address as the destination. Keep the amount below the peer's balance so the fee fits.

```bash
MAIN_ADDR=bcrt1qre209s3x42m4lge7m3mhpqwkwyhafms8p3u4rs   # an address owned by the main node
curl -s -X POST -H "$H" -H 'content-type: application/json' \
  --data "{\"address\":\"$MAIN_ADDR\",\"amount_sat\":\"500000\"}" \
  127.0.0.1:3002/wallet/send

backend/scripts/regtest.sh mine 6
sleep 12
curl -s -X POST -H "$H" 127.0.0.1:3001/node/sync
curl -s -X POST -H "$H" 127.0.0.1:3002/node/sync
curl -s -H "$H" 127.0.0.1:3001/wallet/balance
curl -s -H "$H" 127.0.0.1:3002/wallet/balance
```

Observed, starting from main `18999857` and peer `1000000`:

| Node | `onchain_total_sat` |
| --- | --- |
| main (3001) | `19499857` |
| peer (3002) | `499857` |

Main gained `500000`. Peer dropped by `500143`: the `500000` sent plus a `143` sat fee.

Use a main-node address, not the peer's own, or you pay yourself. Get a fresh one with `curl -s -X POST -H "$H" 127.0.0.1:3001/wallet/address`.

### 6.7 Troubleshooting

- `connection refused` on 18443 and nodes stuck at `is_synced:false`, `block_height:0`: bitcoind is not running. Run step 1.
- `docker ps` empty: containers stopped (reboot). Step 1 restarts the same volume, so the chain and funds are kept.
- Balance stays `0` after funding: the transaction is unconfirmed or the node has not synced. Mine blocks, then sync.
