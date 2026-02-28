# Multi-Currency and Commodities

## Concept

A "currency" is a unit of measure. The conservation invariant — `sum(postings) = 0` — holds *within* a unit, not across units. 100 USD and 100 EUR are not the same thing. You cannot add them. Any system that allows cross-unit arithmetic without an explicit conversion is broken.

**Beancount: the Inventory**

An account in Beancount holds an `Inventory`: a mapping from `(commodity, cost_basis, acquisition_date)` tuples to quantities. Unlike plain numbers, lots are kept separate because their cost basis determines P/L at sale time.

A purchase of stock creates an inventory position:

```beancount
2024-01-15 * "Buy AAPL"
  Assets:Brokerage:AAPL   10 AAPL {175.00 USD}
  Assets:Brokerage:Cash  -1750.00 USD

2024-06-01 * "Buy more AAPL"
  Assets:Brokerage:AAPL   10 AAPL {200.00 USD}
  Assets:Brokerage:Cash  -2000.00 USD
```

The inventory of `Assets:Brokerage:AAPL` is now two *distinct* lots, not one merged position:

```
  10 AAPL {175.00 USD, 2024-01-15}
  10 AAPL {200.00 USD, 2024-06-01}
```

They cannot be merged because they have different cost bases — and that difference determines how much tax you owe when you sell.

**Booking methods** resolve which lot gets reduced on a sale when the match is ambiguous:

| Method | Rule |
|--------|------|
| `STRICT` | Error if ambiguous. You must specify the lot explicitly. |
| `FIFO` | Reduce oldest lots first. |
| `LIFO` | Reduce newest lots first. |
| `AVERAGE` | Merge all lots into one with averaged cost. No lot-level history. |
| `NONE` | Append everything; no matching attempted. For non-taxable accounts. |

The choice of booking method changes reported income — and therefore tax liability — by potentially large amounts on the same underlying trades.

**Currency exchange in Beancount** uses a price annotation:

```beancount
2024-03-01 * "Convert USD to EUR"
  Assets:Bank:EUR   920.00 EUR @ 1.0870 USD
  Assets:Bank:USD  -1000.00 USD
```

The `@ 1.0870 USD` annotation is the *price* (spot rate at time of transaction). The `{ }` syntax is for *cost basis*. Price annotations are used for reporting; cost basis annotations are used for P/L tracking. They're different things.

**TigerBeetle: Ledgers as Currency Partitions**

In TigerBeetle, `ledger` is a u32 field on both Account and Transfer that acts as a namespace for currency. Transfers between accounts on *different* ledgers are **rejected** — the database enforces the unit boundary structurally.

```
Account:
  id:     1001
  ledger: 840    // ISO 4217: USD
  code:   100    // application-defined: "user account"

Account:
  id:     1002
  ledger: 978    // ISO 4217: EUR
  code:   100
```

A transfer from account 1001 to account 1002 fails: different ledgers. There is no "exchange rate" concept at the database layer. That logic lives in your application.

**Cross-currency pattern: four accounts, two linked transfers**

```
Accounts involved:
  A₁  — user's USD account  (ledger: 840)
  L₁  — LP's USD account    (ledger: 840)   ← liquidity provider source
  L₂  — LP's EUR account    (ledger: 978)   ← liquidity provider destination
  A₂  — user's EUR account  (ledger: 978)

Transfer sequence:
  T₁: debit A₁, credit L₁, amount=100000 (USD, $1000.00), flags.linked=true
  T₂: debit L₂, credit A₂, amount=92000  (EUR,  €920.00), flags.linked=false
```

T₁ and T₂ are atomic via `flags.linked`. Either both commit or neither does. The exchange rate is implicit in the amounts. The liquidity provider holds two accounts — one per currency — and the net movement across both ledgers keeps them square.

**Spread**: Record exchange rate and fee as separate linked transfers rather than baking the spread into the rate. This makes the exchange rate and fee independently auditable.

```
T₁: A₁ → L₁, amount=100000, flags.linked=true   (principal)
T₂: A₁ → L₁, amount=100,    flags.linked=true   (fee: $1.00)
T₃: L₂ → A₂, amount=92000,  flags.linked=false  (EUR delivery)
```

---

## Socratic Dialogue

> **Q1**: TigerBeetle rejects transfers between accounts on different ledgers. Why isn't this just an application-layer rule? Why does it belong in the database?

<details><summary>Answer</summary>

