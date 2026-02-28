# Two-Phase Transfers and Settlement

## Concept

Every real financial system separates **authorization** from **settlement**. When you swipe your credit card, the merchant gets authorization instantly — but funds settle days later. Your bank's available balance drops immediately; the posted balance changes only when settlement clears.

TigerBeetle models this natively with two-phase transfers.

**Phase 1 — Reserve (Pending):**

```
flags.pending = true

Effect on debit account:   debits_pending  += amount
Effect on credit account:  credits_pending += amount

debits_posted and credits_posted are UNCHANGED.
```

The funds are reserved. Available balance decreases. Posted balance is unchanged.

**Phase 2 — Resolve:**

Three outcomes, each a *new* Transfer with `pending_id` pointing to the original:

```
flags.post_pending_transfer:
  debits_pending  -= amount_posted
  debits_posted   += amount_posted
  (amount_posted ≤ pending amount; remainder auto-released)

flags.void_pending_transfer:
  debits_pending  -= amount
  (full reservation released, nothing posts)

Expiry (timeout elapsed, no action taken):
  debits_pending  -= amount
  (same effect as void, automatic)
```

**Key points:**

- Transfers are immutable. The pending Transfer is never modified. The post/void is a *new* Transfer with its own `id`, timestamped separately.
- Partial posting: you can post less than the pending amount. `amount_posted < pending_amount` means only `amount_posted` settles; the rest is released automatically. This models hotel pre-authorizations: authorize $500, settle actual spend of $380.
- `timeout`: a `u32` number of seconds. After the timeout, TigerBeetle auto-expires the pending transfer. Your application does not need to poll or cancel — the reservation evaporates. Use this for ACH holds, card authorizations, and rate-limit windows.
- **Pessimistic accounting**: `flags.debits_must_not_exceed_credits` checks `debits_posted + debits_pending ≤ credits_posted` at *pending* time, not at posting time. This guarantees no balance violation is possible when posting occurs — the check already passed.

**Beancount parallel:**

Beancount uses a `!` (exclamation mark) flag on transactions to mark them as "incomplete" or "pending":

```beancount
2024-03-15 ! "ACH withdrawal — pending"
  Assets:Checking    -500.00 USD
  Assets:ACH:Pending  500.00 USD
```

When settlement occurs, you replace the `!` with `*` and adjust the accounts. The `Assets:ACH:Pending` account serves the same semantic role as `debits_pending` — it segregates committed-but-not-settled funds from posted balances. This is manual discipline in Beancount; TigerBeetle enforces it structurally.

**Two-phase transfers and double-spend prevention:**

The classic double-spend attack: two concurrent withdrawals, each for the full balance, both approved before either settles. Without pending, both see `available = posted_balance` and both succeed. With `flags.pending` and `flags.debits_must_not_exceed_credits`:

- Transfer A creates a pending debit. `debits_pending = 500`.
- Transfer B arrives. TigerBeetle checks: `debits_pending + debits_posted + 500 > credits_posted` → rejected.

TigerBeetle's serial state machine means these checks cannot race. All transfers are processed one-at-a-time, in order. No lock is needed because there is no concurrency within the state machine.

---

## Socratic Dialogue

> **Q1**: After a pending transfer is created, `debits_posted` on the debit account is unchanged. So the "posted balance" looks the same. Why does available balance decrease?

<details><summary>Answer</summary>

Available balance is computed as:

```
available = posted_balance - debits_pending
          = (credits_posted - debits_posted) - debits_pending   [credit-normal]
```

`debits_pending` is the reservation. It hasn't settled yet, but the funds are committed — TigerBeetle guarantees they will post when phase 2 runs. Showing the full `credits_posted - debits_posted` as available would be dishonest: those funds are already spoken for. The pending amount is subtracted to give the user the true spendable amount.

This is exactly what your bank does when you initiate a bill payment — posted balance unchanged, available balance drops.

</details>

---

> **Q2**: A pending transfer has `amount = 500`. You post it with `amount = 300`. What happens to the remaining 200?

<details><summary>Answer</summary>

The remaining 200 is **automatically released** back to the debit account. When a post-pending transfer specifies an amount less than the pending amount:

- `debits_pending -= 500` (full reservation released)
- `debits_posted  += 300` (only posted amount settles)
- The remaining 200 never touches `debits_posted` — it simply ceases to be reserved.

The credit account mirrors this: `credits_pending -= 500`, `credits_posted += 300`.

This is essential for the hotel/car rental pattern: a $500 pre-authorization can settle to $312.47 without any manual cleanup of the difference.

</details>

---

> **Q3**: What is the `timeout` field on a pending transfer? What happens if you set it and then forget about the transfer?

<details><summary>Answer</summary>

