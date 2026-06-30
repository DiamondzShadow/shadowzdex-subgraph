# shadowzdex-subgraph

Goldsky-hosted subgraph for the ShadowzDex `IntentRouter` — indexes `SwapExecuted` and `BridgeFeeCollected` events on Arbitrum One and Base. Powers the analytics page on dex.diamondz.one and supplies the volume / unique-user / swap-count metrics that CMC and CoinGecko require for DEX listing review.

## Indexed contracts

| Network | Role | Address | Start block |
|---|---|---|---|
| Arbitrum One (42161) | IntentRouter (current, v2-11field) | `0xE80a2d3611EFdA4AA594A427eF687f89F36FD1Ee` | 455776834 |
| Arbitrum One (42161) | IntentRouter (legacy, frozen) | `0x49B99E4B9743c8082be12bfDe6DB39E8a75B7817` | 454862471 → 455776834 |
| Base (8453) | IntentRouter | `0x1BEf947466AFfE828363c669Aaf26964CBeeCA97` | 45000532 |

Legacy router is bounded with `endBlock` so we backfill pre-migration history without continuing to scan dead bytecode.

## Entities

- `Swap`, `BridgeFee` — immutable per-event records (tx hash + logIndex id)
- `User` — first/last seen, swap + bridge counters, derived event lists
- `Venue` — per-venue swap count and accumulated fee (keyed by the `bytes32` venue id used by IntentRouter)
- `RouterStat` — global counters (singleton, id = `"router"`)
- `DayStat` — per-UTC-day swap count, unique users, fees
- `Token` — per-token rollup: last USD price, last-swap + total USD volume, swap count
- `TokenDayData` — per-token daily OHLC (USD) + USD volume, keyed by token/day

`amountIn` / `amountOut` / `fee` / `amount` are stored as raw `BigInt` in token units. **USD price** is derived on-chain from *execution price* — for any swap where exactly one side is native USDC, `price = usdcAmount / tokenAmount` (decimal-adjusted; token decimals read via an ERC20 binding). This is deliberately **not** an oracle: it records the real price at which curve/router swaps actually executed. Tokens that never trade against USDC simply get no `TokenDayData`.

## Local setup

```bash
cp .env.example .env
# fill in GOLDSKY_API_KEY and GOLDSKY_PROJECT_ID
npm install
npx goldsky login --token "$GOLDSKY_API_KEY"
```

## Deploy

Arbitrum:
```bash
npm run codegen
npm run build
npm run deploy:arb
npm run tag:arb
```

Base:
```bash
npm run codegen:base
npm run build:base
npm run deploy:base
npm run tag:base
```

The `tag:*` scripts pin `latest` so the gateway's GraphQL client can hit a stable URL while you redeploy versions.

## Querying

After deploy, Goldsky returns a GraphQL endpoint per subgraph. Example:

```graphql
{
  routerStat(id: "0x726f75746572") {
    swapCount
    uniqueUsers
    totalFee
    lastUpdated
  }
  dayStats(orderBy: date, orderDirection: desc, first: 30) {
    date
    swapCount
    uniqueUsers
    totalFee
  }
}
```

(`id` for `RouterStat` is the bytes encoding of `"router"` = `0x726f75746572`.)

## CMC / CoinGecko hand-off

These are the fields each platform's reviewer typically asks for. All come straight from `routerStat` + `dayStats`:

- 24h / 7d / 30d swap count → sum `dayStats[date >= now-N]`
- 24h / 7d / 30d unique users → bucket by `User.firstSeen` or aggregate `dayStats.uniqueUsers`
- Total fees collected → `routerStat.totalFee`
- Per-venue routing breakdown → `venues(orderBy: swapCount)`
- Per-token price chart → `tokenDayDatas(where: { token: $addr }, orderBy: date)` (OHLC + USD volume)
- Latest token price → `token(id: $addr).lastPriceUsd`

USD price/volume for tokens that trade against USDC is now derived on-chain (see `Token` / `TokenDayData`). For tokens with no USDC route, layer an external price feed on top of `Swap` entities (e.g. a Cloudflare Worker joining a CoinGecko price keyed on `tokenIn`).
