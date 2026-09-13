# Claude budget preview

A standalone prototype of the numbers-only 50/50 Fable and Opus allocation view. Opus includes all non-Fable Claude models. This reflects the user's revised direction, not the earlier nested-cap recommendation in the separate proposal.

From the repository root:

```sh
python3 -m http.server 8794 --bind 127.0.0.1 --directory docs/prototypes/claude-budgets
```

Open http://127.0.0.1:8794. The HTML also works directly from disk.

Each account has its own card with Fable usage, Opus usage, subscription remaining, and its reset time. There is no combined view, account selector, or cross-account total. Cards sit side by side on wide screens and stack on narrow screens.

The Example selector covers a typical week, Fable fully used, Opus above its allocation, the subscription fully used, unequal account capacities, and a missing Fable reading.

## Data contract

Each sample account contains `capacity`, `totalUsed`, and nullable `fableUsed`, all in comparable weekly capacity units. These are synthetic inputs, not provider percentages, token counts, or API-equivalent costs.

- Each allocation is `capacity / 2`.
- Opus used is `totalUsed - fableUsed`.
- Allocation usage is group usage divided by that group's allocation.
- Every percentage uses only that account's usage and capacity. Nothing is combined across accounts.
- Missing Fable attribution makes that account's split percentages unknown. Its known subscription remaining is still shown, and the other account is unaffected.
- Bars stop at 100%. Numeric usage can exceed 100% without warning colors, advice, or negative allocation remainders.
- Subscription remaining is computed from total capacity and total usage once. It is not the sum of clamped allocation remainders.

Live integration needs verified model attribution, comparable capacity units, and matching reset windows. The prototype does not access credentials, contact providers, change account routing, or estimate quotas from transcript costs.
