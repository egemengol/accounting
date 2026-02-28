# Why Accounting Exists

## Concept

Accounting is not record-keeping. It is a **constraint system**.

The central invariant: in a closed system, money is conserved. You cannot create it or destroy it — you can only move it between accounts. Double-entry bookkeeping is the mechanism that enforces this conservation as a machine-checkable property.

The engineer's framing: a ledger is a log of state transitions over a state machine where **`sum(all_postings_ever) = 0`** at all times. Any system that violates this invariant has either produced value from nothing or destroyed it. Both are bugs.

Two systems, same invariant:
- **Beancount**: enforces `sum(postings) = 0` at parse time, in software
- **TigerBeetle**: enforces the same invariant at the database level, at hardware speed, with strict serializability

Neither system has a concept of "balance" as stored state. Balance is always *derived* from the transaction history.

---

## Socratic Dialogue

> **Q1**: You have a Postgres table: `transfers(id UUID, sender_id UUID, recipient_id UUID, amount_cents BIGINT)`. User balance = `SELECT SUM(amount_cents) FROM transfers WHERE recipient_id = ?` minus outflows. What's structurally wrong with this model for a payments company?

<details><summary>Answer</summary>

Single-entry bookkeeping. Each transfer row records a *flow*, but nothing enforces that what leaves one account arrives somewhere else. If a row is deleted, duplicated, or the `sender_id` is wrong, you cannot detect it — no conservation property is enforced. A credit that never debits anywhere is undetectable at the schema level.

Also: no audit trail for corrections (mutations destroy history), no structural prevention of negative balances, and computing "net balance" requires a full table scan rather than a read of a maintained accumulator.

</details>

---

> **Q2**: If Alice sends Bob $100, how many rows are written to the database? Justify your answer.

<details><summary>Answer</summary>

At minimum two *postings* — one debit from Alice, one credit to Bob. Single-row = single-entry = no conservation. You need to record both sides of the movement.

In TigerBeetle: exactly one `Transfer` record (which contains both `debit_account_id` and `credit_account_id`). In Beancount: one `Transaction` with two `Posting`s. Different representation, same two-sided structure.

</details>

---

> **Q3**: Give a *falsifiable* definition of "a correct accounting system."

<details><summary>Answer</summary>

A correct accounting system is one where, at any point in time, `sum(all_posted_amounts_across_all_accounts) = 0`.

This is falsifiable: compute the sum. If it's non-zero, the system is incorrect. Period. No other definition is rigorous enough to be checkable.

</details>

---

> **Q4**: Your payments DB crashes mid-write after debiting Alice's account but before crediting Bob's. What happened to the $100? How do you detect it? How do you fix it?

<details><summary>Answer</summary>

$100 has been destroyed. Alice's balance decreased; Bob's did not increase. The trial balance (`sum(all_balances)`) is now -$100 instead of $0 — detectable if you check. If you don't regularly verify the trial balance, you may not notice.

Fix: either roll back the debit (idempotent retry of the whole operation) or apply the credit. Prevention: atomic transactions — both postings commit together or neither does. This is exactly what TigerBeetle's linked events and two-phase transfers solve structurally.

</details>

---

> **Q5**: Could you implement accounting in a spreadsheet? What breaks first at 10 users? At 10,000 concurrent transactions?

<details><summary>Answer</summary>

At 10 users: nothing technical breaks, but there's no enforcement. Any cell can be manually edited, destroying the audit trail. Invariants are not machine-checked.

At 10,000 concurrent transactions: serialization. A spreadsheet has no concept of ACID transactions. Two concurrent edits to the same cell produce a race condition. You lose the conservation invariant under any concurrency. Also: no structural prevention of invalid states — a formula can be deleted, a row accidentally omitted.

</details>

---

> **Q6**: A bank statement shows your balance is $1,000. Your ledger says $1,050. Which is right?

<details><summary>Answer</summary>

