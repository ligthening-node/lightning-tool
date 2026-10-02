# Invoice payment test (regtest)

Goal: pay a given BOLT11 invoice end to end and confirm both sides.

Invoice (regtest, 1000 sat, description "book"):

```
lnbcrt10u1p4tu3t5dq8vfhk76cnp4qwf4t67xfty2qzxnfev60dkur0amwh0hxwzrukx5gzksxyxqqvjtypp5a8wxzmk7kadh5vkm6vg6h9cysrprjq3n3gw6wruatlnekg2zlxtqsp57htyh00h5ja5kpv52ngzd3j8ufyf53f8e3xcd3czdr0p4z0e7p6s9qyysgqcqzp2xqrrssf2285ha8nu0efxz3rwm2rs0xlgnrawc846ydc3p2gcqarghwhqlqgdquj66jy55dku480nnwcaacxjmzdtxad8u4s9zme8cpmw3wydgqxvc65p
```

Setup used in every step:

```bash
export LN_API_TOKEN=$(grep ^LN_API_TOKEN frontend/.env.local | cut -d= -f2)
H="authorization: Bearer $LN_API_TOKEN"
INV='<the invoice above>'
````
````bash
export LN_API_TOKEN=$(grep ^LN_API_TOKEN frontend/.env.local | cut -d= -f2)
H="authorization: Bearer $LN_API_TOKEN"
INV='lnbcrt10u1p4tu3t5dq8vfhk76cnp4qwf4t67xfty2qzxnfev60dkur0amwh0hxwzrukx5gzksxyxqqvjtypp5a8wxzmk7kadh5vkm6vg6h9cysrprjq3n3gw6wruatlnekg2zlxtqsp57htyh00h5ja5kpv52ngzd3j8ufyf53f8e3xcd3czdr0p4z0e7p6s9qyysgqcqzp2xqrrssf2285ha8nu0efxz3rwm2rs0xlgnrawc846ydc3p2gcqarghwhqlqgdquj66jy55dku480nnwcaacxjmzdtxad8u4s9zme8cpmw3wydgqxvc65p'
````
````bash
curl -s -X POST -H "$H" -H 'content-type: application/json' \
  --data "{\"invoice\":\"$INV\",\"context\":{\"now_unix\":$(date +%s),\"expected_network\":\"regtest\"}}" \
  127.0.0.1:3001/decode
````

## 1. Study the repo

Read `run.md`, `docker-compose.yml`, `plan.md` and the routes in `backend/crates/api-server/src/lib.rs`. Relevant endpoints: `/decode`, `/channels` (GET, POST), `/payments` (GET, POST), `/node/sync`, `/wallet/balance`.

## 2. Check the stack is up

```bash
ss -ltn | grep -E ':(3000|3001|3002|9735|9736|18443)\b'
curl -s -H "$H" 127.0.0.1:3001/node/status
curl -s -H "$H" 127.0.0.1:3002/node/status
```

Result: all ports listening, both nodes `is_synced: true` at block 1243.

| Node | API | Node id |
| --- | --- | --- |
| main | :3001 | `039355ebc64a...c00324b2` |
| peer | :3002 | `024ab98d2ae4...4c2fd12c` |

## 3. Decode the invoice (no money moves)

`/decode` needs a `context`, otherwise it returns `missing field context`.

```bash
curl -s -X POST -H "$H" -H 'content-type: application/json' \
  --data "{\"invoice\":\"$INV\",\"context\":{\"now_unix\":$(date +%s),\"expected_network\":\"regtest\"}}" \
  127.0.0.1:3001/decode