For the same reason you enforce foreign key constraints in the database rather than in your app: consistency cannot be optional. If only application code enforces the ledger boundary, a bug, a direct DB write, a race condition, or a future engineer who didn't know the rule can violate it silently.

A cross-ledger transfer that gets through would create a debit in USD and a credit in EUR — units that don't cancel. The trial balance becomes `sum(all_postings) = 0` in each ledger independently, but you can no longer check this property globally. The structural invariant has a hole in it.

Database-level enforcement means: it is *impossible* for the invariant to be violated, not merely *unlikely*.

</details>

---

> **Q2**: Beancount's inventory keeps lots separate. What information is lost if you merge all lots of the same commodity into a single quantity at average cost?

<details><summary>Answer</summary>

You lose:
1. **Acquisition date per lot** — required for long-term vs short-term capital gains determination (e.g., the 12-month holding period in US tax law).
2. **Cost basis per lot** — required to compute per-lot P/L. With average cost, you only know the blended P/L across all lots, which may be legally incorrect if the jurisdiction requires lot-specific reporting.
3. **The ability to choose specific lots** — specific identification lets you choose which lot to sell to minimize taxes (e.g., sell the highest-cost lot to minimize realized gain). Averaging collapses this choice.

The `AVERAGE` booking method is appropriate for tax-sheltered accounts (401k, RRSP) where individual lot taxation doesn't matter, not for taxable brokerage accounts.

</details>

---

> **Q3**: The exchange rate at the moment of a USD→EUR conversion is 1.0000 USD = 0.9200 EUR. T₁ debits $1000 from the user. T₂ credits the user with €920. These two transfers are *not* linked. T₁ posts. T₂ fails (EUR account not found — bug in account creation flow). What is the financial state? What has been violated?

<details><summary>Answer</summary>

Financial state:
- User's USD account: `debits_posted += $1000` (user is out $1000)
- User's EUR account: no credit (€0 received)
- Liquidity provider's USD account: `credits_posted += $1000` (LP received $1000)
- Liquidity provider's EUR account: unchanged

The user has lost $1000 and received nothing. The conservation invariant is violated *across the two-transfer operation* (not within either individual ledger — each ledger still balances, but the economic intent — trade $1000 for €920 — has half-executed).

What has been violated is **atomicity of the exchange**. The two transfers were supposed to be a single economic unit but were not made atomic. This is exactly what `flags.linked` prevents: if T₂ fails, T₁ is rolled back. Non-linked transfers don't share fate.

Detection: reconcile your LP's USD account (received $1000) against EUR delivery account (sent €0). The imbalance shows up there.

Fix: manually issue T₂ as a correcting credit, or void the operation and reissue the full amount. There's no mechanical fix — you have to know it happened.

</details>

---

> **Q4**: A Beancount account is opened with `option "booking_method" "STRICT"`. You attempt to sell 10 shares of HOOL with an empty lot spec `{}`, and the account contains two lots at different prices. What happens? How do you fix it?

<details><summary>Answer</summary>

Beancount raises an error: ambiguous reduction. Under `STRICT`, it refuses to guess which lot to reduce.

Fix options:
1. Specify the cost basis: `Assets:Invest -10 HOOL {23.00 USD}` — matches the lot at that price.
2. Specify the acquisition date: `Assets:Invest -10 HOOL {2015-04-01}` — matches by date.
3. Specify a label if you labeled the lot at purchase: `Assets:Invest -10 HOOL {"first-lot"}`.
4. Change the account's booking method to `FIFO` or `LIFO` if automatic selection is acceptable.

The error is a *feature*, not a bug. `STRICT` forcing you to be explicit ensures that P/L is computed against the lot you actually intend to reduce, which may have significant tax implications.

</details>

---

> **Q5**: A user has a USD account and an EUR account in TigerBeetle. They want to convert €500 to USD. How many TigerBeetle accounts are involved in this operation at minimum? What determines the exchange rate?

<details><summary>Answer</summary>

Minimum four accounts:
1. `user_eur` — user's EUR account (ledger: EUR)
2. `lp_eur` — liquidity provider's EUR account (ledger: EUR)
3. `lp_usd` — liquidity provider's USD account (ledger: USD)
4. `user_usd` — user's USD account (ledger: USD)

```
T₁: debit user_eur, credit lp_eur, amount=50000 (€500.00), linked=true
T₂: debit lp_usd,   credit user_usd, amount=54350 ($543.50), linked=false
```

