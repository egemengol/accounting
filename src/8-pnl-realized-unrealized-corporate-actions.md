# P/L, Realized vs Unrealized, and Corporate Actions

## Concept

P/L is not a number you store — it is a number you derive. That derivation requires knowing two things: (1) what you paid for an asset (cost basis), and (2) what you received when you sold it (or what the market says it's worth if you haven't sold yet). Every complexity in this module is a consequence of one of those two quantities being ambiguous.

**The P/L formula**

```
P/L = Sale Proceeds − Cost Basis of Lots Sold
```

For unsold positions:

```
Unrealized P/L = Current Market Value − Cost Basis of Remaining Lots
```

Neither number means anything without understanding *which lots* were sold and *what* the cost basis of those lots was. This is why booking methods exist.

**How Beancount represents realized P/L**

When you sell shares, Beancount removes them from inventory at their acquisition cost — not at the sale price. The difference between sale proceeds and cost basis doesn't balance the transaction on its own. A separate `Income:PnL` leg absorbs the imbalance and becomes the realized gain or loss:

```beancount
; Buy: 10 IBM at $160 each
2024-01-10 * "Buy IBM"
  Assets:Brokerage:IBM   10 IBM {160.00 USD}
  Assets:Brokerage:Cash  -1600.00 USD

; Sell: 3 IBM at $170 each (proceeds = $510)
2024-02-17 * "Sell IBM"
  Assets:Brokerage:IBM   -3 IBM {160.00 USD} @ 170.00 USD
  Assets:Brokerage:Cash   510.00 USD
  Income:PnL                          ; auto-filled: -30.00 USD
```

The `@ 170.00 USD` annotation records the sale price for auditing and price database purposes — Beancount ignores it for balancing. What actually balances the transaction is the fact that you removed inventory at cost ($480) and received $510 in cash. The imbalance is $30, which Beancount auto-fills as `-30.00 USD` in `Income:PnL`. Income accounts are credit-normal: a negative amount is a profit, a positive amount is a loss.

**Unrealized P/L in Beancount**

Unrealized P/L is hypothetical. Your books hold positions at cost basis; they say nothing about current market value unless you tell the system current prices. Beancount's approach:

```beancount
; Price entry — manually or via fetch script
2024-03-01 price IBM  182.00 USD

; Enable the plugin to synthesize unrealized P/L entries
plugin "beancount.plugins.unrealized" "Unrealized"
```

The plugin creates a synthetic transaction at report time:

```
2024-03-01 U "Unrealized gain for 7 units of IBM (price: 182.00, cost: 160.00)"
  Assets:Brokerage:IBM:Unrealized    154.00 USD
  Income:IBM:Unrealized             -154.00 USD
```

This entry is synthetic — it does not represent a real transaction, no money moved. It is injected purely for the P/L report. Remove the plugin and it disappears.

**Commissions and cost basis**

Trading commissions complicate P/L. There are two strategies:

*Simple (separate account)*: book commissions to `Expenses:Commissions`. Subtract separately when computing net P/L. This is an approximation — it understates the P/L in the year of acquisition and overstates it in years of sale because the acquisition commission is not pro-rated across lots.

*Precise (fold into cost basis)*: add the acquisition commission to the position's book value. If you buy 100 shares at $80 with a $10 commission, the per-share cost basis becomes $80.10 instead of $80.00. When 40 shares are sold, exactly $4.04 of acquisition commission is embedded in the cost basis of those shares — automatic pro-ration.

```beancount
2024-01-01 * "Buy 100 ITOT at $80 + $10 commission"
  Assets:Brokerage:ITOT  100 ITOT {80.10 USD}  ; folded commission
  Assets:Brokerage:Cash  -8010.00 USD
```

The $10 commission disappears into the cost basis. No separate `Expenses:Commissions` posting. At sale, the gain is automatically reduced by the pro-rated acquisition commission.

**Corporate actions**

*Stock split 2:1*: Beancount has no native split directive. You empty and recreate the position:

```beancount
2024-06-01 * "2-for-1 stock split"
  Assets:Brokerage:ADSK  -100 ADSK {66.30 USD}
  Assets:Brokerage:ADSK   200 ADSK {33.15 USD}
```

