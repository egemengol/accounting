# Consistency, Assertions, and Balance Invariants

## Concept

Two strategies for enforcing correctness — and they are not substitutes, they are complements:

- **Detective enforcement** (Beancount): check after the fact. A `balance` directive is a *spot-check* against an external ground truth (your bank statement). If it fails, something went wrong between the last check and now.
- **Preventive enforcement** (TigerBeetle flags): reject invalid state at write time, before it ever lands. No post-hoc checking needed because the invalid state cannot exist.

**Beancount's `balance` directive:**

```beancount
2024-03-01 balance Assets:Checking  1250.00 USD
```

This asserts: "at the beginning of 2024-03-01, `Assets:Checking` held exactly 1250.00 USD." If Beancount computes a different value from the transaction history, it raises an error. The directive is dated — it applies at a point in time, not at a file position. It is order-independent. You can have as many as you want; each one narrows the bisection window for finding errors.

The key property: balance assertions are *checkpoints against external reality*. They tie the ledger to the physical world (bank records, brokerage statements). Without them, your ledger can drift from reality undetected.

**Bisection process for discrepancies:**

If your balance assertion fails (or your bank statement doesn't match):
1. Find the earliest date where ledger and bank agree.
2. Find the latest date where they disagree.
3. Bisect: add a `balance` assertion at the midpoint and check if it passes.
4. Recurse into the failing half. Narrow until you isolate the divergent transaction.

The denser your balance assertions, the shorter each bisection.

**TigerBeetle's preventive model:**

TigerBeetle *never stores balances*. `debits_posted`, `credits_posted`, `debits_pending`, `credits_pending` are accumulators derived from the transfer log. A "balance" is a live derivation — read it by calling `lookup_accounts`, which reads the accumulators.

This means: you cannot set a balance. You cannot correct a balance. You can only submit new Transfers. A correction is always a new Transfer with the appropriate direction and `code = CORRECTION`, linked to the original via `user_data_128`.

**Balance-invariant transfers (the control account pattern):**

Sometimes you want balance enforcement for only a *subset* of transfers, not all of them. The recipe: use a **control account** with the opposite flag. The control account never holds funds permanently — it participates in a linked chain that enforces the invariant atomically, then unwinds:

```
T1: Source → Destination   amount=transfer  flags.linked
T2: Destination → Control  amount=1         flags.linked | pending | balancing_debit
T3: void T2                                 flags.void_pending_transfer
```

If T2's `balancing_debit` finds that `Destination.credits > Destination.debits`, the chain passes. If `Destination.debits` would exceed `credits`, T2 triggers `exceeds_debits` on the control account and the whole chain (including T1) rolls back atomically. No funds moved. No partial state.

---

## Socratic Dialogue

> **Q1**: You run a `balance` assertion in Beancount and it fails. What does that tell you? What doesn't it tell you?

<details><summary>Answer</summary>

It tells you that the computed balance of the account on that date does not match the asserted amount. **What went wrong** is not specified — it could be: a missing transaction, a duplicate posting, a wrong amount on an existing transaction, a transaction on the wrong date, or a data entry typo.

What it doesn't tell you: when the error was introduced. The assertion date only establishes "the error occurred somewhere before this date." You need bisection (more assertions at earlier dates) to isolate the cause.

</details>

---

> **Q2**: Beancount balance assertions are "date-based," not "file-order-based." Why does this matter?

<details><summary>Answer</summary>

Date-based means the assertion checks the computed balance at the start of that calendar date, regardless of where the assertion appears in the file. This makes assertions **order-independent** — you can move them around in the file without changing their semantics.

File-order assertions (Ledger's approach) check the running balance at the point in the file where the assertion appears. Moving the assertion above or below a transaction changes whether it passes or fails. This is fragile: the same set of transactions can pass or fail depending on how the file is sorted.

Date-based is harder to use for intra-day disambiguation (two transactions on the same date cannot be separated by a date-based assertion), but it's much easier to reason about correctness.

</details>

---

> **Q3**: In TigerBeetle, you discover that an account's balance is wrong. You cannot run `UPDATE accounts SET debits_posted = X`. What are your options?

<details><summary>Answer</summary>

Your only option is **new Transfers**. If debits are too high (the account shows less value than it should), submit a correcting Transfer that credits the account for the difference. If credits are too high, submit one that debits.

Convention:
1. Use `code = CORRECTION` (or whatever your enum value is for corrections)
2. Set `user_data_128` to link back to the original erroneous Transfer's order ID
3. Document the correcting Transfer in your application's audit log

The historical record is never mutated. The correction is itself an auditable event with a timestamp. Reconstructing "what happened" is always possible: sum all Transfers (including corrections) for the account.

This is identical to how real accounting works: you never alter past entries, you post adjusting entries.

</details>

---

> **Q4**: A bank statement shows $1,300. Your Beancount ledger shows $1,250. You have balance assertions at the start of each month. It's now April 5. The March 1 assertion passed. How do you find the discrepancy?

<details><summary>Answer</summary>

The discrepancy occurred between March 1 and April 5. Bisect:

1. Add a `balance` assertion at March 16. If it fails, the error is March 1–16. If it passes, the error is March 16–April 5.
2. Repeat: add an assertion at the midpoint of the failing range.
3. Continue until you isolate a single transaction or day.

At that point, compare that transaction against the bank statement to find the discrepancy (missing transaction, wrong amount, date mismatch).

This is why dense balance assertions have compounding value — not just as checkpoints, but as instruments that reduce bisection depth from O(n) to O(log n) over transaction count.

</details>

---

> **Q5**: `flags.debits_must_not_exceed_credits` is set on an account. A pending transfer is submitted that would bring `debits_pending + debits_posted` above `credits_posted`. What does TigerBeetle do?

<details><summary>Answer</summary>

TigerBeetle rejects the **pending** transfer immediately with `exceeds_credits`. It does not wait until the transfer posts.

This is the "pessimistic" model: pending amounts are counted against the available balance immediately when the pending transfer is created. The rationale is that a pending transfer is a firm commitment — TigerBeetle guarantees that when the pending transfer eventually posts, it will not violate the balance invariant. The only way to guarantee this is to reserve the funds at pending time.

Consequence: you cannot create a pending transfer "speculatively" and hope it will be within limits by the time it posts. The limit is checked upfront.

</details>

---

> **Q6**: The control account pattern for balance-invariant transfers uses a `balancing_debit` flag. What does that flag do, exactly?

<details><summary>Answer</summary>

`flags.balancing_debit` is a special modifier on a pending transfer that sets the transfer amount to the **net credit balance** of the debit account at the time of processing. In other words: instead of specifying a fixed amount, TigerBeetle computes `max(0, credits_posted - debits_posted)` on the debit account and uses that as the pending amount.

This is how the balance check works: if the destination account has a credit balance of X, the pending `balancing_debit` creates a pending debit of X on the destination and a pending credit of X on the control account. If X would cause the control account to violate `credits_must_not_exceed_debits`, the transfer — and the entire linked chain — fails.

The pending transfer is immediately voided (T3 in the recipe), so no funds actually move. The mechanism is purely an atomic balance probe.

</details>

---

> **Q7**: A developer argues: "We verify the trial balance at the end of each day via a batch job, so we don't need TigerBeetle's structural enforcement." What's wrong with this argument?

<details><summary>Answer</summary>

Several things:

1. **Window of invalidity**: between the invalid state occurring and the batch job running, the system operated on incorrect data. If a user was shown a wrong balance and acted on it (a second withdrawal, a trade), the damage is already done.

2. **At-scale detection latency**: at high throughput, a $0.01 invariant violation per 1,000 transactions is financially material within hours. A daily batch check catches it only after 24 hours of compounding.

3. **Race conditions in the batch job itself**: computing the trial balance requires reading all accounts consistently. If transfers continue posting during the batch scan, the scan is not a consistent snapshot. You need either a full lock or a snapshot isolation — both expensive.

4. **Structural enforcement is zero-cost at runtime**: TigerBeetle's flag checks happen inside the already-running state machine. There is no additional overhead compared to no flags. The "batch job" approach has cost; the flag approach is essentially free.

Detective and preventive controls are complements. The batch job is the detective fallback; the flags are the primary prevention.

</details>

---

## Exercises

**Exercise 5-A: Bisection in practice**

Your ledger has monthly balance assertions. The March 1 assertion passed ($4,200). The April 1 assertion fails — your ledger says $3,950, the bank says $4,100. March had 31 transactions.

(a) What is the maximum number of bisection steps to isolate the error, assuming you can add a balance assertion for any date?
(b) You add a March 16 assertion. The ledger computes $4,050; the bank statement shows $4,050 for that date. What does this tell you, and where do you focus next?
(c) What would make bisection impossible in a single-entry system?

<details><summary>Solution</summary>

(a) `⌈log₂(31)⌉ = 5` steps. After 5 bisections you have narrowed to a single day (or transaction) among 31.

(b) The March 16 assertion **passes** (both agree at $4,050). The error is therefore in the March 16–31 window. Focus on the second half of March: add a March 24 assertion and repeat.

(c) In a single-entry system there is no trial balance invariant and no conservation property. "Correct" has no machine-checkable definition. You could not define what a `balance` assertion *means* because there is no counterpart posting to confirm. Any amount of missing, duplicated, or modified entries could produce a plausible balance. You would need to manually compare every transaction against an external record — no bisection is possible because there is no local invariant to test.

</details>

---

**Exercise 5-B: Control account mechanics**

You have a user balance account (`Destination`) with no balance flags set. You want to enforce that after a deposit, the user's balance does not exceed $10,000 (i.e., `credits_posted - debits_posted ≤ 10,000`). You implement the balance-invariant transfer pattern.

(a) Which flag goes on the control account?
(b) The user currently has $9,800. A $500 deposit is attempted. Walk through whether T2 (the `balancing_debit` pending transfer) succeeds or fails.
(c) If T2 fails, what is the state of the Destination account after the batch?

<details><summary>Solution</summary>

(a) The control account gets `flags.credits_must_not_exceed_debits`. This is the opposite of what we're enforcing on the destination (which has credit-normal balance). The control account's debit-normal flag is what creates the tripwire.

(b) After the $500 deposit posts (T1), `Destination.credits_posted = 10,300`. The `balancing_debit` pending transfer on T2 computes the destination's net credit balance: `10,300 - debits_posted`. If debits_posted = 0, that's 10,300. T2 tries to create a pending credit of 10,300 on the control account. The control account has `credits_must_not_exceed_debits` and zero balance — 10,300 credits would immediately exceed its 0 debits. T2 **fails** with `exceeds_debits`.

(c) Because T1 and T2 are linked (`flags.linked`), T2's failure cascades: T1 is rolled back. The Destination account is unchanged — no deposit occurred. The entire batch fails atomically. The user's balance remains $9,800.

</details>

---

**Exercise 5-C: Correction without mutation**

A developer submitted a Transfer that charged a user $50 in fees instead of $5 (a 10x error). The transfer has already posted. The user's account shows the wrong balance.

(a) Write out the sequence of TigerBeetle Transfers needed to correct this. Include `code`, `user_data_128`, and direction for each.
(b) After the correction, what does a `query_transfers` for this user's account show? How does an auditor reconstruct the correct final balance?
(c) Why is this approach superior to a direct balance mutation, from a regulatory standpoint?

<details><summary>Solution</summary>

(a) Two Transfers:
```
T_reversal:
  debit_account_id:  fee_collection_account
  credit_account_id: user_account
  amount:            50_00  (the original wrong amount)
  code:              CORRECTION_REVERSAL (e.g., 1000)
  user_data_128:     original_order_id

T_correct:
  debit_account_id:  user_account
  credit_account_id: fee_collection_account
  amount:            5_00   (the correct amount)
  code:              FEE (e.g., 7)
  user_data_128:     original_order_id
```

These can be submitted as a linked pair to ensure they both apply or neither does.

(b) `query_transfers` shows three entries: the original wrong fee (+$50 debit), the reversal (-$50 correction credit), and the correct fee (+$5 debit). Net effect on the user account: -$5. An auditor reconstructs the final balance by summing all Transfer amounts — the three entries net to -$5, which is the correct fee. The $50 error is visible in history, as is its correction, with timestamps and `user_data_128` linking all three to the original order.

(c) Regulatory reporting requires an **immutable audit trail**. If you directly mutate the balance, the error disappears. Regulators (and auditors) cannot see that an error occurred, when it was detected, or how it was resolved. The correction-as-Transfer approach preserves all of this: the error, the correction, the operator who submitted it, and the timestamp — all are permanent record. In regulated industries (banking, brokerage), this is not optional.

</details>

---

**Source reading for this module**:
- [Beancount: Balance Assertions](https://beancount.github.io/docs/balance_assertions_in_beancount.html) — full document (Motivation, Partial vs. Complete, Date vs. File assertions)
- [Beancount: Design Doc](https://beancount.github.io/docs/beancount_design_doc.html) — "All Transactions Must Balance" (Invariants section)
- [TigerBeetle: Safety](https://docs.tigerbeetle.com/concepts/safety/)
- [TigerBeetle: Balance-Invariant Transfers Recipe](https://docs.tigerbeetle.com/coding/recipes/balance-invariant-transfers/)
- [TigerBeetle: Balance Bounds Recipe](https://docs.tigerbeetle.com/coding/recipes/balance-bounds/)
