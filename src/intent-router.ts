import { BigInt, Bytes, log } from "@graphprotocol/graph-ts";
import {
  SwapExecuted as SwapExecutedEvent,
  BridgeFeeCollected as BridgeFeeCollectedEvent,
} from "../generated/IntentRouter/IntentRouter";
import {
  Swap,
  BridgeFee,
  User,
  Venue,
  RouterStat,
  DayStat,
} from "../generated/schema";

const ZERO = BigInt.fromI32(0);
const ONE = BigInt.fromI32(1);
const ROUTER_STAT_ID = Bytes.fromUTF8("router");
const SECONDS_PER_DAY = 86400;

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

  let day = loadOrCreateDayStat(dayBucket(ts));
  day.swapCount = day.swapCount.plus(ONE);
  day.totalFee = day.totalFee.plus(event.params.fee);
  if (isNewUser) day.uniqueUsers = day.uniqueUsers.plus(ONE);
  day.save();

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