The postings balance ($0 net). Cost basis per share halves; total cost basis is unchanged. If you care about holding period for tax purposes, use dated lots (`{33.15 USD, 2020-01-15}`) so the original acquisition date is preserved on the new lots.

*Dividends (cash)*: no lot matching required — just income:

```beancount
2024-03-15 * "Quarterly dividend"
  Assets:Brokerage:Cash    171.02 USD
  Income:Dividends
```

*Dividends (stock, DRIP)*: the new shares enter inventory at their cost basis (market price on reinvestment date):

```beancount
2024-03-15 * "DRIP — dividend reinvestment"
  Assets:Brokerage:AAPL   0.234 AAPL {182.50 USD}
  Income:Dividends
```

These shares become new lots with their own acquisition date — which matters for long-term/short-term determination at sale.

**TigerBeetle: P/L as a query, not a field**

TigerBeetle does not compute P/L. There is no `realized_gain` field. All value flows through the transfer log. To construct an income statement:

1. Create dedicated accounts for each revenue/expense category (e.g., `pnl_account` for capital gains, `dividend_account` for dividends, `commission_account` for fees).
2. When a sale occurs, issue two linked transfers: one that moves proceeds from the buyer into the user's cash account, one that books the cost basis offset into the P/L account. The net of those two transfers is the realized gain.
3. At report time, call `get_account_balances` on each income/expense account. The balance is the period's P/L.
4. For unrealized P/L: query `get_account_transfers` on the position account to reconstruct cost basis, fetch current market prices from your price feed, and compute the difference in your application layer.

TigerBeetle's transfer log is the source of truth. Your application layer is the computation engine. This is not a limitation — it's a deliberate separation: TigerBeetle ensures the ledger is correct; your code decides what "P/L" means for your product.

---

## Socratic Dialogue

> **Q1**: You sold 3 IBM shares you bought at $160 for $170 each. You write: `Assets:Brokerage:Cash 510.00 USD` and `Assets:Brokerage:IBM -3 IBM {160.00 USD}`. Why doesn't this balance? Where does the $30 go, and what account type does it go to?

<details><summary>Answer</summary>

The debit side: removing inventory valued at 3 × $160 = $480 from `Assets:Brokerage:IBM`. The credit side: receiving $510 into `Assets:Brokerage:Cash`. Net imbalance: $510 − $480 = $30 unaccounted.

