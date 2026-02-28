# Fintech Patterns: Idempotency, Correcting Entries, Rate Limiting, Balance-Conditional Transfers

## Concept

Four production patterns, each a direct consequence of invariants from earlier modules. None are optional in a real fintech system.

---

**Pattern 1: Idempotency via Client-Generated IDs**

The client — not the API server — generates the transfer `id` *before* any network call, and persists it to local storage before submission.

```
1. User initiates transfer
2. Client generates id (e.g., UUIDv4 or ULID)
3. Client persists id to local storage
4. Client submits transfer to API
5. API includes transfer in create_transfers request
6. TigerBeetle creates it once and only once
```

On retry with the same `id`: TigerBeetle returns `exists` (success). On first submission: returns `ok`. The API server never needs to check — TigerBeetle's deduplication is structural. Critical: if the API generates the `id`, a client restart before receiving the response will result in a second submission with a *new* id, creating a duplicate transfer.

---

**Pattern 2: Correcting Entries — Always Add, Never Modify**

Transfers are immutable. A "correction" is a new Transfer in the opposite direction, linked to the original via `user_data_128`.

```
Original:  T1  debit=A  credit=B  amount=100  code=1001  user_data_128=<invoice_id>
Error discovered.
Reversal:  T2  debit=B  credit=A  amount=100  code=1002  user_data_128=<invoice_id>
Correct:   T3  debit=A  credit=B  amount=90   code=1001  user_data_128=<invoice_id>
```

Use a dedicated `code` value to identify corrections (e.g., `1002 = reversal`, `1003 = adjustment`). The full audit trail is: T1 happened, T2 reversed it, T3 is the correct amount. A reporting layer can "downsample" to show only the net result; the raw ledger preserves all three. A correction can itself be wrong — correct *that* with another transfer. The stack never needs to be popped destructively.

---

**Pattern 3: Rate Limiting via Leaky Bucket**

TigerBeetle can account for non-financial resources. The leaky bucket pattern:

**Setup** (once per user, per resource type):
```
Ledger:  RequestRate  (separate from any financial ledger)
Accounts:
  - operator_ratelimit  (no flags — unlimited)
  - user_ratelimit      (flags: debits_must_not_exceed_credits)

Seed transfer:
  debit=operator_ratelimit  credit=user_ratelimit  amount=10
  → user_ratelimit now has credits_posted=10, balance=10
```

**Per request**:
```
Pending transfer:
  debit=user_ratelimit  credit=operator_ratelimit  amount=1  timeout=60  flags=pending
```
- If `debits_pending` would exceed `credits_posted` → TigerBeetle rejects → request blocked
- If transfer succeeds → request allowed → pending expires after 60s → balance automatically restored
- No explicit "reset" needed — expiry is the reset

**Transfer amount limiting** (two ledgers, linked):
```
T1 (rate-limit ledger):  debit=user_ratelimit  credit=op_ratelimit  amount=X
                         timeout=86400  flags=pending|linked
T2 (USD ledger):         debit=user_usd  credit=dest_usd  amount=X
                         flags=(none)
```
T1 and T2 are linked. If T1 fails (daily limit exhausted), T2 also fails atomically. No partial state.

---

**Pattern 4: Balance-Conditional Transfers**

Execute a transfer *only if* the source account has at least a threshold balance — atomically, without a separate read-then-write.

The naive approach is unsafe:
```
balance = lookup_accounts(source_id).balance   ← snapshot
if balance >= threshold:                        ← not atomic with the next line
    create_transfers(...)                       ← balance may have changed
```

The correct approach uses 3 linked transfers and a `control` account:

```
Source has credit balance (Liability/Income):
  T1: debit=source      credit=control    amount=threshold  flags=linked|pending
  T2: void_pending_transfer T1                              flags=linked|void_pending_transfer
  T3: debit=source      credit=dest       amount=transfer_amount

Source has debit balance (Asset/Expense):
  T1: debit=control     credit=source     amount=threshold  flags=linked|pending
  T2: void_pending_transfer T1                              flags=linked|void_pending_transfer
  T3: debit=dest        credit=source     amount=transfer_amount
```