The exchange rate is determined entirely by the *amounts* your application sets on T₁ and T₂. TigerBeetle has no opinion. The ratio `54350 / 50000 = 1.087` implies a rate of 1 EUR = 1.087 USD. If you change the amounts, you change the effective rate. The database enforces conservation within each ledger; the rate between ledgers is your application's responsibility.

</details>

---

## Exercises

**Exercise 7-A: The split transaction (core adversarial hook)**

You submit the following two TigerBeetle transfers as *separate non-linked requests* (not in the same batch, not with `flags.linked`):

```
T₁: debit=user_usd (ledger:840), credit=lp_usd (ledger:840), amount=10000
T₂: debit=lp_eur  (ledger:978), credit=user_eur (ledger:978), amount=9200
```

T₁ posts successfully. T₂ fails: `lp_eur` account doesn't exist yet (not created).

(a) What is the exact state of every account involved?
(b) How do you detect this inconsistency automatically?
(c) What are your recovery options? For each, state what Transfer(s) you issue.
(d) Had these been linked (`T₁.flags.linked = true`), what would have happened instead?

<details><summary>Solution</summary>

**(a) Account states after failure:**

| Account | Δ debits_posted | Δ credits_posted | Net |
|---------|-----------------|------------------|-----|
| `user_usd` | +10000 | 0 | -$100.00 (user lost) |
| `lp_usd`   | 0 | +10000 | +$100.00 (LP gained USD) |
| `lp_eur`   | — | — | account doesn't exist |
| `user_eur`  | 0 | 0 | unchanged |

Conservation within each ledger holds: USD ledger balances (lp_usd received what user_usd sent). EUR ledger was never touched. But the *economic transaction* — a currency exchange — is half-executed.

**(b) Detection:**

Reconcile your liquidity provider's position. `lp_usd.credits_posted` should always be matched by a corresponding `lp_eur.debits_posted` (at the exchange rate). Query `get_account_transfers` on `lp_usd` filtered by `code=CURRENCY_EXCHANGE` and join against EUR deliveries. Any USD receipt without a corresponding EUR delivery is a stuck exchange.

You can also build this as a balance assertion: the LP should be net-zero on exchanges (received USD = delivered EUR * rate). If not, there's an unmatched leg.

**(c) Recovery options:**

**Option 1 — Complete the exchange (if EUR account now exists or can be created):**
```
T₃: debit=lp_eur, credit=user_eur, amount=9200
    user_data_128: original_order_id   // links to the original order
    code: CURRENCY_EXCHANGE_COMPLETION
```
The exchange is completed. The LP's positions become square. This is correct if the exchange rate is still acceptable and the user wants the EUR.

**Option 2 — Reverse the exchange (refund USD):**
```
T₃: debit=lp_usd, credit=user_usd, amount=10000
    user_data_128: original_order_id
    code: CURRENCY_EXCHANGE_REVERSAL
```
The user gets their USD back. The LP returns to original state. Use this if the EUR delivery cannot be completed and the user wants their money back.

Both are *new* Transfers. You cannot modify or delete T₁ — it's immutable.

**(d) Linked behavior:**

With `T₁.flags.linked = true` and T₂ in the same batch, if T₂ fails, T₁ is rolled back atomically. Neither transfer posts. All accounts remain unchanged. This is the correct design — the entire exchange is an atomic unit and either both legs commit or neither does.

**Key design rule**: any operation that spans multiple ledgers must use `flags.linked`. Non-linked multi-ledger operations are structurally racy and create half-executed states that require manual reconciliation.

</details>

---

**Exercise 7-B: Booking method P/L comparison**

You hold AAPL in a taxable account:
- Lot A: 10 shares purchased at $150.00 (2023-01-10)
- Lot B: 10 shares purchased at $200.00 (2024-01-10)

AAPL is currently at $180. You sell 10 shares today (2025-01-15).

(a) Compute realized P/L under FIFO, LIFO, and average cost.
(b) In the US, Lot A qualifies for long-term capital gains (held >1 year); Lot B does not (held <1 year as of the sale date — wait, check). Recalculate which lots qualify.
(c) Write the Beancount transaction for each method. Show the `Income:CapGains` posting.
(d) Which method minimizes your tax bill and why?

<details><summary>Solution</summary>

**(a) Realized P/L:**

Proceeds: 10 × $180 = $1,800

