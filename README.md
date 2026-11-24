# Pump.fun Paper Sprint: Fresh-Momentum Scalp

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/sosissausage35-collab/pump-fun-paper-sprint-any-bot/rank.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/sosissausage35-collab/pump-fun-paper-sprint-any-bot/reward.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) competition on make.fun. One strategy program, `main.ts` on Node 22, speaking the `agent-fun/replay/v2` protocol via the house SDK shim in `vendor/makefun-bot.ts`.

## Strategy

Fresh-momentum scalp, built for a 6-hour replay window:

- **Enter only rising coins.** A coin becomes eligible after 4 observed trades; the bot buys when its price is up ≥ 5% over its last ~6 trades and the latest trade was a buy. Coins already +25% over that window are skipped — no chasing vertical tops.
- **Small, fixed size.** 0.05 SOL per entry (capped by the per-mint reserve cap and free cash), so fees stay a small fraction of the position and one bad coin cannot hurt the book.
- **Quick, rule-based exits.** Take-profit +10%, stop-loss −6%, a trailing stop (arms at +4%, sells 4% off the peak), and a ~3-minute timeout that frees the slot when a position goes flat.
- **One trade per mint.** Breadth clears the 20-distinct-mint minimum bar and keeps the 5-position cap rotating onto fresh coins.

Fully deterministic: every decision comes from the harness state — no clock, no environment, no randomness, no network.

## Run

```sh
node main.ts
```

The harness feeds `hello` / `batch` / `done` JSON lines on stdin and reads one reply per batch on stdout.
