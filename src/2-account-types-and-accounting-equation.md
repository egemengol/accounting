# Account Types and the Accounting Equation

## Concept

The five account types are a **semantic type system**, not arbitrary taxonomy. They answer three questions about any account:

1. **Sign convention**: does a positive balance mean you have something (+) or owe something (-)?
2. **Report membership**: does this account belong on the balance sheet (point-in-time snapshot) or income statement (period flow)?
3. **Normal balance direction**: is the account increased by a debit or a credit?

| Type | Normal sign | Report | Increased by |
|---|---|---|---|
| Assets | + | Balance sheet | Debit |
| Liabilities | − | Balance sheet | Credit |
| Equity | − | Balance sheet | Credit |
| Expenses | + | Income statement | Debit |
| Income | − | Income statement | Credit |

The accounting equation follows *directly* from `sum(all_postings) = 0`:

```
A + L + E + X + I = 0
```

Where A = Assets, L = Liabilities, E = Equity, X = Expenses, I = Income — all as signed sums. This is not a separate axiom; it is a consequence of the double-entry invariant.

After clearing Income and Expenses into Equity (end-of-period):
```
A + L + E' = 0
→ Assets = Liabilities + Equity  (the familiar form, after sign flip)
```

**TigerBeetle connection**: TigerBeetle has no `account_type` field. The application encodes account semantics. The structural enforcement available:
- `flags.debits_must_not_exceed_credits` — use on liability/equity/income accounts (credit-normal: credit balance must stay non-negative)
- `flags.credits_must_not_exceed_debits` — use on asset/expense accounts (debit-normal: debit balance must stay non-negative)

**The custodial wallet model** (critical for fintech): when a user deposits money into your platform, you need *two* accounts:
- Operator's bank account (Asset) — you hold the cash
- User's balance account (Liability) — you owe it back to the user

The deposit increases both simultaneously. This is the structural reason fintech companies cannot just track "user balances" in a single table.

---

## Socratic Dialogue

> **Q1**: You owe a friend $200. Is "what you owe" a liability or an asset? What about from your friend's perspective?

<details><summary>Answer</summary>

From **your** perspective: Liability. It has a negative normal balance — it represents something you owe, not something you own.

From your **friend's** perspective: Asset. They have a claim on $200, which is something of value they possess.

Same real-world debt, opposite account types, depending on whose books you're keeping. This is a fundamental point: accounting is always from the perspective of one entity. There is no "objective" account type — it depends on who is recording.

</details>

---

> **Q2**: Your credit card statement shows a $500 balance. Is that positive or negative in your Beancount books?

<details><summary>Answer</summary>

**Negative** in your books (`Liabilities:CreditCard: -500 USD`). You owe $500. The statement shows a positive number because the bank reports from *their* perspective — to them, it is an asset (money you owe them).

Beancount uses the owner's perspective consistently throughout. Liabilities, Equity, and Income accounts normally have negative balances.

</details>

---

> **Q3**: Why does Beancount's accounting equation read `A + L + E + X + I = 0` rather than `Assets = Liabilities + Equity`?

<details><summary>Answer</summary>

They are equivalent after sign adjustment. The traditional form `Assets = Liabilities + Equity` uses the convention that all balances are shown as positive numbers, with debit/credit rules applied separately per account type.

Beancount uses signed arithmetic throughout: Liabilities and Equity have negative normal balances. So `A + L + E = 0` (after clearing) becomes `A = -L + (-E)` — and since L and E are negative when the company is solvent, `-L` and `-E` are positive numbers, yielding `A = |L| + |E|`, which is the traditional form.

Beancount's form is algebraically simpler: you never need to remember which accounts get their signs flipped.

</details>

---

> **Q4**: What would happen to the accounting equation if you never cleared Income and Expenses into Equity?

<details><summary>Answer</summary>

The equation `A + L + E + X + I = 0` still holds — it is always true by construction. But the balance sheet wouldn't "balance" in the traditional sense because it would only show `A + L + E`, which sums to `NI = -(X + I)` rather than zero.

Clearing (closing entries) moves the Income and Expense balances into Equity, making `X + I = 0` and leaving only `A + L + E = 0` — the clean balance sheet form. Without clearing, you'd need to show the Income Statement accounts on the balance sheet to make it balance, which is non-standard and confusing.