| Method | Lot(s) sold | Cost basis | Realized P/L |
|--------|-------------|------------|--------------|
| FIFO | Lot A (10 × $150) | $1,500 | **+$300** |
| LIFO | Lot B (10 × $200) | $2,000 | **−$200** |
| Average | (10 × $175 avg) | $1,750 | **+$50** |

Average cost = ($1,500 + $2,000) / 20 shares = $175.00/share.

**(b) Long-term vs short-term:**

Sale date: 2025-01-15.
- Lot A purchased 2023-01-10 → held ~2 years → **long-term** (lower US tax rate)
- Lot B purchased 2024-01-10 → held ~1 year and 5 days → **long-term** (just barely, >365 days)

Both lots qualify for long-term treatment. The rate difference argument still applies if Lot B's purchase date were, say, 2024-07-10 (< 1 year). In that scenario Lot B would be short-term.

**(c) Beancount transactions:**

FIFO (sell Lot A):
```beancount
2025-01-15 * "Sell 10 AAPL (FIFO)"
  Assets:Brokerage:AAPL   -10 AAPL {150.00 USD, 2023-01-10}
  Assets:Brokerage:Cash  1800.00 USD
  Income:CapGains:LongTerm  -300.00 USD
```

LIFO (sell Lot B):
```beancount
2025-01-15 * "Sell 10 AAPL (LIFO)"
  Assets:Brokerage:AAPL   -10 AAPL {200.00 USD, 2024-01-10}
  Assets:Brokerage:Cash  1800.00 USD
  Income:CapGains:LongTerm  200.00 USD   ; loss — negative income
```

