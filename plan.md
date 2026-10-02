# Lightning Tool: Project Plan

A Rust for Bitcoin capstone. The tool teaches how Lightning payments work: invoices first, then channels, routing and liquidity.

## 1. Goals and scope

| | Scope | Status |
|---|---|---|
| MVP | BOLT11 invoice decoder: parse, show every field, validate the signature, report expiry | Graded deliverable |
| Phase two | Lightning node on regtest (ldk-node): fund, open channel, create and pay invoices, balances, history | After MVP |

**In scope:** BOLT11 decoding, regtest/signet node, channels, payments, web UI.
**Out of scope:** mainnet funds, BOLT12, mobile app, multi-user accounts.
**Target users:** developers and learners studying Lightning.

**Success criteria**
- Every BOLT11 spec test vector decodes correctly, and every field matches `lightning-invoice`.
- A full regtest flow works through the UI: fund, open, invoice, pay, close.

## 2. Key decisions

- **Decoder first**, reused by the node tool as a pre-payment check.
- **Hand-written parser** (bech32, HRP, tagged fields, signature), cross-checked field by field against `lightning-invoice` in tests. The crate acts as a correctness oracle.
- **No clock inside the core.** The current time and payment policy come in through `DecodeContext`, so results are deterministic and the crate can run in WASM.
- **Frontend is Next.js.** For the MVP the decoder runs in the browser via WASM. axum only arrives with the node.
- **Pinned versions (one rust-lightning release set):** ldk-node 0.7, lightning 0.2, lightning-invoice 0.34, bitcoin 0.32, secp256k1 0.29.

## 3. Repository layout

```
Capstone Project/
├── plan.md
├── backend/                     # Rust workspace
│   ├── Cargo.toml
│   └── crates/
│       ├── invoice-core/        # pure decoder, no I/O, no clock
│       ├── invoice-cli/         # clap CLI: decode <invoice> [--json] ...
│       ├── invoice-wasm/        # wasm-bindgen wrapper for the browser
│       ├── node-core/           # phase two: ldk-node wrapper
│       └── api-server/          # phase two: axum REST + SSE
└── frontend/                    # Next.js (App Router, TypeScript, pnpm)
    ├── app/
    │   ├── decode/page.tsx      # Decoder (MVP)
    │   ├── page.tsx             # Dashboard (phase two)
    │   ├── wallet/ channels/ receive/ send/ payments/
    │   └── api/[...path]/route.ts   # proxy to axum, adds the token server-side
    ├── components/              # InvoiceAnatomy, InvoiceCard, CheckList, RouteHintList, ...
    └── lib/                     # wasm loader, api helpers, generated types
```

## 4. Architecture

```
MVP:        Browser ──▶ Next.js page ──▶ invoice-wasm ──▶ invoice-core

Phase two:  Browser ──▶ Next.js (UI + route handlers) ──HTTP──▶ axum api-server
                                                             ├─▶ invoice-core
                                                             └─▶ node-core ──▶ ldk-node ──▶ bitcoind (Polar)
```

- The browser never talks to axum directly, so the API token stays on the Next.js server.
- Live node events: axum SSE ──▶ Next.js route ──▶ browser.

## 5. Decoder design (`invoice-core`)

### How an invoice is laid out
```
ln + currency + amount | 1 | timestamp (7 words) | tagged fields ... | signature (104 words) | checksum (6)
```

### Modules
| Module | Responsibility |
|---|---|
| `bech32.rs` | charset, last-`1` split, mixed-case rejection, checksum, no 90-character limit |
| `words.rs` | 5-to-8 bit regrouping, 8-to-5, big-endian integers |
| `hrp.rs` | network (`bc`, `tb`, `tbs`, `bcrt`) and amount in msat (`m`, `u`, `n`, `p`; pico must end in 0) |
| `fields.rs` | tagged fields `p s d h n x c f r 9 m`, length rules, duplicates, unknown fields, route hints, fallback addresses, feature bits |
| `signature.rs` | message hash, verify against `n` (low-S only) or recover the payee key |
| `checks.rs` | builds the validation report; the verdict is derived from the checks |
| `decoded.rs` | public output types with JSON conventions |
| `error.rs` | fatal errors with character positions |

### Public API
```rust
pub fn decode(input: &str, ctx: &DecodeContext) -> Result<Decoded, DecodeError>

pub struct Decoded {
    pub normalized: String,          // trimmed, lowercased, no "lightning:" prefix
    pub invoice: DecodedInvoice,     // what the invoice says
    pub report: ValidationReport,    // what we think of it
    pub anatomy: Vec<RawField>,      // every segment of the string, for the learning view
}

pub struct DecodeContext {
    pub now_unix: u64,
    pub expected_network: Option<Network>,
    pub expected_payee: Option<PublicKey>,
    pub description_preimage: Option<String>,
    pub max_amount_msat: Option<u64>,
}
```