There is no intrinsic answer. What matters is having a system with checkpoints (balance assertions) that flag the discrepancy and force you to find the cause. The bank's record might be wrong (missing a pending deposit). Your ledger might be wrong (a duplicate posting). You bisect until you find the divergent transaction. This is Module 5's subject.

The discipline of doing this systematically against external records is called **reconciliation**.

</details>

---

## Exercises

**Exercise 0-A: The broken single-entry log**

Given this transaction log:
```
+100   Alice receives paycheck
 -30   Alice pays rent
 -50   Alice buys groceries   ← this row is lost in a crash
 +200  Alice receives bonus
```

(a) Compute Alice's balance with the missing row.
(b) Compute it without. What is the discrepancy?
(c) In a double-entry system, which invariant would catch this missing entry automatically, and at what point?

<details><summary>Solution</summary>

(a) With all rows: 100 - 30 - 50 + 200 = **$220**
(b) Without the grocery row: 100 - 30 + 200 = **$270** — a $50 phantom balance.
(c) The trial balance. In double-entry, the grocery purchase would have a matching posting to `Expenses:Food` for +$50. If the Alice debit posting is lost but the expense credit is not (or vice versa), the sum across all accounts is no longer zero. The system detects it on the next trial balance check.

In single-entry, you cannot detect this because there is no counterpart posting to go missing.

</details>

---

**Exercise 0-B: Invariant audit**

Here is a simplified Postgres schema for a payments startup:
```sql
CREATE TABLE transfers (
  id          UUID PRIMARY KEY,
  sender_id   UUID NOT NULL,
  receiver_id UUID NOT NULL,
  amount      BIGINT NOT NULL CHECK (amount > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

List every accounting invariant this schema **cannot** enforce structurally. For each, name the class of bug it allows.

<details><summary>Solution</summary>

1. **Conservation across accounts**: A row can be inserted with `sender_id = receiver_id`, debiting and crediting the same account (net zero but meaningless). Or `sender_id` can reference a non-existent account — value appears from nowhere.

2. **Immutability of history**: A row can be `UPDATE`d or `DELETE`d, destroying the audit trail with no trace.

3. **No balance floor**: There is nothing preventing `sender_id`'s balance from going negative. The schema has no reference to account balances at all — balance is a derived computation that must be re-run at query time, not enforced at write time.

4. **No atomicity across legs**: The schema is single-legged. There is no structural guarantee that a credit to `receiver_id` occurred. If you enforce this in application code, a crash between the two operations produces a half-applied transfer.

5. **No idempotency**: Two rows with different `id`s but identical `(sender_id, receiver_id, amount, created_at)` are treated as distinct transfers. A network retry that generates a new UUID creates a duplicate charge.

</details>

---

**Exercise 0-C: Conceptual mapping**

Map each of the following software concepts to its accounting equivalent:

| Software concept | Accounting equivalent |
|---|---|
| Unit test assertion | ? |
| Git commit | ? |
| Database transaction (ACID) | ? |
| Checksum / hash verification | ? |
| Append-only log | ? |

<details><summary>Solution</summary>

| Software concept | Accounting equivalent |
|---|---|
| Unit test assertion | Balance assertion (`balance` directive in Beancount) |
| Git commit | An accounting transaction (atomic, dated, immutable once recorded) |
| Database transaction (ACID) | Posting group (all postings commit atomically or none do) |
| Checksum / hash verification | Trial balance (sum of all balances = 0 is the checksum) |
| Append-only log | The ledger (history is append-only; corrections are new entries, never mutations) |

</details>

---

**Source reading for this module**:
- [Beancount: Command-Line Accounting in Context](https://beancount.github.io/docs/command_line_accounting_in_context.html) — "What exactly is Accounting?" and "Motivation" sections
- [Beancount: Design Doc](https://beancount.github.io/docs/beancount_design_doc.html) — "Invariants" section (Isolation of Inputs, Order-Independence, All Transactions Must Balance)
- [TigerBeetle: OLTP Concepts](https://docs.tigerbeetle.com/concepts/oltp/)
- [TigerBeetle: Safety](https://docs.tigerbeetle.com/concepts/safety/)
