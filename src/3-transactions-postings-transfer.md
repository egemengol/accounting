# Transactions, Postings, and the Transfer Primitive

## Concept

A transaction carries: **date**, **description** (payee + narration), and **N postings** (N ≥ 2, sum = 0).

In Beancount, a transaction can have N postings. In TigerBeetle, a Transfer has exactly 1 debit account and 1 credit account. **Multi-leg transactions are composed from linked Transfers.**

**TigerBeetle Transfer fields you need to know:**

| Field | Type | Purpose |
|---|---|---|
| `id` | u128 | Idempotency key. **Client generates before submission.** Never reuse. |
| `debit_account_id` | u128 | Account to debit |
| `credit_account_id` | u128 | Account to credit |
| `amount` | u128 | Unsigned integer, application-defined scale |
| `ledger` | u32 | Currency/asset partition. Both accounts must be on same ledger. |
| `code` | u16 | Semantic event type (your enum: DEPOSIT=1, WITHDRAWAL=2, etc.) |
| `user_data_128` | u128 | FK to your application DB (order ID, customer ID, etc.) |
| `user_data_64` | u64 | Second timestamp or secondary reference |
| `user_data_32` | u32 | Jurisdiction, locale, or other small reference |
| `flags` | u16 | `linked`, `pending`, `post_pending_transfer`, `void_pending_transfer`, etc. |
| `timeout` | u32 | For pending transfers: seconds until auto-expiry |

**The `id` field is critical**: generate it on the client *before* any network call, persist it, and retry with the same `id`. TigerBeetle returns `ok` (newly created) or `exists` (already created — idempotent, treat as success). This is Module 9's subject but the pattern starts here.

**The `code` field** is your application's semantic event type. Define an enum:
```
DEPOSIT           = 1
WITHDRAWAL        = 2
TRADE_BUY         = 3
TRADE_SELL        = 4
DIVIDEND          = 5
FEE               = 6
CORRECTION        = 100
```

**The `user_data_128` field** links TigerBeetle records to your application database. Without it, reconciliation requires a full join across two systems.

**Multi-leg transactions via `flags.linked`**: set `flags.linked = true` on all but the last Transfer in a batch. TigerBeetle processes them atomically — all succeed or all fail. The last Transfer in the chain has `flags.linked = false`.

---

## Socratic Dialogue

> **Q1**: A 4-posting Beancount transaction (e.g., paycheck with taxes) maps to how many TigerBeetle Transfers? What flag connects them?

<details><summary>Answer</summary>

Two Transfers, linked with `flags.linked = true` on the first, `false` on the second. Each Transfer is two-sided (one debit, one credit), so two Transfers cover four accounts. The `flags.linked` flag makes the pair atomic.

A 6-posting transaction would need 3 Transfers. The general rule: an N-posting balanced transaction decomposes into N/2 linked Transfers (assuming each posting is paired with exactly one other — more complex structures may need additional accounting accounts).

</details>

---

> **Q2**: What is the `code` field in a TigerBeetle Transfer? What happens if you don't use it consistently?

<details><summary>Answer</summary>

`code` is a `u16` (0–65535) that the application defines as a semantic event type. It is the machine-readable equivalent of a Beancount narration.

Without a consistent enum: you can query transfers by account but cannot filter by event type. "Show me all withdrawals" requires a full scan and application-side filtering rather than a `query_transfers` with `code = 2`. You lose queryability. Worse: corrections and reversals become indistinguishable from original operations in audit logs.

Define the enum early, document it, never reuse codes for different semantics.

</details>

---

> **Q3**: A Transfer is immutable in TigerBeetle. You submitted one with the wrong amount. What do you do?

<details><summary>Answer</summary>

Submit a new correcting Transfer in the *opposite direction* for the difference (or a full reversal, then a correct Transfer). Link both to the original via `user_data_128 = original_order_id`. Use a distinct `code` value (e.g., `CORRECTION = 100`).

This is the **append-only audit log** property. The history is never modified; every correction is itself a dated, auditable event. You can always reconstruct "what was the net effect?" by summing all transfers with the same `user_data_128`.

