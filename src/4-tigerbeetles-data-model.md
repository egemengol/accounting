# TigerBeetle's Data Model

## Concept

TigerBeetle has exactly **two entity types**: Account and Transfer. Everything — balances, audit trails, rate limits, authorization holds, settlement — is expressed through these two types plus the ledger concept.

**Account fields:**

| Field | Type | Purpose |
|---|---|---|
| `id` | u128 | Unique identifier |
| `debits_pending` | u128 | Sum of pending debit amounts (reserved, not yet posted) |
| `debits_posted` | u128 | Sum of posted debit amounts |
| `credits_pending` | u128 | Sum of pending credit amounts |
| `credits_posted` | u128 | Sum of posted credit amounts |
| `user_data_128` | u128 | Application reference (e.g., customer ID) |
| `user_data_64` | u64 | Secondary reference |
| `user_data_32` | u32 | Tertiary reference |
| `ledger` | u32 | Currency/asset partition |
| `code` | u16 | Account type in your application's semantics |
| `flags` | u16 | Balance invariant flags |

**Balance arithmetic:**
```
// Debit-normal account (Asset, Expense):
posted_balance    = debits_posted   - credits_posted
available_balance = posted_balance  - debits_pending

// Credit-normal account (Liability, Equity, Income):
posted_balance    = credits_posted  - debits_posted
available_balance = posted_balance  - credits_pending
```

The `pending` fields represent **reserved funds** — committed but not yet settled. A user's spendable balance is `posted - pending`, not just `posted`.

**Why separate `debits_posted` and `credits_posted` instead of a net balance?**
Two reasons:
1. Auditability: a negative credit (credits decreasing below zero) is impossible if everything is correct. Separate counters let you detect anomalies a net balance cannot.
2. Correctness: `flags.debits_must_not_exceed_credits` enforces `debits_posted + debits_pending ≤ credits_posted` — this check is only possible with separate accumulators.

**Ledger = currency partition.** Accounts on different ledgers cannot transact directly. A Transfer with mismatched ledgers returns `accounts_must_have_the_same_ledger`. Cross-currency = two linked Transfers via liquidity accounts (Module 7).

**Account immutability.** Like Transfers, Accounts cannot be deleted. To "close" an account, you drain its balance to zero (submit Transfers to move all funds out), then mark it as closed in your application layer. TigerBeetle has a `close-account` recipe for this.

---

## Socratic Dialogue

> **Q1**: An account has `debits_posted = 500`, `credits_posted = 300`. What is the balance? Is it positive or negative? What account type is it?

<details><summary>Answer</summary>