`timeout` is a `u32` value in **seconds** representing the duration from the transfer's timestamp until automatic expiry. TigerBeetle's cluster manages time internally ("cluster time") — it does not use the client's clock.

If you set `timeout = 3600` (1 hour) and never post or void the transfer:
- After 3600 seconds, TigerBeetle automatically expires the pending transfer
- `debits_pending -= amount` on the debit account
- `credits_pending -= amount` on the credit account
- The reserved funds are fully released

Your application does not need to run a cleanup job. The pending transfer is atomically expired by TigerBeetle. The only observable effect is the availability returning.

Note: expired pending transfers cannot be posted or voided afterward — they return `pending_transfer_expired`.

</details>

---

> **Q4**: Why is the post/void of a pending transfer a *new* Transfer rather than a mutation of the original?

<details><summary>Answer</summary>

Three reasons:

1. **Immutability**: TigerBeetle's data model is append-only. Transfers are never modified. This is not a limitation — it is the audit trail property. The pending transfer record shows when authorization happened; the post transfer record shows when settlement happened. Both are permanent, timestamped events.

2. **Idempotency**: The post/void transfer has its own client-generated `id`. If the post request times out and is retried with the same `id`, TigerBeetle returns `exists` (idempotent). If the original pending transfer were modified instead, retrying a mutation is much harder to make idempotent correctly.

3. **Queryability**: `get_account_transfers` returns both the pending and the posting transfer in sequence. You can see the full lifecycle: authorization at time T1, settlement at time T2, partial amount posted. This timeline is valuable for reconciliation, disputes, and compliance.

</details>

---

> **Q5**: Two concurrent $500 withdrawals arrive for an account with `credits_posted = 500`, `debits_posted = 0`. TigerBeetle processes all transfers serially. Walk through what happens.

<details><summary>Answer</summary>

Assume `flags.debits_must_not_exceed_credits` is set.

**Transfer A arrives first:**
- Check: `debits_pending + debits_posted + 500 = 0 + 0 + 500 ≤ 500 = credits_posted` ✓
- Creates pending: `debits_pending = 500`

**Transfer B arrives second:**
- Check: `debits_pending + debits_posted + 500 = 500 + 0 + 500 = 1000 > 500 = credits_posted` ✗
- Rejected: `exceeds_credits`

Transfer A succeeds. Transfer B is rejected. No double-spend.

**Without the flag**: TigerBeetle has no basis to reject Transfer B. Both pending transfers are created. `debits_pending = 1000`. If both post, `debits_posted = 1000 > credits_posted = 500`. The account goes negative — a double-spend occurred. The flag is not optional for accounts where overdraft is impermissible.

</details>

---

> **Q6**: An ACH transfer is initiated Friday evening. Settlement typically takes 1–3 business days. Model the TigerBeetle states through the following Monday.

<details><summary>Answer</summary>

```
Friday 5pm:   Pending transfer created
              debit_account.debits_pending   += ACH_amount
              credit_account.credits_pending += ACH_amount
              timeout = 72h (or 259200 seconds, covering the weekend)

[Weekend — no banking activity]

Monday 9am:   ACH network confirms settlement
              Post-pending transfer submitted:
              debit_account.debits_pending   -= ACH_amount
              debit_account.debits_posted    += ACH_amount
              credit_account.credits_pending -= ACH_amount
              credit_account.credits_posted  += ACH_amount

Monday 9am (rejection scenario):
              ACH returns NSF (insufficient funds at originating bank)
              Void-pending transfer submitted:
              debit_account.debits_pending   -= ACH_amount
              (nothing posts; funds fully released)
```

During the weekend, the sender's available balance correctly reflects the hold. The recipient's available balance does not increase (credits_pending, not credits_posted). This is correct: an ACH credit is not spendable until it posts.

</details>

---

> **Q7**: Can a pending transfer be posted multiple times, or voided after being posted?

<details><summary>Answer</summary>

No. A pending transfer has exactly one resolution:
- Posted → `pending_transfer_already_posted` if you try to post or void again
- Voided → `pending_transfer_already_voided` if you try to resolve again
- Expired → `pending_transfer_expired` if you try to resolve after expiry

This is enforced by TigerBeetle's state machine. The pending transfer ID (`pending_id`) can be referenced only once in a resolving transfer. Attempting to submit a second post creates a Transfer with a new `id` and `pending_id` pointing to the already-resolved pending — TigerBeetle rejects it at the appropriate error code.

The practical consequence: idempotency for phase 2 works via the *posting transfer's own id*, not via re-submitting the phase-2 action. Generate the posting transfer's id on the client, persist it, and retry with the same id — TigerBeetle returns `exists` if it already processed it.

</details>

---

## Exercises

