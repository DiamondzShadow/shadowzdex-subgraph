import { BigInt, BigDecimal, Bytes, Address, dataSource, log } from "@graphprotocol/graph-ts";
import {
  SwapExecuted as SwapExecutedEvent,
  BridgeFeeCollected as BridgeFeeCollectedEvent,
} from "../generated/IntentRouter/IntentRouter";
import { ERC20 } from "../generated/IntentRouter/ERC20";
import {
  Swap,
  BridgeFee,
  User,
  Venue,
  RouterStat,
  DayStat,
  Token,
  TokenDayData,
} from "../generated/schema";

const ZERO = BigInt.fromI32(0);
const ONE = BigInt.fromI32(1);
const ROUTER_STAT_ID = Bytes.fromUTF8("router");
const SECONDS_PER_DAY = 86400;
const ZERO_BD = BigDecimal.zero();

const USDC_DECIMALS = 6;
// Max decimals we'll scale by — guards exponentToBigDecimal against a hostile/broken
// token reporting an absurd decimals() (uint8 up to 255), which would make the scaling
// loop run away on every swap. 36 covers every real ERC20.
const MAX_DECIMALS = 36;

// Native USDC for the network this deployment indexes. The mapping file is shared
// across the arbitrum/base/polygon manifests, so detection MUST be network-specific —
// a single global set could misclassify a token that collides with another chain's
// USDC address. Resolved once per network via dataSource.network().
function usdcForNetwork(): string {
  let net = dataSource.network();
  if (net == "arbitrum-one") return "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
  if (net == "matic") return "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
  if (net == "base") return "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  return "";
}

function isUsdc(addr: Bytes): boolean {
  let usdc = usdcForNetwork();
  return usdc != "" && addr.toHexString() == usdc;
}

// 10^decimals as a BigDecimal, for scaling raw token amounts to human units.
function exponentToBigDecimal(decimals: i32): BigDecimal {
  let d = decimals;
  if (d < 0) d = 0;
  if (d > MAX_DECIMALS) d = MAX_DECIMALS;
  let bd = BigDecimal.fromString("1");
  let ten = BigDecimal.fromString("10");
  for (let i = 0; i < d; i++) bd = bd.times(ten);
  return bd;
}

function toDecimal(raw: BigInt, decimals: i32): BigDecimal {
  let scale = exponentToBigDecimal(decimals);
  if (scale.equals(ZERO_BD)) return ZERO_BD;
  return raw.toBigDecimal().div(scale);
}

function loadOrCreateToken(addr: Bytes, ts: BigInt): Token {
  let t = Token.load(addr);
  if (t == null) {
    t = new Token(addr);
    // Read metadata on-chain; fall back gracefully if the call reverts.
    let erc20 = ERC20.bind(Address.fromBytes(addr));
    let dec = erc20.try_decimals();
    t.decimals = dec.reverted ? 18 : dec.value;
    let sym = erc20.try_symbol();
    t.symbol = sym.reverted ? "" : sym.value;
    t.lastPriceUsd = ZERO_BD;
    t.lastSwapVolumeUsd = ZERO_BD;
    t.totalVolumeUsd = ZERO_BD;
    t.pricedSwapCount = ZERO;
    t.lastUpdated = ts;
  }
  return t;
}

// Record a USD-priced swap for `token` (the non-USDC side, already loaded by the
// caller). `priceUsd` is USD per token, `volumeUsd` the USDC value traded. Updates the
// Token rollup + OHLC day bar.
function recordTokenPrice(
  token: Token,
  priceUsd: BigDecimal,
  volumeUsd: BigDecimal,
  ts: BigInt,
  day: i32,
): void {
  token.lastPriceUsd = priceUsd;
  token.lastSwapVolumeUsd = volumeUsd;
  token.totalVolumeUsd = token.totalVolumeUsd.plus(volumeUsd);
  token.pricedSwapCount = token.pricedSwapCount.plus(ONE);
  token.lastUpdated = ts;
  token.save();

  let id = token.id.concatI32(day);
  let bar = TokenDayData.load(id);
  if (bar == null) {
    bar = new TokenDayData(id);
    bar.token = token.id;
    bar.date = day;
    bar.open = priceUsd;
    bar.high = priceUsd;
    bar.low = priceUsd;
    bar.volumeUsd = ZERO_BD;
    bar.swapCount = ZERO;
  }
  bar.close = priceUsd;
  if (priceUsd.gt(bar.high)) bar.high = priceUsd;
  if (priceUsd.lt(bar.low)) bar.low = priceUsd;
  bar.volumeUsd = bar.volumeUsd.plus(volumeUsd);
  bar.swapCount = bar.swapCount.plus(ONE);
  bar.save();
}