Mechanism: T1 attempts to move `threshold` to the control account. If `source` lacks the balance, T1 fails (balance limit flag rejects it) → T2 and T3 also fail → nothing happens. If T1 succeeds, T2 immediately voids it (returning funds to source), and T3 executes the actual transfer. The control account always nets to zero — it is purely a probe mechanism.

---

## Socratic Dialogue

> **Q1**: The API server generates transfer IDs. A user clicks "Send $50" on their phone. The API call reaches TigerBeetle and succeeds, but the response is lost in transit. The user's app retries. What happens?

<details><summary>Answer</summary>

The API server generates a *new* `id` on the retry (it has no memory of the failed response). TigerBeetle sees a Transfer with a different `id`, treats it as a new request, and creates a second transfer. The user's account is debited $100. The bank statement shows two $50 transfers.

This is the fundamental argument for client-side ID generation. The client is the only party that survives all failure modes with persistent local state. The API server is stateless between requests. TigerBeetle is stateful but only knows what it was told. Only the client can supply the same ID across a retry boundary.

Fix: move ID generation to the client before any network boundary. Persist to local storage *before* the first HTTP request. Use the same ID on every retry. TigerBeetle's `exists` response is indistinguishable from `ok` from the client's perspective — both mean "the transfer is in the ledger."

</details>

---

> **Q2**: A correcting transfer reverses the original by debiting B and crediting A for the same amount. Trial balance still holds. But what does the *audit log* now show? Why is this preferable to a database `UPDATE`?

<details><summary>Answer</summary>

The audit log shows three facts in temporal order: (1) on date D1, $100 moved from A to B (the error), (2) on date D2, $100 moved from B to A (the reversal), (3) on date D3, $90 moved from A to B (the correct amount). Each event has a timestamp, an immutable ID, and a `code` field identifying its semantic type.

A database `UPDATE accounts SET balance = balance - 10` destroys the error. The audit log becomes: "on D1, $90 moved from A to B." You can no longer tell that $100 was originally recorded and corrected, when the error was discovered, or who authorized the correction. For regulated financial systems, this is not merely bad practice — it may constitute a records violation.

TigerBeetle's immutability is not a technical limitation; it is a deliberate choice to make corrections observable at the finest resolution. A reporting layer can show "net $90 moved from A to B," but the raw ledger preserves the full correction chain.

</details>

---

> **Q3**: The rate-limit account for a user has `credits_posted=10, debits_pending=8`. A request comes in. Does it succeed? What is the available balance at the moment of decision?

<details><summary>Answer</summary>

Available balance = `credits_posted - debits_pending` = 10 − 8 = 2. The incoming request requires `debits_pending += 1`, which would make `debits_pending = 9`. Since `credits_posted (10) >= debits_pending (9)`, the transfer succeeds. The user has 1 unit of rate-limit budget remaining.

The next request would attempt `debits_pending = 10`. `credits_posted (10) >= debits_pending (10)` — still succeeds. The one after would attempt `debits_pending = 11 > credits_posted = 10` — rejected by `debits_must_not_exceed_credits`. As the oldest pending transfers expire (after 60s), `debits_pending` decreases and the budget is replenished automatically.

Key insight: TigerBeetle's balance arithmetic is used here to enforce a *temporal resource budget*, not a financial balance. The accounting identity is the enforcement mechanism.

</details>

---

> **Q4**: Why is `lookup_accounts` + `create_transfers` not an atomic balance check? What failure mode does it introduce in a concurrent system?

<details><summary>Answer</summary>

`lookup_accounts` returns a snapshot of the account's balance at a single point in time. Between that read and the subsequent `create_transfers` call, other clients may submit transfers that modify the balance. TigerBeetle processes requests serially within a batch but operates on multiple concurrent client connections. The window between the two requests is not protected by any lock or transaction.