```

| Field | Value |
| --- | --- |
| network | regtest |
| amount | 1000000 msat (1000 sat) |
| description | book |
| payment_hash | `e9dc616e...2142f996` |
| payee | `039355eb...c00324b2` (the main node) |
| expiry | 3600 s from 1790854516 |
| signature | pass |
| verdict | **payable** |

Finding: the payee is the main node, and the main node's `/payments` already listed this hash as inbound `pending`. So the invoice was created by the main node, and the payer must be the peer. Main cannot pay its own invoice.

## 4. Check liquidity

```bash
curl -s -H "$H" 127.0.0.1:3001/channels     # []
curl -s -H "$H" 127.0.0.1:3002/channels     # []
curl -s -H "$H" 127.0.0.1:3002/wallet/balance
```

Neither node had a channel, so the payment could not route. The peer had 1,499,857 sat spendable on chain, enough to fund one.

## 5. Open a channel peer to main

The peer must hold the local balance, since it is the payer.

````bash
MAIN_ID=$(curl -s -H "$H" 127.0.0.1:3001/node/status | sed 's/.*"node_id":"\([^"]*\)".*/\1/')
echo $MAIN_ID
````


```bash
curl -s -X POST -H "$H" -H 'content-type: application/json' \
  --data '{"node_id":"039355ebc64ac8a008d34e59a7b6dc1bfbb75df733843e58d440ad0310c00324b2","address":"127.0.0.1:9735","amount_sat":"500000"}' \
  127.0.0.1:3002/channels
```

## 6. Confirm the channel

```bash
backend/scripts/regtest.sh mine 6
sleep 12
curl -s -X POST -H "$H" 127.0.0.1:3001/node/sync
curl -s -X POST -H "$H" 127.0.0.1:3002/node/sync
curl -s -H "$H" 127.0.0.1:3002/channels
```

Result: `is_channel_ready: true`, `is_usable: true`, 6/6 confirmations, capacity 500000 sat, peer outbound 494340000 msat, main inbound 494340000 msat. Funding tx `d0c9152c...006c6fa5:0`.

## 7. Pay the invoice from the peer

`expected_payee` makes the node refuse the payment if the invoice is not signed by the main node.

```bash
curl -s -X POST -H "$H" -H 'content-type: application/json' \
  --data "{\"invoice\":\"$INV\",\"expected_payee\":\"039355ebc64ac8a008d34e59a7b6dc1bfbb75df733843e58d440ad0310c00324b2\"}" \
  127.0.0.1:3002/payments
```

Returned `{"payment_id":"e9dc616e...2142f996"}`.

## 8. Verify both sides

```bash
curl -s -H "$H" 127.0.0.1:3002/payments    # outbound
curl -s -H "$H" 127.0.0.1:3001/payments    # inbound
curl -s -H "$H" 127.0.0.1:3002/channels
curl -s -H "$H" 127.0.0.1:3001/channels
```

| Check | Result |
| --- | --- |
| peer payment | outbound, `succeeded`, 1000000 msat, fee 0 |
| main payment | inbound, `pending` before, `succeeded` after |
| peer channel outbound | 494340000 to 493340000 msat |
| main channel inbound | 494340000 to 493340000 msat (the 1000 sat moved) |
| preimage | `9513c57a...6d56a820` |

Preimage check: `sha256(preimage) = e9dc616e...2142f996`, which equals the invoice payment hash. This proves the payment was settled by the real payee.

Fee is 0 because the channel is a direct hop with no routing.

# Test two: 500 sat invoice with a route hint, two channels

Invoice (regtest, 500 sat, description "book"):

```
lnbcrt5u1p4tujsndq8vfhk76cnp4qwf4t67xfty2qzxnfev60dkur0amwh0hxwzrukx5gzksxyxqqvjtypp5uwk0zxn09vgxmnzlm5ljudvnlveugh0nnkafutadn0u3um2x4hwssp5zlf3q6agrh9v50kcsy6463k9xjdg0pn0vpxydap58eq8h3zy5a3s9qyysgqcqzp2xqrrssrzjqf9tnrf2us58r7mcu7mmg4wxqd9tmvmzg03zf6duklv2w5zv9lgjcqqqqyqqwtcqqyqqqqlgqqqqqqqqfqhwsxt8d8m56j6qlrk6ytqd520czm74ahnjn498znghtnjr7nwj54dwjh88uw459w9fymyxhwf4afr3ss2d7lkqxcpeejqx8509f46ccqyeqyye
```

Run `INV='<the invoice above>'` first. An empty `$INV` fails with `no bech32 separator '1' found`.

## T2.1 Decode

Same call as step 3.

| Field | Value |
| --- | --- |
| amount | 500000 msat (500 sat) |
| payment_hash | `e3acf11a...6d46addd` |
| payee | `039355eb...c00324b2` (the main node) |
| expiry | 3600 s from 1790855699 (expires at 1790859299) |
| signature | pass |
| verdict | **payable** |
| route hint (`r` field) | via peer `024ab98d...4c2fd12c`, `short_channel_id` `1x1839x1`, base fee 1000 msat, CLTV delta 72 |

The first invoice had no route hint. This one has one because the main node now has a channel with the peer. I believe `1x1839x1` is a private alias for the real channel, but I did not confirm that in the code.

`payable` only says the invoice is well formed, signed and not expired. The decoder does not know whether it was already paid.

## T2.2 Open a second channel

Not needed for a 500 sat payment, since the first channel had enough balance. It was opened to test two channels.

```bash
curl -s -X POST -H "$H" -H 'content-type: application/json' \
  --data '{"node_id":"039355ebc64ac8a008d34e59a7b6dc1bfbb75df733843e58d440ad0310c00324b2","address":"127.0.0.1:9735","amount_sat":"500000"}' \
  127.0.0.1:3002/channels