The $30 goes to an `Income` account — `Income:CapGains` or `Income:PnL`. Income accounts are credit-normal. A gain is recorded as a *credit* (negative in Beancount's signed notation), which means `-30.00 USD` in the Income leg. This brings the sum of all postings to zero:

```
+510  (Cash received)
-480  (Inventory at cost removed)
-30   (Gain booked to Income)
───
  0   ✓
```

The $30 is not stored as a field on a row somewhere. It emerges from the arithmetic as a consequence of properly recording both sides of the trade.

</details>

---

> **Q2**: What is unrealized P/L, exactly? Is it a real posting in Beancount? Why is it shown separately from realized P/L?

<details><summary>Answer</summary>

Unrealized P/L is the difference between the current market value of a held position and its cost basis. It is *hypothetical* — no transaction has occurred, no money has moved. The position could change value again before any sale.

In Beancount, unrealized P/L is not part of the real transaction log. It is injected by the `beancount.plugins.unrealized` plugin as a *synthetic* transaction at report time, using the most recent `price` entry for the commodity. Remove the plugin and it vanishes. Run the report at a different date and the number changes.

It is shown separately from realized P/L because:
1. Realized P/L is a taxable event (in most jurisdictions). Unrealized P/L is not taxed until sale.
2. Mixing them obscures when income was actually recognized.
3. Unrealized P/L reverses itself — if the position falls back to cost, the unrealized gain disappears. Realized P/L is permanent.

</details>

---

> **Q3**: You bought 100 shares of ITOT at $80 with a $10 acquisition commission. You sell 40 shares at $82 with a $10 sale commission. Compute the realized P/L for this sale under two methods: (a) commission as a separate expense, (b) commission folded into cost basis. Are the numbers different?

<details><summary>Answer</summary>

**(a) Separate expense account:**

```
Proceeds:        40 × $82 = $3,280.00
Cost basis:      40 × $80 = $3,200.00
Gross P/L:                    $80.00
Sale commission:              -$10.00
Acq. commission:              -$10.00  (total, not pro-rated)
Net P/L:                      $60.00  ← wrong allocation
```

This is incorrect. The $10 acquisition commission covers *all* 100 shares. Only 40% applies to this sale: $10 × (40/100) = $4.00. Reporting the full $10 against a 40-share sale over-reports the expense in year 1 and under-reports it in year 2 (when the remaining 60 shares are sold).

**(b) Folded into cost basis:**

```
Per-share cost basis: ($80 × 100 + $10) / 100 = $80.10
Cost of 40 shares:    40 × $80.10 = $3,204.00
Proceeds:             40 × $82   = $3,280.00
Gross P/L:                           $76.00
Sale commission:                     -$10.00
Net P/L:                             $66.00  ← correct allocation
```

Yes, the numbers differ *per period* (though the total P/L across both sales is the same either way). Method (b) allocates the acquisition cost correctly via cost basis. The remaining 60 shares carry $80.10 cost basis, embedding the remaining $6 of acquisition commission automatically — no manual tracking required.

</details>

---

> **Q4**: A stock splits 2:1. You hold 10 shares at $200 cost basis (acquired 2022-01-10). After the split you hold 20 shares at $100 each. You sell 20 shares two years later at $150. Under US tax law, are these short-term or long-term gains? How does your Beancount transaction for the split affect the answer?

<details><summary>Answer</summary>

The holding period for split shares follows the *original acquisition date*, not the split date. The split is not a taxable event — it is a recapitalization. The 20 shares you hold after the split are still considered acquired on 2022-01-10.

If you record the split without dates:

```beancount
2024-06-01 * "2-for-1 split"
  Assets:Brokerage:AAPL  -10 AAPL {200.00 USD}
  Assets:Brokerage:AAPL   20 AAPL {100.00 USD}
```

Beancount loses the original acquisition date. The new lots appear to have been acquired on 2024-06-01 — wrong.

Correct recording with dated lots:

```beancount
2024-06-01 * "2-for-1 split"
  Assets:Brokerage:AAPL  -10 AAPL {200.00 USD, 2022-01-10}
  Assets:Brokerage:AAPL   20 AAPL {100.00 USD, 2022-01-10}
```

Now the holding period is preserved. When sold two years after the original acquisition (2026+), the gain is long-term. If you had failed to include the original date, Beancount would report the split date as acquisition — potentially misclassifying a long-term gain as short-term, with real tax consequences.

</details>

---

> **Q5**: TigerBeetle has no P/L field and no income statement. A VC asks for last quarter's trading revenue from your brokerage app. Describe the exact queries you run and the application-layer computation.

<details><summary>Answer</summary>

**Setup assumption**: your schema designates a `realized_pnl` account per user (or per asset class), credit-normal, `ledger=840` (USD). Every sale books the gain/loss there as part of a linked transfer chain.

**Step 1 — Get realized P/L for the quarter:**

```
get_account_balances([realized_pnl_account_id])
```

The balance of this account is the sum of all credited gains minus all debited losses posted during the account's lifetime. To isolate Q4, use `get_account_transfers` filtered by timestamp range:

```
get_account_transfers(
  account_id: realized_pnl_account_id,
  timestamp_min: Q4_start_ns,
  timestamp_max: Q4_end_ns
)
```

Sum the `amount` fields of all transfers that *credited* this account (sale proceeds booked) minus those that *debited* it (loss postings).

**Step 2 — Unrealized P/L:**

There is no TigerBeetle query for this. You must:

1. Call `get_account_transfers` on each position account, reconstruct the inventory (which lots are still held and at what cost basis).
2. Fetch current market prices from your price feed.
3. Compute `(current_price × quantity) − cost_basis` in application code.

**Step 3 — Income statement line items:**

Each income category (trading gains, dividends, commissions) is a separate TigerBeetle account. The income statement is `get_account_balances` across all of them — one read per account type.

The key insight: TigerBeetle gives you an *immutable, consistent transfer log*. Your application turns that log into semantically meaningful reports. The database guarantees the log is correct; you decide what the log means.

</details>

---

## Exercises

**Exercise 8-A: Commission pro-rating (adversarial)**

You run a brokerage. Users are charged a flat $10 commission per trade regardless of size. A user executes:

- 2024-01-01: Buy 100 ITOT at $80.00 per share. Commission: $10.
- 2024-11-01: Sell 40 ITOT at $82.00 per share. Commission: $10.
- 2025-02-01: Sell 60 ITOT at $84.00 per share. Commission: $10.

(a) Compute the realized P/L for 2024 and 2025 using the *separate expense* method (commissions to `Expenses:Commissions`).

(b) Compute the realized P/L for 2024 and 2025 using the *folded cost basis* method.

(c) Write the Beancount transactions for method (b). Show all postings.

(d) The user's tax advisor says the 2024 P/L is different in methods (a) and (b). Which is correct and why?

<details><summary>Solution</summary>

**(a) Separate expense method:**

2024:
```
Proceeds:       40 × $82.00 = $3,280.00
Cost of goods:  40 × $80.00 = $3,200.00
Gross gain:                     $80.00
Commissions:    $10 (buy) + $10 (sell) = $20.00   ← full buy commission wrongly attributed
Net P/L 2024:                   $60.00
```

2025:
```
Proceeds:       60 × $84.00 = $5,040.00
Cost of goods:  60 × $80.00 = $4,800.00
Gross gain:                    $240.00
Commission:                    -$10.00 (sell)
Net P/L 2025:                  $230.00
```

Total across both years: $60 + $230 = $290.

**(b) Folded cost basis method:**

Per-share cost basis: ($80.00 × 100 + $10) / 100 = **$80.10**

2024:
```
Proceeds:    40 × $82.00 = $3,280.00
Cost basis:  40 × $80.10 = $3,204.00
Gross gain:               $76.00
Sale commission:           -$10.00
Net P/L 2024:              $66.00
```

2025:
```
Proceeds:    60 × $84.00 = $5,040.00
Cost basis:  60 × $80.10 = $4,806.00
Gross gain:               $234.00
Sale commission:           -$10.00
Net P/L 2025:              $224.00
```

Total: $66 + $224 = $290. Same total, different year-by-year allocation.

**(c) Beancount transactions (method b):**

```beancount
2024-01-01 * "Buy 100 ITOT"
  Assets:Brokerage:ITOT   100 ITOT {80.10 USD}
  Assets:Brokerage:Cash  -8010.00 USD

2024-11-01 * "Sell 40 ITOT"
  Assets:Brokerage:ITOT   -40 ITOT {80.10 USD} @ 82.00 USD
  Assets:Brokerage:Cash   3270.05 USD          ; 3280 - 9.95 sale commission
  Expenses:Commissions       9.95 USD
  Income:CapGains                              ; auto-filled: -76.00 USD

2025-02-01 * "Sell 60 ITOT"
  Assets:Brokerage:ITOT   -60 ITOT {80.10 USD} @ 84.00 USD
  Assets:Brokerage:Cash   5020.05 USD          ; 5040 - 9.95
  Expenses:Commissions       9.95 USD
  Income:CapGains                              ; auto-filled: -234.00 USD
```

Note: the sale commission is still booked to `Expenses:Commissions` because it is a period expense of the year in which it occurs (not an acquisition cost). The acquisition commission ($10) was fully folded into cost basis at purchase. The two commissions are treated differently.

**(d) Method (b) is correct:**

The Internal Revenue Service (and most tax authorities) require that acquisition costs be capitalized into the asset's cost basis and pro-rated to the cost of goods sold. Booking the full acquisition commission to the year of sale (method a) is an overstatement of that year's expenses and an understatement of the following year's. The total tax liability is the same in aggregate, but the year-by-year timing differs — which matters for quarterly estimated taxes and can create underpayment penalties.

</details>

---

**Exercise 8-B: Corporate action lifecycle**

You hold the following in `Assets:Brokerage:ACME`:
- 100 ACME {50.00 USD, 2023-03-01}

On 2024-06-01, ACME does a 3-for-2 stock split (every 2 shares become 3). On 2024-09-15, ACME pays a $0.50/share cash dividend. On 2025-01-10, you sell all shares at $40.00.

(a) Write the Beancount transaction for the stock split. Preserve the original acquisition date.

(b) After the split, what is your position? What is the per-share cost basis?

(c) Write the dividend transaction.

(d) Write the sale transaction. Compute realized P/L.

(e) Is this a long-term or short-term gain under US rules (held >1 year)?

<details><summary>Solution</summary>

**(a) Stock split (3-for-2):**

100 shares become 150 shares. Cost basis per share: $50.00 × (2/3) = $33.33 (rounded; exact: 50 × 100 / 150 = $33.3333...).

```beancount
2024-06-01 * "3-for-2 stock split"
  Assets:Brokerage:ACME  -100 ACME {50.00 USD, 2023-03-01}
  Assets:Brokerage:ACME   150 ACME {33.3333 USD, 2023-03-01}
```

The total cost basis is preserved: 150 × $33.3333 = $4,999.99 ≈ $5,000 (rounding artifact — in practice use full precision or adjust one unit to absorb the rounding).

**(b) Position after split:**

```
150 ACME {33.3333 USD, 2023-03-01}
```

Per-share cost basis: $33.3333 USD. Acquisition date: 2023-03-01 (preserved).

**(c) Cash dividend:**

150 shares × $0.50 = $75.00

```beancount
2024-09-15 * "ACME quarterly dividend"
  Assets:Brokerage:Cash    75.00 USD
  Income:Dividends        -75.00 USD
```

Dividends don't affect the cost basis of the shares. They are income in the year received.

**(d) Sale:**

```beancount
2025-01-10 * "Sell all ACME"
  Assets:Brokerage:ACME  -150 ACME {33.3333 USD, 2023-03-01} @ 40.00 USD
  Assets:Brokerage:Cash   6000.00 USD
  Income:CapGains                   ; auto-filled
```

Realized P/L:
```
Proceeds:    150 × $40.00    = $6,000.00
Cost basis:  150 × $33.3333  = $4,999.99
Realized gain:               = $1,000.01
```

`Income:CapGains` is auto-filled as `-1000.01 USD` (credit = gain).

**(e) Long-term or short-term?**

Acquisition date: 2023-03-01. Sale date: 2025-01-10. Holding period: ~22 months. This is well over 12 months → **long-term capital gain**. The split date (2024-06-01) is irrelevant to the holding period — splits don't reset the acquisition clock. This is why preserving the original date on the split transaction matters.

</details>

---

**Exercise 8-C: TigerBeetle income statement for a brokerage**

You are building a brokerage on TigerBeetle. Every user has the following accounts (all `ledger=840`, USD):

```
user_cash      — cash balance (debit-normal, credit_normal=false)
user_positions — aggregate asset value in shares (tracked externally)
realized_pnl   — capital gains account (credit-normal)
dividend_pnl   — dividend income account (credit-normal)
commission_exp — commission expense account (debit-normal)
```

A user buys 10 ACME at $50 (commission $5), then sells 10 ACME at $70 (commission $5), then receives a $15 dividend.

(a) Write the TigerBeetle Transfer sequence for the purchase. The cash debit goes to `user_cash`; a cost-basis credit goes to a `cost_basis_clearing` account.

(b) Write the Transfer sequence for the sale. Show how realized P/L is booked.

(c) Write the dividend Transfer.

(d) After all operations, what is `realized_pnl.credits_posted − realized_pnl.debits_posted`? What does this number represent?

(e) The user wants their YTD income statement. Write pseudocode using TigerBeetle API calls.

<details><summary>Solution</summary>

**(a) Purchase ($500 + $5 commission):**

```
T₁: debit=user_cash, credit=cost_basis_clearing, amount=50000
    code=STOCK_PURCHASE, flags.linked=true
    user_data_128=order_id

T₂: debit=commission_exp, credit=user_cash, amount=500
    code=COMMISSION, flags.linked=false
```

Wait — `commission_exp` is debit-normal (expense). Debiting it increases the expense balance. We debit `user_cash` to reduce the user's cash and credit... actually, we need to think about this as a fintech operator:

The user pays cash → goes to an internal commission account:
```
T₁: debit=user_cash, credit=cost_basis_clearing, amount=50000, linked=true
T₂: debit=user_cash, credit=commission_revenue, amount=500, linked=false
```

`cost_basis_clearing` holds the purchase cost basis ($500) until the shares are sold. `commission_revenue` is the operator's income.

**(b) Sale ($700 proceeds, $5 commission, $200 gain):**

The user receives $700 in cash. The cost basis ($500) is released from clearing. The $200 difference is booked to `realized_pnl`.

```
T₃: debit=cost_basis_clearing, credit=user_cash, amount=50000, linked=true
    ; returns cost basis from clearing → user cash
    code=STOCK_SALE_COST_BASIS

T₄: debit=sale_proceeds_transit, credit=user_cash, amount=20000, linked=true
    ; books the $200 gain — proceeds above cost
    code=STOCK_SALE_GAIN

T₅: debit=sale_proceeds_transit, credit=realized_pnl, amount=20000, linked=true
    ; credits the gain to the P/L account
    code=REALIZED_GAIN

T₆: debit=user_cash, credit=commission_revenue, amount=500, linked=false
    ; commission on sale
    code=COMMISSION
```

Simplified real-world pattern: broker receives gross proceeds from counterparty, nets the cost basis, books gain:

```
T₃: debit=user_cash, credit=realized_pnl, amount=20000, linked=true
    ; book gain: user gets $200 extra above cost
T₄: debit=user_cash, credit=commission_revenue, amount=500, linked=false
    ; commission deducted
```

The exact pattern depends on whether the operator holds positions or routes through a custodian. The key invariant: `realized_pnl.credits_posted` accumulates all gains; `realized_pnl.debits_posted` accumulates all losses.

**(c) Dividend:**

```
T₇: debit=dividend_transit, credit=user_cash, amount=1500
    code=DIVIDEND
    user_data_128=dividend_payment_id

T₈: debit=dividend_expense, credit=dividend_transit, amount=1500
    code=DIVIDEND_BOOKED
```

Or in a simpler model where the operator funds dividends from its own account:

```
T₇: debit=operator_reserve, credit=user_cash, amount=1500, linked=true
T₈: debit=dividend_pnl_expense, credit=operator_reserve, amount=1500, linked=false
```

**(d) `realized_pnl` balance:**

```
credits_posted = 20000  ($200 gain from sale)
debits_posted  = 0      (no losses)
net balance    = credits_posted - debits_posted = 20000
```

This represents $200.00 in realized capital gains for the period. In a credit-normal account, `credits_posted − debits_posted` is the positive balance. A net negative would indicate net losses.

**(e) YTD income statement pseudocode:**

```python
ytd_start = datetime(2025, 1, 1).timestamp_ns()
ytd_end   = now_ns()

# Realized P/L
pnl_transfers = client.get_account_transfers(
    account_id=realized_pnl_id,
    timestamp_min=ytd_start,
    timestamp_max=ytd_end,
)
realized_gain = sum(t.amount for t in pnl_transfers if t.credit_account_id == realized_pnl_id)
realized_loss = sum(t.amount for t in pnl_transfers if t.debit_account_id  == realized_pnl_id)
net_realized  = realized_gain - realized_loss  # in cents

# Dividend income
div_transfers = client.get_account_transfers(
    account_id=dividend_pnl_id,
    timestamp_min=ytd_start,
    timestamp_max=ytd_end,
)
dividend_income = sum(t.amount for t in div_transfers if t.credit_account_id == dividend_pnl_id)

# Commission expense
comm_transfers = client.get_account_transfers(
    account_id=commission_exp_id,
    timestamp_min=ytd_start,
    timestamp_max=ytd_end,
)
commissions_paid = sum(t.amount for t in comm_transfers if t.debit_account_id == commission_exp_id)

income_statement = {
    "realized_capital_gains": net_realized / 100,       # USD
    "dividend_income":        dividend_income / 100,
    "commissions":            -commissions_paid / 100,
    "net_income":             (net_realized + dividend_income - commissions_paid) / 100,
}
```

Note: `get_account_balances` gives lifetime totals; `get_account_transfers` filtered by timestamp is necessary for period-specific reporting. TigerBeetle's transfer timestamps are nanosecond-precision monotonic values — use them for filtering, not application-layer `created_at` columns.

</details>

---

### Source Reading

- `beancountdocs/docs/trading_with_beancount.md` — What is Profit and Loss, Realized and Unrealized P/L, Trade Lots, Booking Methods, Dated lots, Commissions, Stock Splits, Dividends
- `beancountdocs/docs/how_inventories_work.md` — Inventory reduction mechanics, booking method disambiguation
- `beancountdocs/docs/beancount_query_language.md` — Using `bean-query` for P/L reports, COST() aggregation function
- `tigerbeetledocs/coding/financial-accounting/index.html` — Types of Accounts, Income/Expense account model
- `tigerbeetledocs/coding/data-modeling/index.html` — Account struct, `get_account_transfers` for period queries

---

## Interlude: After Module 8

> **Synthesis question**: A hedge fund uses LIFO booking for internal P/L reporting (to management) but is legally required to use FIFO for tax reporting (to the IRS). Can a single Beancount file serve both simultaneously? If not, what is the minimum architecture that does?

<details><summary>Discussion</summary>

**The core problem**: booking method is a property of the *account*, applied at the time of lot reduction. When you record a sale, Beancount matches it against specific lots based on the configured method. The resulting `Income:CapGains` posting reflects the P/L of *those specific lots*. There is no way to simultaneously reduce Lot A (LIFO) and Lot B (FIFO) — a sale reduces exactly one set of lots.

**What a single file cannot do**: a single `Assets:Brokerage:ACME` account with a single booking method cannot produce two different P/L numbers for the same sale. The lot selection is deterministic given the method.

**Minimum architecture: two parallel account trees**

```beancount
; --- LIFO tree (management reporting) ---
2024-01-10 open Assets:LIFO:Brokerage:ACME
2024-01-10 open Income:LIFO:CapGains

; --- FIFO tree (tax reporting) ---
2024-01-10 open Assets:FIFO:Brokerage:ACME
2024-01-10 open Income:FIFO:CapGains
```

Every purchase is entered twice — once into each tree at the same cost basis and date:

```beancount
2024-01-10 * "Buy ACME"
  Assets:LIFO:Brokerage:ACME   100 ACME {50.00 USD, 2024-01-10}
  Assets:FIFO:Brokerage:ACME   100 ACME {50.00 USD, 2024-01-10}
  Assets:Cash                 -10000.00 USD
  Assets:Cash                 -10000.00 USD   ; ← this double-counts cash!
```

Problem: the cash account is shared between both trees. Double-entry holds in each tree, but the cross-tree transaction doesn't balance against a single cash account.

**Solution: use a single cash account, mirror only the position and income legs:**

```beancount
2024-01-10 * "Buy ACME"
  Assets:LIFO:Brokerage:ACME   100 ACME {50.00 USD, 2024-01-10}
  Assets:FIFO:Brokerage:ACME   100 ACME {50.00 USD, 2024-01-10}
  Assets:Cash                 -10000.00 USD
  Equity:MirrorOffset          10000.00 USD  ; absorbs the double-position cost
```

This is ugly. In practice, two separate Beancount files are cleaner — one for LIFO (management), one for FIFO (tax). They share purchase data but diverge at every sale transaction.

**Can Beancount support this natively?** No. Beancount's booking method is a per-account option applied globally — there is no "report this sale under two methods simultaneously" directive. The fund's accounting team must maintain two separate ledgers and reconcile them manually (or via script) at year-end. The scripts that generate the two files from a shared trade blotter are the real engineering problem.

**TigerBeetle angle**: TigerBeetle has no booking method. You maintain two separate `cost_basis_clearing` accounts (one LIFO-managed, one FIFO-managed) and write application code that, for each sale, looks up lots under the appropriate method and issues linked transfers to the correct clearing account. The two clearing accounts diverge in balance over time — their difference at year-end is the cumulative difference in realized P/L between the two methods.

**Key takeaway**: dual-method accounting is not a single-ledger problem. It is a two-ledger problem with a shared trade blotter and diverging lot-selection logic. Any system claiming to do both simultaneously with a single account tree is computing an approximation, not a precise dual-method ledger.

</details>
