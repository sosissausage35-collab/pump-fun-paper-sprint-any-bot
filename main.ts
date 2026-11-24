// Fresh-momentum scalp for the Pump.fun Paper Sprint (agent-fun/replay/v2).
//
// Idea: pump.fun coins move in fast bursts right after launch. This bot only
// chases coins that are ALREADY rising on their own tape — it buys a coin
// whose price climbed >= 5% over its last few trades (latest trade a buy),
// rides it with a take-profit, a stop-loss and a trailing stop, and frees the
// slot quickly so the 5-position cap keeps rotating onto new coins. One trade
// per mint: breadth is what clears the 20-distinct-mint minimum bar, and a
// coin that already paid (or stopped) us out does not get a second ticket.
//
// Sizing is fixed and small (0.05 SOL per entry, min round trip 0.01 SOL) so
// fees (~1.25% curve fees each way + 0.000105 SOL tx fees per order) stay a
// small fraction of the position and a single bad coin cannot hurt the book.
//
// Fully deterministic: every decision comes from the harness state. No clock,
// no environment, no randomness, no network, no reads outside this repo.

import { runBot, LAMPORTS_PER_SOL, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

// ---- tunables (SOL amounts in lamports) ---------------------------------
const ENTRY_LAMPORTS = 50_000_000n; // 0.05 SOL per buy
const MIN_ENTRY_LAMPORTS = 10_000_000n; // 0.01 SOL: the round-trip minimum bar
const MAX_BUYS_PER_BATCH = 2;
const MIN_TRADES_BEFORE_ENTRY = 4; // trades observed before a coin is eligible
const MOMENTUM_WINDOW = 6; // trades back to measure the rise over
const MOMENTUM_MIN = 1.05; // +5% over the window
const TAKE_PROFIT = 1.10; // +10% vs entry
const STOP_LOSS = 0.94; // -6% vs entry
const TRAIL_TRIGGER = 1.04; // arm the trailing stop once +4% up
const TRAIL_DROP = 0.96; // sell if 4% off the peak since entry (tighter: lock gains)
const MOMENTUM_MAX = 1.25; // do not chase a coin already +25% over the window
const HOLD_TIMEOUT_SLOTS = 450; // ~3 min: exit a flat position, free the slot
const TIMEOUT_EXIT_MIN = 1.02; // ...unless it is already +2% up
const SLIPPAGE_BPS = 500; // 5%

// ---- per-mint tape --------------------------------------------------------
interface Tape {
  prices: number[]; // last few trade prices (SOL per token), oldest first
  complete: boolean;
  everTraded: boolean; // we already took (and closed) a position here
}

interface Entry {
  entryPrice: number; // SOL per token, from the buy fill (quote spent / tokens)
  peakPrice: number; // best price seen since entry
  entrySlot: number; // slot the buy fill resolved at
}

const tapes = new Map<string, Tape>();
const entries = new Map<string, Entry>();

function curvePrice(state: BotState, mint: string): number | null {
  const c = state.curves.get(mint);
  if (c === undefined) return null;
  if (c.virtual_token_reserves <= 0n || c.virtual_quote_reserves <= 0n) return null;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

function tapeOf(mint: string): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { prices: [], complete: false, everTraded: false };
    tapes.set(mint, t);
  }
  return t;
}