**Exercise 6-A: State machine diagram**

Draw (in text) the full state machine for a two-phase transfer. Show all states and transitions including error paths. Include:
- The pending transfer states
- All three resolution outcomes
- Error states (account rejected, already resolved, expired)

<details><summary>Solution</summary>

```
                          ┌─────────────────────────────────┐
                          │   SUBMITTED (pending Transfer)   │
                          └─────────────────────────────────┘
                                          │
                    ┌─────────────────────┼──────────────────────┐
                    │ balance check fails  │ balance check passes  │
                    ▼                     ▼                       │
             ┌──────────┐         ┌────────────┐                 │
             │ REJECTED  │         │  PENDING   │                 │
             │(exceeds_  │         │(funds      │                 │
             │ credits)  │         │ reserved)  │                 │
             └──────────┘         └────────────┘                 │
                                        │                        │
               ┌────────────────────────┼──────────────┐         │
               │ post_pending_transfer  │ void_pending  │ timeout │
               ▼                       ▼      elapsed  ▼         │
        ┌────────────┐         ┌─────────────┐  ┌───────────┐    │
        │   POSTED   │         │   VOIDED    │  │  EXPIRED  │    │
        │(debits_    │         │(reservation │  │(auto-void │    │
        │ posted +=) │         │ released)   │  │ on expiry)│    │
        └────────────┘         └─────────────┘  └───────────┘    │
               │                      │                │          │
               └──────────────────────┴────────────────┘          │
                              │                                    │
                    Any further resolution attempt:                │
                    pending_transfer_already_posted /              │
                    pending_transfer_already_voided /              │
                    pending_transfer_expired                       │
```

Key: every state transition (post, void, expire) is itself a new immutable Transfer record. The state of a pending transfer is derivable from the transfer log — you don't need a separate status field.

</details>

---

**Exercise 6-B: Hotel pre-authorization**

A hotel checks in a guest and pre-authorizes a card for $800 (maximum possible stay cost). At checkout, the actual bill is $523.

(a) Write the TigerBeetle Transfer sequence. Specify all relevant flags and how the amount changes between phase 1 and phase 2.
(b) At the moment of check-in, how does this appear on the guest's account (`credits_posted = 1200`, `debits_posted = 0`, `debits_pending = 0` before check-in)?
(c) If the guest checks out early and the bill is only $400, show the partial post. What happens to the remaining $400 of the reservation?

<details><summary>Solution</summary>

(a) Transfer sequence:
```
T1 (check-in, phase 1):
  debit_account_id:  guest_account
  credit_account_id: hotel_settlement_account
  amount:            800_00
  flags:             pending
  timeout:           604800  (7 days, covers max expected stay)
  code:              AUTH_HOLD

T2 (checkout, phase 2):
  pending_id:        T1.id
  debit_account_id:  guest_account         (or 0 — must match T1 or be 0)
  credit_account_id: hotel_settlement_account
  amount:            523_00                (actual bill)
  flags:             post_pending_transfer
  code:              SETTLEMENT
```

After T2: `debits_pending -= 800`, `debits_posted += 523`. Remaining 277 auto-released.

(b) After check-in (T1 posts as pending):
- `credits_posted = 1200` (unchanged — posted balance not affected)
- `debits_pending = 800`
- `available = credits_posted - debits_posted - debits_pending = 1200 - 0 - 800 = 400`

The guest can spend $400 during the stay. Their card statement shows the full $1,200 posted balance but only $400 available.

(c) Early checkout, $400 bill:
```
T2 (early checkout):
  pending_id: T1.id
  amount:     400_00
  flags:      post_pending_transfer
```

After T2:
- `debits_pending -= 800` (full reservation released)
- `debits_posted  += 400` (only bill settles)
- Remaining $400 of the reservation is gone — no additional action needed by the application.

Final state: `debits_posted = 400`, `debits_pending = 0`, `available = 800`.

</details>

---

**Exercise 6-C: The expiry window design question**

You are designing an ACH debit system. ACH returns can arrive up to 60 days after the original debit for unauthorized transactions (R10-R29 return codes), but standard NSF returns arrive within 2 business days.

(a) What `timeout` would you set on the pending transfer? Justify the trade-off.
(b) You decide to set `timeout = 172800` (48 hours, covering the NSF window). An unauthorized-transaction return arrives on day 45. What is the TigerBeetle state of the original pending transfer? What do you do?
(c) A return arrives on day 1, while the pending transfer is still active. Walk through the void sequence.

<details><summary>Solution</summary>

(a) There is no single correct answer — this is a design decision with real trade-offs.

**Option 1: 48-hour timeout** — Covers NSF returns. For the 60-day unauthorized window, you accept that the pending transfer will expire and you'll handle late returns with correcting Transfers.

