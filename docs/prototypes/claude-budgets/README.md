# Claude budget preview

A standalone prototype of the numbers-only 50/50 Fable and Opus allocation view. Opus includes all non-Fable Claude models. This reflects the user's revised direction, not the earlier nested-cap recommendation in the separate proposal.

From the repository root:

```sh
python3 -m http.server 8794 --bind 127.0.0.1 --directory docs/prototypes/claude-budgets
```

Open http://127.0.0.1:8794. The HTML also works directly from disk.

The Example selector covers a typical week, Fable fully used, Opus above its allocation, the subscription fully used, unequal account capacities, and a missing Fable reading. The Accounts selector filters both the summary and account table.

## Data contract

Each sample account contains `capacity`, `totalUsed`, and nullable `fableUsed`, all in comparable weekly capacity units. These are synthetic inputs, not provider percentages, token counts, or API-equivalent costs.

- Each allocation is `capacity / 2`.
- Opus used is `totalUsed - fableUsed`.
- Allocation usage is group usage divided by that group's allocation.
- The summary adds selected accounts' usage and capacity before calculating percentages.
- Missing Fable attribution makes both split percentages unknown. Known total remaining is still shown.
- Bars stop at 100%. Numeric usage can exceed 100% without warning colors, advice, or negative allocation remainders.
- Subscription remaining is computed from total capacity and total usage once. It is not the sum of clamped allocation remainders.

Live integration needs verified model attribution, comparable capacity units, and matching reset windows. The prototype does not access credentials, contact providers, change account routing, or estimate quotas from transcript costs.
