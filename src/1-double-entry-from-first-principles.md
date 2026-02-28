# Double-Entry From First Principles

## Concept

Everything in this module follows from one rule:

> **The sum of all postings in a transaction must equal zero.**

Definitions:
- **Account**: an accumulator. Starts at zero. Has a running balance = sum of all postings applied to it.
- **Posting**: a `(account, signed_amount)` pair. A directed change to one account.
- **Transaction**: a group of postings whose amounts sum to zero. The atomic unit of accounting work.
- **Balance**: `sum(all_postings_to_account)` — always derived, never stored independently.
- **Trial balance**: `sum(balances_of_all_accounts)` — always zero, by construction.

Beancount syntax:
```beancount
2024-01-15 * "Alice sends Bob $100"
  Assets:Alice:Checking   -100.00 USD
  Assets:Bob:Checking      100.00 USD
```
Sum: -100 + 100 = 0. Invariant holds.

TigerBeetle equivalent:
```
Transfer {
  debit_account_id:  alice_account,   // Alice's balance decreases
  credit_account_id: bob_account,     // Bob's balance increases
  amount:            10000,           // $100.00 at scale 2 (cents)
  ledger:            1,               // USD ledger
}
```

These are **dual representations of the same invariant**. Beancount uses signed amounts on a flat list of postings. TigerBeetle uses a directed `(debit_account, credit_account, positive_amount)` triple. Both enforce `sum = 0` — one structurally via the Transfer struct, one by validation at parse time.

Key distinction: the `-100` in Beancount is a **posting** (a delta), not Alice's balance. If Alice started at $500, her balance is now $400.

---

## Socratic Dialogue

> **Q1**: The Beancount posting shows `-100 USD` on Alice's account. Is Alice's balance negative?

<details><summary>Answer</summary>

Not necessarily. The `-100` is the *posting* — the change applied to the account. If Alice's running balance before this transaction was `+500`, it is now `+400`. Postings are deltas; balance is the running sum of all deltas. Never confuse a posting amount with an account balance.

</details>

---

> **Q2**: A transaction has postings that sum to $0.01 due to floating-point rounding. Is this valid?

<details><summary>Answer</summary>

No. Beancount enforces balance within a configurable tolerance (default: very small), but an imbalance of $0.01 on a $1,000 transaction is not rounding error — it is a bug. Over billions of transactions, even $0.01 imbalances compound catastrophically.

This is why TigerBeetle uses `u128` (unsigned 128-bit integer) for amounts — integer arithmetic is exact. The application chooses a scale factor (e.g., scale 2 = cents). There are no floating-point amounts anywhere in TigerBeetle's data model.

</details>

---

> **Q3**: Can a transaction have only one posting?

<details><summary>Answer</summary>

In standard double-entry: no, because you cannot satisfy `sum = 0` with a single non-zero posting. One posting of `+100` sums to `+100 ≠ 0`.

In TigerBeetle: structurally impossible — a Transfer always has exactly one `debit_account_id` and one `credit_account_id`. You cannot submit a transfer with only one account.

In Beancount: you can have a zero-amount posting (trivially balances), but a single non-zero posting will fail validation.

</details>

---

> **Q4**: Beancount allows you to omit the amount on one posting. How can that work without violating the invariant?

<details><summary>Answer</summary>

It is syntactic sugar. Beancount *infers* the missing amount as whatever value makes the sum zero. This is not a relaxation of the rule — it is a *derivation* from it. If two postings sum to +75, the inferred third posting is -75.

```beancount
2024-01-15 * "Dinner"
  Liabilities:CreditCard   -47.23 USD
  Expenses:Restaurants              ; amount inferred as +47.23 USD
```

This is just convenience. The invariant still holds after inference.

</details>

---

> **Q5**: If every transaction sums to zero, and all accounts start at zero, what is `sum(all_account_balances)` at any point in time?

<details><summary>Answer</summary>

Always **zero**. This is the trial balance invariant — a corollary of `sum(postings_per_transaction) = 0` applied over all transactions ever.

Proof: each transaction contributes net zero to the total sum. Start at zero. Add transactions. The total never changes. `sum(all_balances) = 0` always.

This is a powerful checksum. If you ever compute the trial balance and get non-zero, something is wrong: a posting was added without its counterpart, a record was mutated, or the data is corrupt.

</details>

---

> **Q6**: TigerBeetle only supports one debit and one credit per Transfer. How do you record a paycheck that credits your checking account, with federal tax and social security split to two accounts?

<details><summary>Answer</summary>

You decompose it into multiple linked Transfers. A 4-posting Beancount transaction maps to (at minimum) 2 TigerBeetle Transfers with `flags.linked = true`. The `flags.linked` flag makes a batch of transfers atomic — they all succeed or all fail together.

This is Module 3's subject. The answer is not "you can't" — it is "you decompose and link."

</details>

---

> **Q7**: What is the difference between a posting and a transaction?