Failure mode: two clients both read `balance=500`. Both determine the threshold is met. Both submit their transfers. Both succeed — TigerBeetle processes them in arrival order. After both complete, `balance=−500` (if the flag is not set) or the second one fails with a surprising rejection (if the flag is set but the client expected success based on its earlier read). This is a classic TOCTOU (time-of-check time-of-use) race.

The 3-transfer pattern eliminates the window by making the balance check and the transfer a single atomic operation within TigerBeetle's serial processing loop.

</details>

---

> **Q5**: A user submits a correcting transfer using `user_data_128` to reference the original transfer's ID. Three weeks later, a regulator asks: "Show me all corrections made to this account in Q3." How do you query for that?

<details><summary>Answer</summary>

```python
# Get all transfers on the account
transfers = client.get_account_transfers(
    account_id=account_id,
    timestamp_min=q3_start_ns,
    timestamp_max=q3_end_ns,
)

# Filter for correction codes
CORRECTION_CODES = {1002, 1003}  # reversal, adjustment
corrections = [t for t in transfers if t.code in CORRECTION_CODES]

# For each correction, look up the original
for c in corrections:
    original_id = c.user_data_128  # FK to original transfer
    original = client.lookup_transfers([original_id])
    print(f"Correction {c.id} reversed original {original_id}")
```