**Option 2: No timeout (timeout = 0)** — Pending transfer stays open indefinitely. Requires your application to explicitly post or void on return notification. Funds remain reserved, which is correct but may confuse users who see a perpetual hold.

**Recommendation**: 48-hour timeout for the pending/settlement window; treat 60-day returns as correcting transfers against the already-posted balance. The 60-day window is not a "hold" scenario — it is a reversal of a completed transaction.

(b) On day 45, the pending transfer expired on day 2. TigerBeetle state: the funds were released, `debits_pending = 0`. If the transfer also posted on day 1 (normal ACH settlement), `debits_posted` reflects the settled amount.

The day-45 return is now a **correcting transfer**: submit a Transfer that credits the user's account for the returned amount, debits the ACH returns account, with `code = RETURN` and `user_data_128 = original_ACH_order_id`. This is a new, separate Transfer — not a void (the original pending transfer is long gone).

(c) Return arrives day 1, pending transfer still active:
```
T_void:
  pending_id:            T_original.id
  debit_account_id:      0 (or match original)
  credit_account_id:     0 (or match original)
  amount:                0 (or match original)
  flags:                 void_pending_transfer
  code:                  ACH_RETURN
  user_data_128:         original_ACH_order_id
```

Effect:
- `debits_pending  -= amount` (reservation released)
- `credits_pending -= amount` (merchant's pending credit released)
- Nothing posts. The transaction is fully unwound.

The original pending transfer remains in history with `flags.pending = true`. The void transfer is a new record showing the return. Both are queryable forever.

</details>

---

**Source reading for this module**:
- [TigerBeetle: Two-Phase Transfers](https://docs.tigerbeetle.com/coding/two-phase-transfers/) — full document
- [TigerBeetle: Safety](https://docs.tigerbeetle.com/concepts/safety/) — Strict Serializability, ACID compliance
- [Beancount: Language Syntax](https://beancount.github.io/docs/beancount_language_syntax.html) — Transaction flags (`!` for pending entries)

---

## ⚡ Interlude Challenge 3 (after Module 6)

> **Synthesis question**: An ACH debit is initiated on Friday afternoon. Model the complete state machine — from submission through the following Monday — with concrete TigerBeetle field values at each step. Include: the optimistic path (normal settlement), the NSF return path (bank rejects on Monday), and the unauthorized-transaction return path (user disputes 30 days later). For each path, show every Transfer submitted and the final account state.

<details><summary>Discussion</summary>

**Accounts:**
- `user_account`: user's USD balance (Liability, `debits_must_not_exceed_credits`)
- `ach_transit`: internal transit/clearing account
- `ach_returns`: account for returned items

**Friday 4pm — Initiation:**
```
T1 (pending):
  debit:   user_account
  credit:  ach_transit
  amount:  50000  ($500.00)
  flags:   pending
  timeout: 259200  (72h — covers weekend)
  code:    ACH_DEBIT

State: user_account.debits_pending = 50000
       ach_transit.credits_pending = 50000
       user_account.available      = was_500 - 500 = 0
```

**Monday 9am — Path A: Normal settlement:**
```
T2 (post):
  pending_id: T1.id
  amount:     50000
  flags:      post_pending_transfer
  code:       ACH_SETTLEMENT

State: user_account.debits_pending  = 0
       user_account.debits_posted   += 50000
       ach_transit.credits_pending  = 0
       ach_transit.credits_posted   += 50000
```

Final: user owes $500, ACH transit holds $500 for bank sweep.

**Monday 9am — Path B: NSF return:**
```
T2 (void):
  pending_id: T1.id
  flags:      void_pending_transfer
  code:       ACH_RETURN_NSF

State: user_account.debits_pending  = 0  (released)
       ach_transit.credits_pending  = 0  (released)
       — nothing posted. Transaction unwound.
```

**30 days later — Path C: Unauthorized-transaction return (R10):**

At this point T1 has long expired (72h timeout). T1 already settled on Monday (Path A). User disputes.

```
T3 (correcting credit):
  debit:   ach_returns
  credit:  user_account
  amount:  50000
  code:    ACH_RETURN_UNAUTHORIZED
  user_data_128: original_ACH_order_id

State: user_account.credits_posted  += 50000  (user refunded)
       ach_returns.debits_posted     += 50000  (returns bucket debited)
```

This is not a void — the original posting was real and is now reversed by a new correcting transfer. The bank dispute process determines whether `ach_returns` is funded by the merchant or absorbed as a loss.

**Key insight**: The three paths use different mechanisms — post, void, and correcting transfer — because they occur at different stages of the transfer lifecycle. Understanding which mechanism applies requires knowing whether the pending transfer is still active.

</details>