</details>

---

> **Q4**: Why is `user_data_128` indexed in TigerBeetle? Couldn't you just look up the order in your application database?

<details><summary>Answer</summary>

Because reconciliation then requires a join across two systems with different consistency guarantees. If TigerBeetle has `transfer_id → order_id` queryable, you can audit entirely within TigerBeetle: "find all transfers related to order 999" without touching Postgres.

More importantly: TigerBeetle's consistency is stronger than Postgres's for financial records. If TigerBeetle says a transfer happened, it happened — even if your Postgres replica is lagged or your application DB was restored from backup. The `user_data_128` link lets you bridge the two systems with TigerBeetle as the authoritative record.

</details>

---

> **Q5**: What is the recommended ID generation strategy for TigerBeetle Transfers? Why not auto-increment or UUID v4?

<details><summary>Answer</summary>

TigerBeetle recommends a **ULID-style** 128-bit ID:
- High 48 bits: millisecond timestamp
- Low 80 bits: random

Benefits:
- No central oracle needed (unlike auto-increment)
- Lexicographically sortable by time (unlike UUID v4), which **optimizes LSM tree performance** — sorted inserts are faster than random
- No collision risk (2^80 random bits per millisecond)
- Client generates it, enabling the idempotency pattern

Random UUIDs (v4) are explicitly *not* recommended because they produce random write patterns in the LSM tree, significantly reducing throughput.

</details>

---

> **Q6**: `flags.linked` is set on the last Transfer in a batch. What error does TigerBeetle return?

<details><summary>Answer</summary>

`linked_event_chain_open` — the chain has no terminator. TigerBeetle cannot determine where the atomic unit ends. This is semantically important: an open chain could be intentionally partial (a bug) or accidentally truncated (a network issue). TigerBeetle refuses to process an ambiguous chain rather than making a potentially incorrect assumption.

Rule: the last Transfer in a linked chain must have `flags.linked = false`. All others have `flags.linked = true`.

</details>

---

## Exercises

**Exercise 3-A: Decompose a multi-leg transaction**

This Beancount transaction represents a paycheck:
```beancount
2024-03-15 * "Employer" "March salary"
  Income:Salary              -5000.00 USD
  Assets:Checking             3800.00 USD
  Expenses:Taxes:Federal       900.00 USD
  Expenses:Taxes:Social        300.00 USD
```