```

The channel stayed `pending` with 0 confirmations until blocks were mined (regtest mines only on request). The peer's on-chain balance dropped by 500,000 sat plus a 156 sat fee, and the anchor reserve doubled to 50,000 sat.

```bash
backend/scripts/regtest.sh mine 6
sleep 12
curl -s -X POST -H "$H" 127.0.0.1:3001/node/sync
curl -s -X POST -H "$H" 127.0.0.1:3002/node/sync
curl -s -H "$H" 127.0.0.1:3002/channels
```

| Channel | Funding tx | Capacity | Peer outbound |
| --- | --- | --- | --- |
| `1244x2x0` | `d0c9152c...006c6fa5:0` | 500,000 sat | 493,340,000 msat |
| `1250x1x1` | `ad79a083...03115d9c:1` | 500,000 sat | 494,340,000 msat |

## T2.3 Pay from the peer

```bash
curl -s -X POST -H "$H" -H 'content-type: application/json' \
  --data "{\"invoice\":\"$INV\",\"expected_payee\":\"039355ebc64ac8a008d34e59a7b6dc1bfbb75df733843e58d440ad0310c00324b2\"}" \
  127.0.0.1:3002/payments
```

Returned `{"payment_id":"e3acf11a...6d46addd"}`, which is the invoice payment hash. This only means the node accepted the request, so the result is checked next.

## T2.4 Verify both sides

| Check | Result |
| --- | --- |
| peer payment | outbound, `succeeded`, 500000 msat, fee 0 |
| main payment | inbound, `succeeded` |
| preimage | `13985a1d...2155e474` |
| `sha256(preimage)` | `e3acf11a...6d46addd`, equal to the payment hash |

Channel balances after the payment (peer outbound mirrors main inbound):

| Channel | Peer outbound | Change |
| --- | --- | --- |
| `1244x2x0` | 493,340,000 msat | none |
| `1250x1x1` | 493,840,000 msat | -500,000 msat |

Observed, not explained: the node used `1250x1x1`, the channel with more outbound balance. A guess is that the node prefers the larger balance, but one payment does not show that rule.

The route hint did not matter here. The peer is directly connected to the payee, so it paid over a real channel without using the hint. A payer that is not connected to the main node would use the hint.

Fee is 0 again: a direct hop, no routing.

## Notes

- This is regtest only, no real funds.
- Invoice one expired at 1790858116 and invoice two expires at 1790859299 (one hour after creation each). Neither can be paid twice, because both payment hashes are settled.
- Both channels stay open. Close them from the Channels page or `POST /channels/close` if a clean state is needed.
- The peer's on-chain list also shows four 0.01 BTC transfers from the main node that are not part of these tests.