<details><summary>Answer</summary>

A **posting** is a single `(account, amount)` pair — one side of a movement. It cannot exist on its own; it is always a child of a transaction.

A **transaction** is the atomic container that groups postings and enforces the zero-sum rule. A transaction has a date, description, and one or more postings. It is the unit of audit.

In TigerBeetle: a `Transfer` is a single atomic two-sided posting (debit + credit). There is no separate "transaction" type — multi-leg transactions are composed from linked Transfers.

</details>

---

## Exercises

**Exercise 1-A: Manual balance computation**

Given these three Beancount transactions:
```beancount
2024-01-01 * "Opening deposit"
  Equity:Opening        -1000.00 USD
  Assets:Checking        1000.00 USD

2024-01-05 * "Coffee"
  Assets:Checking           -5.00 USD
  Expenses:Food              5.00 USD

2024-01-10 * "Paycheck"
  Income:Salary          -3000.00 USD
  Assets:Checking         3000.00 USD
```

(a) Compute the balance of every account after all three transactions.
(b) Verify the trial balance: do all balances sum to zero?
(c) Change the paycheck to credit Checking by $3001. Show that the trial balance detects the imbalance.

<details><summary>Solution</summary>

(a)
- `Equity:Opening`: -1000
- `Assets:Checking`: +1000 - 5 + 3000 = **+3995**
- `Expenses:Food`: **+5**
- `Income:Salary`: **-3000**

(b) Sum: -1000 + 3995 + 5 + (-3000) = **0** ✓

(c) If `Assets:Checking` is credited $3001 instead of $3000:
- `Assets:Checking`: +1000 - 5 + 3001 = +3996
- `Income:Salary`: -3000
- Sum: -1000 + 3996 + 5 + (-3000) = **+1** ≠ 0

Beancount would reject this transaction with a balance error: the paycheck transaction itself has postings `-3000 + 3001 = +1 ≠ 0`. The error is caught at the transaction level before it even touches the trial balance.

</details>

---

**Exercise 1-B: TigerBeetle transfer anatomy**

The following Transfer is submitted:
```
Transfer {
  id:                0xABC123,
  debit_account_id:  0x01,   // Alice
  credit_account_id: 0x02,   // Bob
  amount:            10000,  // $100.00 at scale 2
  ledger:            1,
  code:              200,
}
```

(a) After this transfer posts, what is Alice's `debits_posted`? Bob's `credits_posted`?
(b) Alice is an Asset account (debit-normal). How do you compute her balance from `debits_posted` and `credits_posted`?
(c) What does TigerBeetle return if you set `debit_account_id == credit_account_id`? Why is this wrong conceptually, not just technically?

<details><summary>Solution</summary>

(a) Alice's `debits_posted` increases by 10000. Bob's `credits_posted` increases by 10000.

(b) For a debit-normal (Asset) account: `balance = debits_posted - credits_posted`. Alice's balance decreases when she's the debit account in a transfer — that's the correct direction for an asset outflow.

(c) TigerBeetle returns an error. Conceptually: a transfer from an account to itself creates a debit and credit on the same account that cancel out — net zero effect, no value moves anywhere. It is not a valid accounting entry; it is noise. More dangerous: if you believe you've moved funds but nothing actually changed, you have a silent bug in your logic.

</details>

---

**Exercise 1-C: The phantom balance bug**

A developer introduces a new operation: an "adjustment posting" that directly increments an account's balance without a corresponding counterpart posting anywhere. Describe:

(a) Which invariant this violates and why.
(b) A concrete fintech example of the financial bug this creates.
(c) How TigerBeetle's data model makes this class of bug structurally impossible.

<details><summary>Solution</summary>

(a) It violates `sum(all_postings) = 0`. A single non-zero posting with no counterpart contributes a non-zero amount to the trial balance, breaking the conservation invariant. Value is created from nothing.

(b) A user's balance account is adjusted +$50 with no corresponding debit to any source account. The user has $50 they didn't earn. The operator's books show $50 missing with no source. At scale, this is how accounting fraud works — unauthorized credit to a target account with no counterpart.

(c) TigerBeetle's `Transfer` struct requires both `debit_account_id` and `credit_account_id` to be different, valid, same-ledger accounts. There is no API to directly set an account's balance. Every balance change is a Transfer, which is always two-sided. You literally cannot submit a one-sided adjustment.

</details>

---

**Source reading for this module**:
- [Beancount: The Double-Entry Counting Method](https://beancount.github.io/docs/the_double_entry_counting_method.html) — "Basics of Double-Entry Bookkeeping" through "Trial Balance"
- [TigerBeetle: Data Modeling](https://docs.tigerbeetle.com/coding/data-modeling/) — Accounts, Transfers, Ledgers, Debits vs Credits
- [TigerBeetle: Financial Accounting](https://docs.tigerbeetle.com/coding/financial-accounting/) — "Building Intuition", "Double-Entry Bookkeeping"