### Three kinds of problems
| Situation | Example | Result |
|---|---|---|
| Unreadable | bad checksum, no separator, too short | `Err(DecodeError)` |
| Readable but wrong | expired, wrong network, signature mismatch | check = Fail |
| Worth noting | amountless, description hash only, skipped fields | check = Warn / Info |

**Checks:** Signature, ExpectedPayee, Expiry, Network, Amount, DescriptionHash, RequiredFields, Features, FieldEncoding, UnknownFields.

**Verdict:** `Invalid` if Signature or RequiredFields fail, `NotPayable` for any other failure, otherwise `Payable`.

### JSON conventions
- msat amounts as strings (u64 can exceed JavaScript's 2^53)
- hashes and keys as lowercase hex
- enums with data as `{ "kind": ..., "value": ... }`
- snake_case field names
- short channel ids as `block x tx x output`

## 6. Roadmap

| Sprint | Work | Output |
|---|---|---|
| 0 | Git, Cargo workspace in `backend/`, pinned versions, rustfmt, clippy, CI | Skeleton |
| 1 | `invoice-core` modules plus tests (unit, spec vectors, oracle, tampering, proptest) | Decoder library |
| 2 | `invoice-cli` (table and `--json`) and `invoice-wasm`; export TypeScript types (ts-rs) | CLI + WASM package |
| 3 | Next.js app in `frontend/`: Decoder page, anatomy highlighter, checks list, tooltips; deploy to Vercel | **MVP, v0.1.0** |
| 4 | `node-core` (ldk-node + Polar bitcoind), axum with a localhost-only bearer token, Next.js proxy, Dashboard + Wallet pages | Node running |
| 5 | Peers and channels (open, cooperative and force close), Channels page with liquidity bars | Channels |
| 6 | Create invoices (QR) and pay them, with the decoder as a pre-payment firewall; Receive + Send pages | Payments |
| 7 | Payment history, SSE live events, docker compose, Playwright E2E, docs | **v0.2.0** |

## 7. Testing

| Type | What | Tools |
|---|---|---|
| Unit | bech32, regrouping, amounts, SCID formatting, feature bits | `cargo test` |
| Property | 8 to 5 to 8 round trip, amount round trip | `proptest` |
| Spec conformance | all valid and invalid BOLT11 examples | fixtures + `cargo test` |
| Oracle | every field compared with `lightning-invoice` | `cargo test` |
| Tampering | flipped amount with a fixed checksum changes the recovered payee; with `n` it fails | `cargo test` |
| Real invoices | Polar: amountless, route hints, short expiry, regtest/signet | fixtures |
| API (phase two) | endpoints, auth failures, error shapes | axum tests |
| Integration (phase two) | fund, open, pay, receive, close on regtest | Polar + script |
| Frontend | components and pages | Vitest + Testing Library |
| End-to-end | decode, then pay, in the browser | Playwright |

## 8. Security

- The API binds to localhost only and needs a bearer token held by the Next.js server.
- The seed is never returned by any endpoint.
- Before paying: network matches, not expired, amount under the limit, payee allowed.
- Invoice descriptions are untrusted input: render them as text, never as HTML.

## 9. Deployment

- **Public:** Decoder page on Vercel (static + WASM, no server).
- **Local:** `docker compose up` runs axum and Next.js; Polar provides bitcoind and peers.
- **Releases:** tagged versions, GitHub Releases, CI on every push.

## 10. Maintenance

- Upgrade the rust-lightning crates together and rerun all tests.
- Watch the BOLTs repository for invoice format changes.
- Document backing up the node data directory.
- Roadmap ideas: BOLT12 offers, LNURL, a payment policy engine, a Tauri desktop app.

## 11. Conventions

- Rust: `// === Section` separators, explicit `return`, `thiserror` errors, no `unwrap` in library code.
- TypeScript: no `any`, explicit return types, explicit state annotations.
- Git: conventional, signed, single-line commit messages on feature branches.

## 12. Setup notes

- Tools: Rust (stable), `clang` (the wasm32 build of `secp256k1` compiles C), `wasm-pack`, Node 22 with pnpm.
- `backend/scripts/build-wasm.sh` regenerates `frontend/lib/types` (ts-rs) and `frontend/lib/invoice-wasm` (wasm-pack).
- The WASM build enables `secp256k1/lowmemory` and a size-optimized release profile: 345 KB (154 KB gzipped) instead of 1.4 MB.
- `wasm-opt` needs `--enable-bulk-memory` and related flags (set in `invoice-wasm/Cargo.toml`) because current Rust emits those instructions.
- CI fails if the committed TypeScript types are stale.
