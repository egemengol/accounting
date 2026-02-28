# Accounting for Fintech Engineers

Most engineers in fintech treat accounting as a business concern — someone else's problem, handed off to the Finance team. This is a mistake. Accounting is a constraint system. Its core invariant — `sum(all_postings) = 0`, always — is a conservation law, and violating it produces the same class of bugs as violating referential integrity or overflowing a counter.

This curriculum teaches accounting from first principles, the way you'd want a systems concept taught: with invariants, failure modes, and production consequences. It covers double-entry bookkeeping, account types, two-phase settlement, multi-currency inventory, P&L accounting, and the fintech-specific patterns that production ledgers require.

Every concept is shown in two representations simultaneously — **Beancount** (text-based, human-readable, a reasoning tool) and **TigerBeetle** (binary, OLTP-grade, a production tool). The same invariants hold at both levels. Seeing them side by side makes the abstractions collapse in the right way.

## How to use this

Work linearly. Each module has:
- A **concept section** — the core invariant or pattern
- A **Socratic dialogue** — try to answer before expanding
- **Adversarial exercises** — where the actual learning happens. Do not skip them.