await runBot({
  onBatch(state, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];

    // 1. Fold in this batch's fills first: record entries, retire closed mints.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        const spent = BigInt(fill.quote_lamports);
        const tokens = BigInt(fill.token_amount);
        if (spent > 0n && tokens > 0n) {
          const price = Number(spent) / Number(tokens);
          entries.set(fill.mint, { entryPrice: price, peakPrice: price, entrySlot: fill.slot });
        }
      } else {
        entries.delete(fill.mint);
        tapeOf(fill.mint).everTraded = true;
      }
    }
    // A position the harness flattened (complete / end of data) is gone too.
    for (const mint of [...entries.keys()]) {
      if (!state.positions.has(mint)) {
        entries.delete(mint);
        tapeOf(mint).everTraded = true;
      }
    }

    // 2. Update tapes from this batch's events.
    const candidates: string[] = [];
    for (const e of batch.events) {
      const t = tapeOf(e.mint);
      if (e.event === 'CompleteEvent') {
        t.complete = true;
      } else if (e.event === 'TradeEvent') {
        if (e.virtual_token_reserves === '0' || e.virtual_quote_reserves === '0') continue;
        const price = Number(BigInt(e.virtual_quote_reserves)) / Number(BigInt(e.virtual_token_reserves));
        if (!Number.isFinite(price) || price <= 0) continue;
        t.prices.push(price);
        if (t.prices.length > 12) t.prices.shift();
        if (e.is_buy) candidates.push(e.mint);
      } else if (e.event === 'CreateEvent') {
        // Seed the tape with the launch price so momentum has a baseline.
        if (e.virtual_token_reserves !== '0' && e.virtual_quote_reserves !== '0') {
          const price = Number(BigInt(e.virtual_quote_reserves)) / Number(BigInt(e.virtual_token_reserves));
          if (Number.isFinite(price) && price > 0 && t.prices.length === 0) t.prices.push(price);
        }
      }
    }

    // 3. Exits: check every open position against TP / SL / trailing / timeout.
    // Do not re-send a sell already in flight (2-slot latency): the first one
    // will fill, and duplicates only burn failed-tx fees.
    const pendingSells = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSells.add(p.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      if (pendingSells.has(mint)) continue;
      const entry = entries.get(mint);
      const price = curvePrice(state, mint);
      if (entry === undefined || price === null) continue;
      if (price > entry.peakPrice) entry.peakPrice = price;

      let exit = false;
      if (price >= entry.entryPrice * TAKE_PROFIT) exit = true; // take profit
      else if (price <= entry.entryPrice * STOP_LOSS) exit = true; // stop loss
      else if (entry.peakPrice >= entry.entryPrice * TRAIL_TRIGGER && price <= entry.peakPrice * TRAIL_DROP) exit = true; // trailing stop
      else if (state.slot - entry.entrySlot >= HOLD_TIMEOUT_SLOTS && price <= entry.entryPrice * TIMEOUT_EXIT_MIN) exit = true; // stale flat position

      if (exit) {
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SLIPPAGE_BPS });
      }
    }

    // 4. Entries: buy rising coins we have never traded, while a slot is free.
    const selling = new Set(orders.filter((o) => o.side === 'sell').map((o) => o.mint));
    // pending is keyed by client_id, so collect mints with a buy still in flight.
    const pendingBuys = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') pendingBuys.add(p.order.mint);
    }
    let buys = 0;
    for (const mint of candidates) {
      if (buys >= MAX_BUYS_PER_BATCH) break;
      if (selling.has(mint)) continue;
      const t = tapes.get(mint);
      if (t === undefined || t.complete || t.everTraded) continue;
      if (state.positions.has(mint)) continue;
      if (pendingBuys.has(mint)) continue; // a buy already in flight here
      if (state.committedPositionCount() + buys >= state.hello.caps.max_open_positions) break;
      if (t.prices.length < MIN_TRADES_BEFORE_ENTRY) continue;

      // Momentum: price now vs up to MOMENTUM_WINDOW trades ago.
      const window = t.prices.slice(-(MOMENTUM_WINDOW + 1));
      const base = window[0];
      const now = window[window.length - 1];
      if (!(base > 0) || !(now >= base * MOMENTUM_MIN)) continue;
      if (now >= base * MOMENTUM_MAX) continue; // already vertical: do not chase the top

      // Size: fixed 0.05 SOL, capped by the per-mint reserve cap and free cash.
      const cap = state.maxBuyLamports(mint);
      let size = ENTRY_LAMPORTS;
      if (cap > 0n && size > cap) size = cap;
      const free = state.freeCashLamports() - state.txFeeLamports();
      if (size > free) size = free;
      if (size < MIN_ENTRY_LAMPORTS) continue;

      orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: SLIPPAGE_BPS });
      buys++;
    }

    return orders;
  },
});