Note: `Income` accounts are credit-normal; a gain is a credit (negative in Beancount's signed notation), a loss is a debit (positive). This can be confusing — verify that postings sum to zero.

Average cost (requires `AVERAGE` booking or manual calculation):
```beancount
2025-01-15 * "Sell 10 AAPL (avg cost)"
  Assets:Brokerage:AAPL   -10 AAPL {175.00 USD}
  Assets:Brokerage:Cash  1800.00 USD
  Income:CapGains:LongTerm   -50.00 USD
```

**(d) Tax minimization:**

LIFO produces a **$200 loss**, which can offset other capital gains (or up to $3,000 of ordinary income in the US). If you have other gains to offset, LIFO is best.

If you have no gains to offset, FIFO's $300 gain at long-term rates (15% for most brackets) costs $45 in tax — still much less than the LIFO loss has value as an offset.

If you *want* to realize gains (e.g., to reset cost basis before year-end at low tax rates), FIFO is best.

**The deeper point**: the choice of booking method doesn't change the underlying economic position (you own the same shares either way), but it changes *which* tax obligation you realize *now* versus *later*. This is why lot-level tracking is legally required in taxable accounts and why `STRICT` booking is the safest default.

</details>

---

**Exercise 7-C: Multi-currency account schema design**

A neobank lets users hold balances in USD, EUR, and GBP simultaneously. Design the minimal TigerBeetle account schema for one user. Then model a user converting $500 USD to €460 EUR through the bank's internal LP, with a $2 fee.

(a) List all accounts (with their ledger values).
(b) Write the full linked Transfer sequence, with `flags.linked` correctly set on each.
(c) After the conversion, what is the state of the LP's USD and EUR accounts? Is the LP square?

<details><summary>Solution</summary>

**(a) Accounts:**

For one user:
```
user_usd  (ledger: 840, code: USER_BALANCE)
user_eur  (ledger: 978, code: USER_BALANCE)
user_gbp  (ledger: 826, code: USER_BALANCE)
```

For the internal LP (one set, shared across all users):
```
lp_usd  (ledger: 840, code: LP_ACCOUNT)
lp_eur  (ledger: 978, code: LP_ACCOUNT)
lp_gbp  (ledger: 826, code: LP_ACCOUNT)
```

For revenue tracking:
```
fee_usd  (ledger: 840, code: REVENUE)
```

Total per currency: 3 account types × 3 currencies = 9 accounts minimum (LP and fee could be shared but user accounts are per-user).

**(b) Transfer sequence for $500 → €460 with $2 fee:**

Amounts as integers (cents): $500.00 = 50000, €460.00 = 46000, $2.00 = 200.

```
T₁: debit=user_usd, credit=lp_usd,   amount=50000, ledger=840
    flags.linked = true
    code = FX_PRINCIPAL

T₂: debit=user_usd, credit=fee_usd,  amount=200,   ledger=840
    flags.linked = true
    code = FX_FEE

T₃: debit=lp_eur,   credit=user_eur, amount=46000, ledger=978
    flags.linked = false   (last in chain)
    code = FX_DELIVERY
```

All three are submitted in one batch. T₁ and T₂ must both have `flags.linked = true`. T₃ must have `flags.linked = false` (it's the last transfer). If any fails, all are rolled back.

The fee is recorded separately (T₂) rather than folded into the exchange rate, so the rate ($500 → €460, i.e., 1 USD = 0.92 EUR) is auditable independently of the revenue.

**(c) LP account state after conversion:**

| Account | Δ credits_posted | Δ debits_posted | Net effect |
|---------|-----------------|-----------------|------------|
| `lp_usd` | +50000 | 0 | LP received $500 |
| `lp_eur` | 0 | +46000 | LP delivered €460 |

Is the LP square? In USD terms: received $500, delivered €460 (worth ~$500 at the 0.92 rate). At exactly the quoted rate, yes — the LP breaks even on the exchange. The $2 fee goes to `fee_usd`, not to the LP. If the bank operates the LP, it profits from the fee; if an external LP is used, a separate settlement process reconciles the LP's cross-currency exposure.

The LP's net position across ledgers is always non-zero in raw numbers (it holds USD, owes EUR delivery obligations). Squareness is checked by application logic against the current market rate, not by TigerBeetle — which only enforces within-ledger conservation.

</details>

---

### Source Reading

- `beancountdocs/docs/how_inventories_work.md` — Introduction through Summary (booking methods, augmentation vs reduction, FIFO/LIFO/AVERAGE/NONE)
- `beancountdocs/docs/trading_with_beancount.md` — Trade Lots, Dated lots, booking method selection
- `beancountdocs/docs/beancount_design_doc.md` — Number, Commodity, Amount, Lot, Position, Inventory sections
- `tigerbeetledocs/coding/data-modeling/index.html` — Ledgers section, multi-currency accounts
- `tigerbeetledocs/coding/recipes/currency-exchange/index.html` — Data Modeling, Example, Spread

---

## Interlude: After Module 6

> **Synthesis question**: An ACH debit is initiated Friday afternoon. Model the complete state machine — `(pending → posted)` or `(pending → voided)` — with concrete TigerBeetle account states through the following Monday. Include the account balances at each state transition. Assume: user has $500 available, the ACH amount is $300, NSF return arrives Monday morning.

<details><summary>Discussion</summary>

**Account setup:**
```
user_account:    ledger=840, flags=debits_must_not_exceed_credits
ach_transit:     ledger=840  (clearing account, no balance flags)
```

**Friday 3:30pm — Submission:**
```
T₁ (pending):
  debit:   user_account
  credit:  ach_transit
  amount:  30000
  flags:   pending
  timeout: 259200  (72 hours)
  code:    ACH_INITIATED
```

State:
```
user_account:  credits_posted=50000, debits_pending=30000
               available = 50000 - 0 - 30000 = 20000
ach_transit:   credits_pending=30000
```

**Friday → Saturday → Sunday (weekend — no banking activity):**

T₁ is still pending. `debits_pending` holds the $300 reserved. The user cannot spend it (available = $200). The 72-hour timeout has not elapsed.

**Monday 9am — NSF return (bank confirms insufficient funds):**
```
T₂ (void):
  pending_id: T₁.id
  flags:      void_pending_transfer
  code:       ACH_RETURN_R01
```

State after void:
```
user_account:  credits_posted=50000, debits_pending=0
               available = 50000 (restored)
ach_transit:   credits_pending=0
```

Nothing was posted. The $300 was never moved. The user's account is back to where it started.

**Monday 9am — Successful settlement (alternative path):**
```
T₂ (post):
  pending_id: T₁.id
  amount:     30000
  flags:      post_pending_transfer
  code:       ACH_SETTLED
```

State after post:
```
user_account:  credits_posted=50000, debits_posted=30000, debits_pending=0
               available = 50000 - 30000 = 20000
ach_transit:   credits_posted=30000, credits_pending=0
```

The $300 is now permanently moved. The ach_transit account holds $300 awaiting bank sweep.

**Key timing insight**: the 72-hour timeout on T₁ ensures that if neither post nor void arrives (e.g., the ACH processor crashes), the pending transfer auto-expires and funds are released. The user is not left with permanently frozen funds due to a downstream system failure. This is the "auto-void after timeout" guarantee from Module 6.

</details>