// Derive and record USD price from a swap, when exactly one side is USDC.
function trackSwapPrice(event: SwapExecutedEvent, day: i32): void {
  let ts = event.block.timestamp;
  let tokenIn = event.params.tokenIn;
  let tokenOut = event.params.tokenOut;
  let inIsUsdc = isUsdc(tokenIn);
  let outIsUsdc = isUsdc(tokenOut);
  if (inIsUsdc == outIsUsdc) return; // token-token or stable-stable: no USD price

  if (inIsUsdc) {
    // Bought tokenOut with USDC.
    let usd = toDecimal(event.params.amountIn, USDC_DECIMALS);
    let other = loadOrCreateToken(tokenOut, ts);
    let qty = toDecimal(event.params.amountOut, other.decimals);
    if (qty.equals(ZERO_BD)) return;
    recordTokenPrice(other, usd.div(qty), usd, ts, day);
  } else {
    // Sold tokenIn for USDC.
    let usd = toDecimal(event.params.amountOut, USDC_DECIMALS);
    let other = loadOrCreateToken(tokenIn, ts);
    let qty = toDecimal(event.params.amountIn, other.decimals);
    if (qty.equals(ZERO_BD)) return;
    recordTokenPrice(other, usd.div(qty), usd, ts, day);
  }
}

function loadOrCreateUser(addr: Bytes, ts: BigInt): User {
  let user = User.load(addr);
  if (user == null) {
    user = new User(addr);
    user.firstSeen = ts;
    user.lastSeen = ts;
    user.swapCount = ZERO;
    user.bridgeFeeCount = ZERO;
  }
  return user;
}

function loadOrCreateVenue(id: Bytes): Venue {
  let v = Venue.load(id);
  if (v == null) {
    v = new Venue(id);
    v.swapCount = ZERO;
    v.totalFee = ZERO;
  }
  return v;
}

function loadOrCreateRouterStat(): RouterStat {
  let s = RouterStat.load(ROUTER_STAT_ID);
  if (s == null) {
    s = new RouterStat(ROUTER_STAT_ID);
    s.swapCount = ZERO;
    s.bridgeFeeCount = ZERO;
    s.uniqueUsers = ZERO;
    s.totalFee = ZERO;
    s.lastUpdated = ZERO;
  }
  return s;
}

function dayBucket(ts: BigInt): i32 {
  return ts.toI32() / SECONDS_PER_DAY;
}

function loadOrCreateDayStat(day: i32): DayStat {
  let id = Bytes.fromI32(day);
  let d = DayStat.load(id);
  if (d == null) {
    d = new DayStat(id);
    d.date = day;
    d.swapCount = ZERO;
    d.uniqueUsers = ZERO;
    d.totalFee = ZERO;
  }
  return d;
}

export function handleSwapExecuted(event: SwapExecutedEvent): void {
  let ts = event.block.timestamp;

  let user = loadOrCreateUser(event.params.user, ts);
  let isNewUser = user.swapCount.equals(ZERO) && user.bridgeFeeCount.equals(ZERO);
  user.lastSeen = ts;
  user.swapCount = user.swapCount.plus(ONE);
  user.save();

  let venue = loadOrCreateVenue(event.params.venue);
  venue.swapCount = venue.swapCount.plus(ONE);
  venue.totalFee = venue.totalFee.plus(event.params.fee);
  venue.save();

  let stat = loadOrCreateRouterStat();
  stat.swapCount = stat.swapCount.plus(ONE);
  stat.totalFee = stat.totalFee.plus(event.params.fee);
  if (isNewUser) stat.uniqueUsers = stat.uniqueUsers.plus(ONE);
  stat.lastUpdated = ts;
  stat.save();

  let dayIdx = dayBucket(ts);
  let day = loadOrCreateDayStat(dayIdx);
  day.swapCount = day.swapCount.plus(ONE);
  day.totalFee = day.totalFee.plus(event.params.fee);
  if (isNewUser) day.uniqueUsers = day.uniqueUsers.plus(ONE);
  day.save();

  // Per-token USD price + OHLC (when one side is USDC).
  trackSwapPrice(event, dayIdx);

  let id = event.transaction.hash.concatI32(event.logIndex.toI32());
  let swap = new Swap(id);
  swap.txHash = event.transaction.hash;
  swap.logIndex = event.logIndex;
  swap.blockNumber = event.block.number;
  swap.timestamp = ts;
  swap.user = user.id;
  swap.venue = event.params.venue;
  swap.tokenIn = event.params.tokenIn;
  swap.tokenOut = event.params.tokenOut;
  swap.amountIn = event.params.amountIn;
  swap.amountOut = event.params.amountOut;
  swap.fee = event.params.fee;
  swap.save();
}

export function handleBridgeFeeCollected(event: BridgeFeeCollectedEvent): void {
  let ts = event.block.timestamp;

  let user = loadOrCreateUser(event.params.user, ts);
  let isNewUser = user.swapCount.equals(ZERO) && user.bridgeFeeCount.equals(ZERO);
  user.lastSeen = ts;
  user.bridgeFeeCount = user.bridgeFeeCount.plus(ONE);
  user.save();

  let stat = loadOrCreateRouterStat();
  stat.bridgeFeeCount = stat.bridgeFeeCount.plus(ONE);
  if (isNewUser) stat.uniqueUsers = stat.uniqueUsers.plus(ONE);
  stat.lastUpdated = ts;
  stat.save();

  let id = event.transaction.hash.concatI32(event.logIndex.toI32());
  let fee = new BridgeFee(id);
  fee.txHash = event.transaction.hash;
  fee.logIndex = event.logIndex;
  fee.blockNumber = event.block.number;
  fee.timestamp = ts;
  fee.user = user.id;
  fee.token = event.params.token;
  fee.amount = event.params.amount;
  fee.tier = event.params.tier;
  fee.save();
}