This works because `user_data_128` is a 128-bit FK to the application DB (or directly to the original transfer's `id`). The `code` field discriminates correction types. `get_account_transfers` with timestamp range returns only the relevant period.

Note: TigerBeetle does not enforce the `user_data_128` → original transfer relationship. Your application must establish the convention. If the correcting transfer's `user_data_128` is left unset, you lose the linkage. The discipline is at the application layer; TigerBeetle only provides the storage.

</details>

---

> **Q6**: The transfer-amount-limiting pattern uses `timeout=86400` (one day) on the rate-limit pending transfer. A user transfers $999 at 11:58 PM. At 11:59 PM (one minute later), can they transfer another $999 if the daily limit is $1000?

<details><summary>Answer</summary>

No. The pending transfer from 11:58 PM expires 86400 seconds later — at 11:58 PM *the next day*. At 11:59 PM, that pending has not expired. `debits_pending` is still 999. The second $999 transfer would attempt `debits_pending = 1998 > credits_posted = 1000` — rejected.

There is no clock-based reset in this design. There is no "midnight UTC reset." Each pending transfer expires relative to its own `timestamp + timeout`. If you need a hard calendar-day reset, you need a separate mechanism: a cron job that voids all outstanding pending transfers at midnight, or a different pattern using a sentinel account that is zeroed and re-seeded on a schedule.

The leaky bucket pattern is a *rolling window*, not a *fixed window*. The $999 budget refills 86400 seconds after *each individual transfer*, not at a fixed wall-clock time.

</details>

---

> **Q7**: In the balance-conditional transfer pattern, what is the net effect on the `control` account across a successful 3-transfer batch? Across a failed batch?

<details><summary>Answer</summary>

**Successful batch**: T1 moves `threshold` from source to control (`control.credits_posted += threshold`). T2 voids T1 — the pending is cancelled, so `control.credits_posted` is decremented back. T3 is an independent transfer between source and dest; control is not involved. Net effect on control: zero.

**Failed batch**: T1 fails (source balance insufficient) → T2 and T3 do not execute (linked). Net effect on control: zero. Control is never touched.

In all outcomes, `control` ends at exactly the same balance it started with. It is a probe, not a participant. You can use a single shared `control` account for all balance-conditional operations on a ledger — it will always net to zero.

</details>

---

## Exercises

**Exercise 9-A: Idempotency Failure Analysis**

Your mobile app generates transfer IDs server-side. You observe that approximately 0.3% of transfers appear in duplicate in the ledger — always in pairs, always within 30 seconds of each other, always for the same amount. Describe the exact failure mode, the sequence of events that produces each duplicate, and the minimal code change that eliminates it without requiring any server-side changes.

<details><summary>Solution</summary>

**Failure mode**: The server generates a new UUID on each request. The 30-second window is the app's retry timeout. Sequence:

1. User taps "Pay"
2. App sends POST /transfer to API server
3. API server generates `id = uuid_v4()`, calls TigerBeetle
4. TigerBeetle creates transfer, responds `ok`
5. API server responds 200 to app — **response lost in transit (TCP timeout, airplane mode, etc.)**
6. App times out after 30s, retries POST /transfer
7. API server generates `id = uuid_v4()` — **different UUID**
8. TigerBeetle sees a new ID, creates a second transfer

The 0.3% rate matches typical mobile network interruption rates for time-sensitive responses.

**Minimal fix — client only** (requires server to accept client-provided ID):

```javascript
async function sendPayment(amount, dest) {
  // Generate and persist ID BEFORE any network call
  let transferId = localStorage.getItem('pending_transfer_id');
  if (!transferId) {
    transferId = crypto.randomUUID();
    localStorage.setItem('pending_transfer_id', transferId);
  }

  try {
    const response = await api.post('/transfer', {
      id: transferId,  // client sends its own ID
      amount,
      dest,
    });
    localStorage.removeItem('pending_transfer_id');  // clear on confirmed success
    return response;
  } catch (e) {
    // ID remains in localStorage — next retry uses the same ID
    throw e;
  }
}
```

On retry, TigerBeetle receives the same `id`, returns `exists`, the API returns success, local storage is cleared. No duplicate created.

**Edge case**: if local storage is cleared (app reinstall), the pending transfer in TigerBeetle is orphaned. A server-side reconciliation job must detect transfers with no app-side confirmation. Client-side ID generation is necessary but not sufficient for full reliability — the persisted ID must survive the app's lifecycle.

**If the server cannot be modified** to accept a client-provided ID, the fix is impossible without server changes. This is why "API generates the ID" is architecturally broken at the transport layer.

</details>

---

**Exercise 9-B: Correcting a Batch of Linked Transfers**

A payroll run processed 500 employees. Due to a bug, the `amount` field was multiplied by 10 — every employee received 10× their salary. The transfers used `code=2001` and stored the payroll batch ID in `user_data_64`. You need to: (1) reverse all 500 transfers, (2) issue correct amounts, (3) ensure the entire correction is atomic per-employee (not per-batch). Design the TigerBeetle transfer sequence and identify the key risks.

<details><summary>Solution</summary>

**Per-employee atomicity** — for each employee, issue two linked transfers:

```
T_reversal:   debit=employee_checking  credit=payroll_account
              amount=erroneous_amount
              code=2002                           ; reversal code
              user_data_128=<original_transfer_id>
              user_data_64=<payroll_batch_id>
              flags=linked

T_correct:    debit=payroll_account  credit=employee_checking
              amount=correct_amount
              code=2001
              user_data_64=<payroll_batch_id>
              flags=(none)
```

These two are linked per employee. If the reversal fails (employee spent the overpayment — balance insufficient), the correction also fails for that employee. Handle those employees separately via a debt recovery process.

**Submission**: all 500 pairs (1000 transfers) in one or two batches. Pairs are linked within an employee but not across employees — one employee's failure does not roll back the others.

**Key risks**:

1. **Partial reversal impossibility**: TigerBeetle does not support reversing more than the current balance if `debits_must_not_exceed_credits` is set. Policy decision: (a) reverse only available balance and track residual debt in your app DB, (b) use a recovery account that permits going negative.

2. **Idempotency of the correction run**: if the correction script crashes and retries, each reversal+correction pair must use stable pre-generated IDs. Store all 1000 IDs before starting. On retry, TigerBeetle returns `exists` for already-processed pairs.

3. **Audit trail**: query `WHERE code=2002 AND user_data_64=<batch_id>` to retrieve all reversals for this batch. Use `timestamp` to distinguish original errors (`code=2001`, earlier timestamps) from corrections (`code=2001`, later timestamps). Both use the same `code` — the timestamp is the discriminator.

4. **Notification race**: the reversal debit may trigger real-time fraud alerts. Coordinate with the notification system before submitting.

</details>

---

**Exercise 9-C: Capstone — Robinhood-Style Brokerage Account Schema**

Design the complete TigerBeetle account schema for a retail brokerage. For each user action (deposit, buy stock, sell stock, withdraw, receive dividend), write the Transfer sequence. Identify every point where balance invariants must be enforced via account flags.

<details><summary>Solution</summary>

**Account Schema**

One ledger per currency/commodity. Each user needs accounts on each ledger they participate in.

```
LEDGER 1: USD (id=1)
  operator_usd            — omnibus cash pool (no flags)
  user_{uid}_cash         — user's settled cash
                            flags: debits_must_not_exceed_credits
  user_{uid}_unsettled    — sale proceeds in T+2 transit (no flags)
  tax_withholding         — operator account for withheld taxes (no flags)
  commission_pool         — operator revenue (no flags)
  control_usd             — balance-conditional probe account (no flags, always nets to zero)

LEDGER 2: AAPL (id=2, unit = 1 share × 10^6 for fractional)
  user_{uid}_aapl         — user's AAPL position
                            flags: debits_must_not_exceed_credits
  operator_aapl           — omnibus position account (no flags)

LEDGER 3: TRADE_RATE (id=3, non-financial)
  operator_ratelimit      — no flags
  user_{uid}_ratelimit    — flags: debits_must_not_exceed_credits
```

---

**Deposit $1000**:
```
T1: debit=operator_usd  credit=user_{uid}_cash  amount=100000
    code=DEPOSIT  user_data_128=<bank_transfer_id>
```
Single transfer. Balance constraint not relevant here — operator is unconstrained.

---

**Buy 10 AAPL at $180 ($1800 + $4.99 commission)**:
```
; Reserve cash — pending authorization
T1: debit=user_{uid}_cash  credit=operator_usd  amount=180499
    flags=pending  timeout=300  code=ORDER_RESERVE
    user_data_128=<order_id>

; On fill — post the pending and deliver shares atomically
T2: post_pending_transfer T1  amount=180499
    flags=post_pending_transfer|linked
T3: debit=operator_aapl  credit=user_{uid}_aapl  amount=10_000000
    code=BUY_SHARES|linked  user_data_128=<order_id>
T4: debit=operator_usd  credit=commission_pool  amount=499
    code=COMMISSION
```
Invariant: `user_{uid}_cash.debits_must_not_exceed_credits` blocks the pending if cash is insufficient. T1 (pending) reserves cash — concurrent orders cannot double-spend. T2/T3 are linked — no scenario where cash is taken but shares not delivered.

---

**Sell 5 AAPL at $185 ($925 − $4.99 commission)**:
```
; Reserve shares — pending
T1: debit=user_{uid}_aapl  credit=operator_aapl  amount=5_000000
    flags=pending  timeout=300  code=ORDER_RESERVE
    user_data_128=<order_id>

; On fill
T2: post_pending_transfer T1  amount=5_000000
    flags=post_pending_transfer|linked
T3: debit=operator_usd  credit=user_{uid}_unsettled  amount=92001
    code=SALE_UNSETTLED|linked  user_data_128=<order_id>
T4: debit=operator_usd  credit=commission_pool  amount=499
    code=COMMISSION

; T+2 settlement
T5: debit=user_{uid}_unsettled  credit=user_{uid}_cash  amount=92001
    code=SALE_SETTLED  user_data_128=<order_id>
```
Invariant: `user_{uid}_aapl.debits_must_not_exceed_credits` prevents overselling. T3 credits `unsettled` not `cash` — user cannot withdraw proceeds before T+2.

---

**Withdraw $500**:
```
; Balance-conditional: atomically verify cash >= $500 before executing
T1: debit=user_{uid}_cash  credit=control_usd  amount=50000
    flags=linked|pending
T2: void_pending_transfer T1
    flags=linked|void_pending_transfer
T3: debit=user_{uid}_cash  credit=operator_usd  amount=50000
    code=WITHDRAWAL  user_data_128=<bank_transfer_id>
```
Without the 3-transfer pattern, a concurrent buy order's pending debit could reduce available cash between a `lookup_accounts` read and the withdrawal transfer — TOCTOU race. The 3-transfer pattern makes the balance check and the debit atomic.

---

**Receive Dividend ($0.25/share × 100 shares = $25, 30% withholding)**:
```
T1: debit=operator_usd  credit=user_{uid}_cash  amount=1750
    flags=linked  code=DIVIDEND  user_data_128=<dividend_event_id>
T2: debit=operator_usd  credit=tax_withholding  amount=750
    code=DIVIDEND_WITHHOLDING  user_data_128=<dividend_event_id>
```
T1 and T2 are linked — dividend credit and withholding deduction are atomic. No state where user receives gross dividend without withholding.

---

**Complete Invariant Map**

| Account | Flag | Prevents |
|---|---|---|
| `user_cash` | `debits_must_not_exceed_credits` | Overdraft, buying with non-existent cash |
| `user_aapl` | `debits_must_not_exceed_credits` | Short selling (naked) |
| `user_ratelimit` | `debits_must_not_exceed_credits` | Order rate abuse |
| `user_unsettled` | (none) | Settlement account, may fluctuate |
| `operator_*` | (none) | Operator accounts are unconstrained by design |
| `control_usd` | (none) | Probe account, always nets to zero |

**What TigerBeetle cannot enforce without application logic**:
- Pattern-day-trader rules (≥4 round trips in 5 days): requires querying `get_account_transfers` and counting in application code
- Wash sale detection: cross-account, cross-user analysis — no TigerBeetle primitive
- PDT margin requirements: account classification metadata lives in your application DB, not TigerBeetle

</details>

---

### Source Reading

- `tigerbeetledocs/coding/reliable-transaction-submission/index.html` — The App or Browser Should Generate the ID, Handling Network Failures, Handling Client Software Restarts
- `tigerbeetledocs/coding/recipes/correcting-transfers/index.html` — Always Add More Transfers, using `Transfer.code` and `Transfer.user_data_128` to link corrections to originals
- `tigerbeetledocs/coding/recipes/rate-limiting/index.html` — Mechanism, Request Rate Limiting, Bandwidth Limiting, Transfer Amount Limiting
- `tigerbeetledocs/coding/recipes/balance-conditional-transfers/index.html` — Preconditions, Executing a Balance-Conditional Transfer, Understanding the Mechanism
- `tigerbeetledocs/concepts/safety/index.html` — immutability guarantees underpinning correcting entries
- `tigerbeetledocs/coding/two-phase-transfers/index.html` — pending/post/void/expire mechanics underlying rate limiting and order reservation

---

## End of Curriculum

You have covered:

| Module | Core Invariant Learned |
|---|---|
| 0 | `sum(all_postings) == 0` always |
| 1 | account = accumulator, posting = signed delta, transaction = zero-sum set |
| 2 | 5 account types are a semantic type system; accounting equation is a corollary of M1 |
| 3 | TigerBeetle's 2-account Transfer vs Beancount's N-posting transaction; `flags.linked` for atomicity |
| 4 | TigerBeetle's balance arithmetic; ledger = currency partition |
| 5 | Detective vs preventive consistency; immutable history; bisection for discrepancy detection |
| 6 | Authorization ≠ settlement; pending → posted/voided/expired state machine |
| 7 | Conservation within commodity, not across; cross-currency = two linked transfers via liquidity account |
| 8 | Realized vs unrealized P/L; booking method determines tax liability; lot tracking is application-layer in TigerBeetle |
| 9 | Client-generated IDs; correcting entries; leaky bucket rate limiting; balance-conditional transfers |

The through-line: every pattern in fintech is an application of `sum(all_postings) == 0`, enforced either at submission time (TigerBeetle flags) or at audit time (Beancount balance assertions). All complexity is bookkeeping.