(a) How many TigerBeetle Transfers are needed? Draw the debit/credit structure of each.
(b) Write out the `flags.linked` values for each Transfer.
(c) Transfer 2 fails (e.g., the federal tax account doesn't exist). What happens to Transfer 1? What does TigerBeetle return for the batch?

<details><summary>Solution</summary>

(a) Two Transfers:
```
T1: debit=Income:Salary, credit=Assets:Checking, amount=3800_00
T2: debit=Income:Salary, credit=Expenses:Taxes:Federal, amount=900_00
```
Wait — but this leaves `Expenses:Taxes:Social` unaccounted. We need three Transfers for four postings (the salary account appears three times as debit):
```
T1: debit=Employer:Payable, credit=Assets:Checking,          amount=3800_00  (flags.linked=true)
T2: debit=Employer:Payable, credit=Expenses:Taxes:Federal,   amount=900_00   (flags.linked=true)
T3: debit=Employer:Payable, credit=Expenses:Taxes:Social,    amount=300_00   (flags.linked=false)
```
Total debits from Employer: 5000. Total credits: 3800+900+300 = 5000. ✓

In practice, `Income:Salary` is a TigerBeetle account on the employer's side, acting as the source.

(b) T1: `flags.linked=true`, T2: `flags.linked=true`, T3: `flags.linked=false`

(c) If T2 fails: **all three Transfers fail**. The `flags.linked` chain is atomic. T1 is reversed, T3 never executes. The batch result contains individual error codes per Transfer — T2 shows the specific error, T1 and T3 show `linked_event_failed`. Alice's checking account and all tax accounts are unchanged.

</details>

---

**Exercise 3-B: Design a `code` enum**

You are building the TigerBeetle `code` enum for a brokerage. Define numeric values for: deposits, withdrawals, equity buy executions, equity sell executions, dividend credits, margin interest charges, wire transfer fees, and correcting entries.

Considerations:
(a) What range would you reserve for correcting entries, and why?
(b) What would a query look like to find all correcting entries in the last 24 hours?

<details><summary>Solution</summary>

```
// Business operations: 1-99
DEPOSIT              = 1
WITHDRAWAL           = 2
EQUITY_BUY           = 3
EQUITY_SELL          = 4
DIVIDEND             = 5
MARGIN_INTEREST      = 6
WIRE_FEE             = 7

// Corrections: 1000-1999 (separate range, easy to filter)
CORRECTION_REVERSAL  = 1000
CORRECTION_PARTIAL   = 1001
CORRECTION_WRITE_OFF = 1002
```

(a) A separate range (e.g., 1000+) makes corrections queryable and distinguishable from normal operations at a glance. If you use code=1 for both deposits and deposit corrections, you cannot distinguish them in TigerBeetle queries without also checking `user_data`. A dedicated range makes compliance reports trivial: "find all correcting entries" = `query_transfers(code=1000..1999)`.

(b) `query_transfers` with `code` filter and `timestamp` range. TigerBeetle's `query_transfers` supports filtering by `code`, `user_data_128`, `user_data_64`, `user_data_32`, and account ID. The query would be something like: `query_transfers({ account_id: ..., code: 1000 })` with pagination over the timestamp range.

</details>

---

**Exercise 3-C: The ID timing trap**

A developer writes this payment submission code:
```python
def submit_payment(from_account, to_account, amount):
    response = api.create_transfer(
        debit_account_id=from_account,
        credit_account_id=to_account,
        amount=amount,
        id=generate_ulid()  # ID generated inside the API call
    )
    return response
```

The network times out. The developer retries by calling `submit_payment` again.

(a) What is the bug?
(b) What is the financial risk?
(c) Rewrite the function correctly.

<details><summary>Solution</summary>

(a) A new ULID is generated on each call. The retry creates a *second* Transfer with a different `id`. TigerBeetle has no way to know these are the same logical operation — it sees two distinct Transfers and creates both.

(b) The user is double-charged. Both transfers post to the accounts. The first transfer may or may not have succeeded (we don't know — the network timed out). If it did succeed, the retry creates a duplicate.

(c) Correct implementation:
```python
def submit_payment(from_account, to_account, amount, idempotency_key=None):
    # Generate and persist BEFORE any network call
    if idempotency_key is None:
        idempotency_key = generate_ulid()

    store.save('pending_transfer_id', idempotency_key)  # durable storage

    response = api.create_transfer(
        id=idempotency_key,
        debit_account_id=from_account,
        credit_account_id=to_account,
        amount=amount,
    )

    if response.result in ('ok', 'exists'):
        store.delete('pending_transfer_id')
        return 'success'
    else:
        # balance error, invalid account, etc. — don't retry
        store.delete('pending_transfer_id')
        return 'error', response.result
```

On retry: pass the same `idempotency_key`. TigerBeetle returns `exists`. Treat it as success.

</details>

---

**Source reading for this module**:
- [Beancount: The Double-Entry Counting Method](https://beancount.github.io/docs/the_double_entry_counting_method.html) — "Multiple Postings", "The Table Perspective"
- [Beancount: Design Doc](https://beancount.github.io/docs/beancount_design_doc.html) — "Transactions", "Postings", "Balancing Postings"
- [Beancount: Language Syntax](https://beancount.github.io/docs/beancount_language_syntax.html) — "Transactions" directive, "Amount Interpolation"
- [TigerBeetle: Data Modeling](https://docs.tigerbeetle.com/coding/data-modeling/) — full Transfer struct, `user_data` fields, `code`, ID generation
- [TigerBeetle: Reliable Transaction Submission](https://docs.tigerbeetle.com/coding/reliable-transaction-submission/)