Cannot fully answer without knowing the account type (which TigerBeetle doesn't store — your application knows it).

**If Asset (debit-normal)**: `balance = 500 - 300 = +200`. Positive, healthy — the account has $200.

**If Liability (credit-normal)**: `balance = 300 - 500 = -200`. Negative, which means debits exceed credits on a liability account — unusual, possibly a bug (unless this is an overpaid liability that has gone negative intentionally).

This ambiguity is intentional. TigerBeetle is a generic financial primitive. Your application assigns semantic meaning.

</details>

---

> **Q2**: What is `debits_pending`? Give a concrete fintech scenario where it matters.

<details><summary>Answer</summary>

`debits_pending` is the sum of all pending (phase-1) Transfer amounts where this account is the debit side. These amounts are *reserved* but not yet settled.

Concrete scenario: a user initiates a $500 withdrawal via ACH. Before ACH settles (1-3 days), TigerBeetle creates a pending Transfer that increases `debits_pending` by 500. The user's **available balance** immediately reflects the hold:
```
available = credits_posted - debits_posted - debits_pending
          = 1000           - 0             - 500
          = 500  (not 1000)
```
If `debits_must_not_exceed_credits` is set, a second $600 withdrawal attempt fails immediately — TigerBeetle checks against available balance. This prevents over-withdrawal during the settlement window.

</details>

---

> **Q3**: Why does TigerBeetle store `debits_posted` and `credits_posted` separately rather than a single signed net balance?

<details><summary>Answer</summary>

Two reasons:

1. **Anomaly detection**: a signed net balance of $0 could mean "nothing has happened" or "equal debits and credits." With separate accumulators, you can see if unusual patterns occurred (e.g., unexpectedly high gross flow through an account that nets to zero).

2. **Invariant enforcement**: `flags.debits_must_not_exceed_credits` checks `debits_posted + debits_pending ≤ credits_posted`. You need separate values to perform this check. A single signed integer cannot express "debits cannot exceed credits" as a structural constraint — you'd need application-level checks, which are race-prone.

</details>

---

> **Q4**: A Transfer has `ledger = 1` but the debit account has `ledger = 2`. What happens?

<details><summary>Answer</summary>

TigerBeetle returns `accounts_must_have_the_same_ledger` error. Additionally, the Transfer's `ledger` field must match both accounts' `ledger` fields.

Conceptually: you cannot transact across currencies without an explicit conversion. Setting mismatched ledgers is the equivalent of trying to add USD and EUR directly — it is a type error. Cross-currency transfers require two linked Transfers via liquidity accounts (Module 7), each on their respective ledger.

</details>

---

> **Q5**: You want to track a user's USD and EUR balances. One TigerBeetle account or two?

<details><summary>Answer</summary>

**Two accounts** — one on `ledger=USD`, one on `ledger=EUR`.

TigerBeetle accounts are single-commodity by design. This is a divergence from Beancount, where a single account can hold an Inventory of multiple commodities (e.g., `Assets:Brokerage` can hold USD, AAPL, and MSFT simultaneously).

In TigerBeetle, the ledger field is the commodity partition. Multi-commodity = multiple accounts. The application tracks which accounts belong to which user.

</details>

---

> **Q6**: Can you delete a TigerBeetle Account? What do you do when a user closes their Midas account?

<details><summary>Answer</summary>

No. Accounts (like Transfers) are immutable and cannot be deleted.

Closing procedure:
1. Submit Transfers to drain all non-zero balances to zero (e.g., refund cash to the user's bank, liquidate positions).
2. Mark the account as "closed" in your **application database** (Postgres, etc.) — TigerBeetle has no concept of account status.
3. Optionally: TigerBeetle has a `close-account` recipe that uses the `flags.closed` account flag to reject future Transfers against that account.

The historical transfers remain queryable forever — this is the audit trail. "Closed" means "no new activity allowed," not "erased."

</details>

---

> **Q7**: `flags.linked` is set on the last Transfer in a batch. What error? Why does this matter?

<details><summary>Answer</summary>

`linked_event_chain_open`. TigerBeetle cannot process a chain without a clear terminator — it doesn't know where the atomic unit ends.

This matters because a partial chain that silently executes would be catastrophic: Transfer 1 debits Alice, Transfer 2 credits Bob, Transfer 3 was supposed to credit the fee account but was cut off. If T1 and T2 process but T3 doesn't, the fee is silently lost. TigerBeetle's error prevents this class of bug at the protocol level.

</details>

---

## Exercises

**Exercise 4-A: Schema design**

Design TigerBeetle accounts for a crypto exchange supporting USD and BTC:

| Account | Ledger | Account type | TigerBeetle flags |
|---|---|---|---|
| User's USD balance (Liability — exchange owes user) | | | |
| User's BTC balance (Liability — exchange owes user) | | | |
| Exchange's USD operating account (Asset) | | | |
| Exchange's BTC cold storage (Asset) | | | |
| Trading fee collection (Income) | | | |
| Market maker USD liquidity pool | | | |

For each: specify ledger (e.g., `USD=1`, `BTC=2`), the `code` convention (e.g., 1=asset, 2=liability, 3=income), and which balance flag to set.

<details><summary>Solution</summary>

| Account | Ledger | Code | Flag |
|---|---|---|---|
| User's USD balance (Liability) | 1 (USD) | 2 | `debits_must_not_exceed_credits` — prevents negative USD balance (user can't withdraw more than they deposited) |
| User's BTC balance (Liability) | 2 (BTC) | 2 | `debits_must_not_exceed_credits` — prevents negative BTC balance |
| Exchange's USD operating account (Asset) | 1 (USD) | 1 | `credits_must_not_exceed_debits` — asset balance should stay non-negative |
| Exchange's BTC cold storage (Asset) | 2 (BTC) | 1 | `credits_must_not_exceed_debits` |
| Trading fee collection (Income) | 1 (USD) | 3 | `debits_must_not_exceed_credits` — fees accumulate as credits |
| Market maker USD liquidity pool | 1 (USD) | 1 | `credits_must_not_exceed_debits` — must stay non-negative |

The `code` values (1=Asset, 2=Liability, 3=Income) are application-defined conventions stored in TigerBeetle. Your application reads `code` to determine how to compute the balance direction.

</details>

---

**Exercise 4-B: Balance arithmetic**

An account has:
```
debits_pending  = 200
debits_posted   = 1500
credits_pending = 0
credits_posted  = 2000
```

This is a user's USD balance account (Liability, credit-normal) with `flags.debits_must_not_exceed_credits = true`.

(a) What is the posted balance?
(b) What is the available balance (accounting for pending)?
(c) A withdrawal of $350 is requested (pending transfer of 350). Does TigerBeetle allow it?
(d) What if the flag is NOT set — does TigerBeetle allow the $350 pending transfer?

<details><summary>Solution</summary>

(a) Posted balance = `credits_posted - debits_posted = 2000 - 1500 = 500`

(b) Available balance = `posted_balance - debits_pending = 500 - 200 = 300`

(c) With `debits_must_not_exceed_credits`: TigerBeetle checks `debits_pending + new_pending + debits_posted ≤ credits_posted` → `200 + 350 + 1500 = 2050 > 2000`. **Rejected.** The pending transfer fails with `exceeds_credits`.

(d) Without the flag: TigerBeetle does not enforce the balance floor. `debits_pending` would become 550. `debits_posted` could later become 1850, resulting in a negative effective balance of `2000 - 1850 = 150`... wait, that's still positive. Let's check: after posting the 350 pending transfer, `debits_posted = 1850`, `credits_posted = 2000`, posted balance = 150. Still positive in this case. The flag matters when `debits_pending + debits_posted` would exceed `credits_posted` — which would happen here if we also tried to post the existing pending 200 first: `200 + 1500 = 1700 ≤ 2000` ✓, then `350 + 1500 = 1850 ≤ 2000` ✓. So both would actually succeed without the flag. But the combined pending check fails with the flag — the flag uses **pessimistic** accounting (reserves are counted against available balance).

</details>

---

**Exercise 4-C: The one-account-for-everything trap**

A developer creates a single TigerBeetle Account per user to hold all their assets (USD, AAPL shares, BTC), using `user_data_32` to encode the asset type in each Transfer. Every balance query scans all transfers and filters by `user_data_32`.

Name three specific ways this breaks compared to the correct design (separate accounts per asset/ledger):

<details><summary>Solution</summary>

1. **Cross-ledger mixing**: TigerBeetle's `amount` is a u128 integer. `10000` in USD means $100. `10000` in BTC means 0.0001 BTC. If both are stored in the same account on the same ledger, the amounts are added together numerically — you lose all unit information. You cannot distinguish "$100 + 0.0001 BTC = $100.01" from "200 satoshis" because the numbers have been summed into a meaningless total.

2. **No structural balance enforcement**: the `flags.debits_must_not_exceed_credits` flag applies to the entire account. You cannot enforce a USD floor without also enforcing it on BTC. You cannot have separate balance floors per asset type. All structural invariants apply to the aggregate, which is meaningless.

3. **Query performance and auditability**: to compute a user's USD balance, you must scan and filter ALL transfers for that user, not just USD transfers. This is O(all_transfers) instead of O(1) via `lookup_accounts`. At scale, this is completely impractical. Also, TigerBeetle's `query_transfers` is indexed by account — a single account accumulates all asset types, making targeted queries impossible without full scans.

</details>

---

**Source reading for this module**:
- [TigerBeetle: Data Modeling](https://docs.tigerbeetle.com/coding/data-modeling/) — full Account and Transfer model, Ledgers, Compound Transfers, Fractional Amounts, `user_data`, `code`, ID generation
- [TigerBeetle: Financial Accounting](https://docs.tigerbeetle.com/coding/financial-accounting/)
- [TigerBeetle: Close Account Recipe](https://docs.tigerbeetle.com/coding/recipes/close-account/)
- [TigerBeetle: Linked Events](https://docs.tigerbeetle.com/coding/linked-events/)

---

## ⚡ Interlude Challenge 2 (after Module 4)

> **Synthesis question**: A senior engineer proposes replacing TigerBeetle with Postgres and implementing double-entry via CHECK constraints and triggers. What can Postgres enforce that TigerBeetle cannot? What can TigerBeetle enforce that Postgres cannot? Which would you choose at 1 million transfers per second, and why?

<details><summary>Discussion</summary>

**What Postgres can enforce that TigerBeetle cannot:**
- Complex cross-account SQL constraints (e.g., total user portfolio value > X)
- Foreign key relationships to application tables
- Custom validation logic in triggers (arbitrary code)
- Multi-table atomicity without linked events

**What TigerBeetle can enforce that Postgres cannot (at OLTP scale):**
- Strict serializability at 1M+ TPS via single-core deterministic state machine — Postgres cannot match this throughput with correct serializable isolation
- Hardware-level durability with explicit I/O control (direct storage, no OS buffering, no write-behind cache)
- Built-in pending/posting two-phase transfer state machine
- Immutable append-only records by design (Postgres rows can be UPDATEd — you need extra application code to prevent mutations)
- Byzantine fault tolerance across cluster nodes

**At 1M TPS**: TigerBeetle. Postgres with `SERIALIZABLE` isolation at 1M TPS on financial records is not practically achievable without sharding, which introduces distributed transaction complexity. TigerBeetle is purpose-built for this workload. Use Postgres as the application database for user profiles, orders, etc. — and TigerBeetle as the financial ledger.

</details>