</details>

---

> **Q5**: In TigerBeetle, an account has no `type` field. How does the application know if an account is an Asset or a Liability?

<details><summary>Answer</summary>

Convention, enforced by the application. TigerBeetle gives you `debits_posted` and `credits_posted`. Your application computes:

- **Asset**: `balance = debits_posted - credits_posted`
- **Liability**: `balance = credits_posted - debits_posted`

The semantic type lives in your application's metadata (your `code` field convention, your `user_data` fields, your external database). TigerBeetle enforces the *structural* invariant (balance floors via flags); your application enforces the *semantic* invariant (what the account represents).

</details>

---

> **Q6**: A fintech company has a "float account" — money received from users that hasn't been deployed yet. Is it an Asset, Liability, or Equity?

<details><summary>Answer</summary>

**Both** — and this is the answer that separates engineers who understand accounting from those who don't.

From the operator's perspective:
- The cash in the bank: **Asset** (you hold it)
- The obligation to return it to users: **Liability** (you owe it)

A well-modeled system has both: the operator bank account (Asset) and a per-user liability (the user's balance). When a user deposits $100:
- `Assets:Bank` +100 (you have $100 more)
- `Liabilities:UserBalance:Alice` -100 (you owe Alice $100 more)

The sum is zero. This is the **custodial wallet model** and it is the foundational structure of every fintech platform that holds user funds.

</details>

---

> **Q7**: `Income:Salary` normally has a negative balance. If you earn $3,000, should it show `-3000` or `+3000`?

<details><summary>Answer</summary>

**`-3000`** in Beancount's signed convention.

Why: Income represents something you gave away (your time, your work) in exchange for Assets. The $3,000 you received is `Assets:Checking +3000`. The work you gave away (which the company bought) is `Income:Salary -3000`. Sum: 0.

The negative sign is correct. "I gave away $3,000 of work." The asset received is positive; the income source is negative. This is consistent with the owner's-perspective convention: Income is the reason you have more assets, not an asset itself.

</details>

---

## Exercises

**Exercise 2-A: Classify the accounts**

For a company like Midas (fintech brokerage), classify each from the **operator's perspective**:

| Account | Type (A/L/E/X/I) | Normal balance | Increased by |
|---|---|---|---|
| Cash in Midas's bank account | | | |
| User's stock holdings (custodial) | | | |
| Revenue from trading fees | | | |
| AWS infrastructure costs | | | |
| Pending user withdrawal requests | | | |
| Regulatory fine (pending, not yet paid) | | | |

<details><summary>Solution</summary>

| Account | Type | Normal balance | Increased by |
|---|---|---|---|
| Cash in Midas's bank account | **Asset** | + | Debit |
| User's stock holdings (custodial) | **Asset** | + | Debit (Midas holds shares as custodian) |
| Revenue from trading fees | **Income** | − | Credit |
| AWS infrastructure costs | **Expense** | + | Debit |
| Pending user withdrawal requests | **Liability** | − | Credit (Midas owes users these funds) |
| Regulatory fine (pending, not yet paid) | **Liability** | − | Credit (Midas owes the regulator) |

Note on user stock holdings: from Midas's books, the shares held in custody are an Asset (they represent value Midas controls) with a corresponding Liability (the obligation to return them to users). Both sides exist simultaneously.

</details>

---

**Exercise 2-B: The custodial wallet**

A user deposits $100 into their Midas account via ACH.

(a) Write the complete Beancount entry. You need: `Assets:Bank`, `Liabilities:Users:Alice`.
(b) Verify the postings sum to zero.
(c) Alice then buys $100 of AAPL. Show the Beancount entries. What happens to the liability?
(d) Why does the liability not disappear when Alice buys stock — she still has $100 of value with Midas?

<details><summary>Solution</summary>

(a) Deposit:
```beancount
2024-03-01 * "Alice ACH deposit"
  Assets:Bank                    100.00 USD
  Liabilities:Users:Alice       -100.00 USD
```
Sum: +100 + (-100) = 0 ✓

(c) AAPL purchase ($100 at $175/share ≈ 0.571 shares — let's say exactly 1 share at $100 for simplicity):
```beancount
2024-03-02 * "Alice buys AAPL"
  Assets:Custody:AAPL               1 AAPL {100.00 USD}
  Assets:Bank                  -100.00 USD
```
The `Liabilities:Users:Alice` account doesn't directly change here — that's a separate modeling choice. One approach: the liability is now denominated in AAPL rather than USD (the user "owns" 1 AAPL held in custody).

(d) The liability transforms in nature but doesn't disappear. Before: Midas owes Alice $100 cash. After: Midas owes Alice 1 AAPL. The obligation still exists. A more complete model would have `Liabilities:Users:Alice:USD` and `Liabilities:Users:Alice:AAPL` as separate accounts, the former decreasing and the latter increasing during the trade. The total liability in market-value terms remains $100 (ignoring price movement).

</details>

---

**Exercise 2-C: TigerBeetle flag enforcement**

A user's balance account is a Liability (credit-normal) with `flags.debits_must_not_exceed_credits = true`. Current state: `credits_posted = 1000`, `debits_posted = 0`.

(a) The user tries to withdraw $1,200 (a transfer that would debit the account by 1,200). What does TigerBeetle return?
(b) The user deposits $500 (credit of 500). What is the available balance now?
(c) What happens if you set both `debits_must_not_exceed_credits` AND `credits_must_not_exceed_debits` on the same account?

<details><summary>Solution</summary>

(a) TigerBeetle returns `exceeds_credits` (debit_would_exceed_credits error). The transfer is rejected. `debits_posted + 1200 = 1200 > credits_posted = 1000` violates the flag.

(b) After deposit: `credits_posted = 1500`, `debits_posted = 0`. Balance = `credits_posted - debits_posted = 1500`. Available balance = 1500 (no pending amounts).

(c) This creates an account that can never have any transfers posted to it. `debits_must_not_exceed_credits` means debits ≤ credits. `credits_must_not_exceed_debits` means credits ≤ debits. The only state satisfying both simultaneously is `debits_posted = credits_posted` — a permanently zero-balance account where any non-zero transfer in either direction would violate one of the constraints. TigerBeetle will return an error when you try to create such an account.

</details>

---

**Source reading for this module**:
- [Beancount: The Double-Entry Counting Method](https://beancount.github.io/docs/the_double_entry_counting_method.html) — "Types of Accounts", "Accounting Equations", "Credits & Debits", "Income Statement", "Balance Sheet"
- [TigerBeetle: Data Modeling](https://docs.tigerbeetle.com/coding/data-modeling/) — "Debits vs Credits", "Debit Balances", "Credit Balances"
- [TigerBeetle: Financial Accounting](https://docs.tigerbeetle.com/coding/financial-accounting/) — "Types of Accounts", "How Debits and Credits Increase or Decrease Account Balances", "Account Types and the Normal Balance"

---

## ⚡ Interlude Challenge 1 (after Module 2)

> **Synthesis question**: Your company processes $1B/day in transfers. The CFO asks for a real-time balance sheet. Your TigerBeetle cluster has strict serializability. Describe the query you'd run and its latency characteristics. What's the bottleneck? Would you use TigerBeetle directly for this or build a read model?

<details><summary>Discussion</summary>

**The query**: `lookup_accounts` or `query_accounts` on all balance-sheet accounts (Assets, Liabilities, Equity). For each, compute `credits_posted - debits_posted` or `debits_posted - credits_posted` based on account type.

**Latency**: TigerBeetle is optimized for write throughput (OLTP), not ad-hoc analytical reads (OLAP). Reading thousands of accounts with a single query is fine; computing a consolidated balance sheet across millions of accounts with aggregation is not what TigerBeetle is designed for.

**The bottleneck**: At $1B/day and average transaction size of $100, that's 10M transfers/day, ~115/second. TigerBeetle can handle this. The bottleneck for the balance sheet is aggregation across accounts — you'd want a read model (Postgres materialized view, or a CDC consumer that maintains running balances in a read database).

**Real pattern**: TigerBeetle is the system of record. A Change Data Capture (CDC) consumer reads from TigerBeetle's transfer log (`/operating/cdc/`) and maintains a separate OLAP database (e.g., ClickHouse, BigQuery) for reporting. The balance sheet runs against the OLAP store, not TigerBeetle directly.

</details>
