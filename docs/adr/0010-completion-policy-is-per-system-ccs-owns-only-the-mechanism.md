# Completion is a per-system POLICY; ccs owns only the lifecycle mechanism

Deciding when a fleet worker (planet) is done needs a condition. For the pr-watch
system that condition is: merged AND deployed-to-prod AND confirmed-live, where
"confirmed-live" is a MECHANICAL deploy-contains-this-SHA sensor (not a human gate;
a human eyes-on-prod check would strand every PR on a manual step). A specific risky
PR can opt into a human confirmation, but the default is mechanical.

Milad's constraint (2026-07-08): that condition is SPECIFIC TO THIS SYSTEM. If the
same catalogue/resume machinery extends to another system (event-watch), its
planets complete on totally different conditions (an event ships, a reveal week
ends) — "deployed to prod" is meaningless there.

Decision: split mechanism from policy.
- **ccs owns the MECHANISM only** — the lifecycle states (idle/parked/completed/
  archived), `ccs mark --completed/--archived`, and `ccs resume <system>` excluding
  completed+archived. ccs must NOT know what "deployed to prod" means or hardcode
  any completion rule. It stays general across systems.
- **Each SYSTEM owns its completion POLICY** — the condition that decides WHEN to
  call `ccs mark --completed`. pr-watch's control plane evaluates merged AND
  deployed AND live (its own sensors) and then marks the planet completed as part
  of the merge/close flow. event-watch would evaluate its own condition and call
  the same `ccs mark`. The policy lives in the system's control layer, never in ccs.

Consequence: pr-watch needs a NEW prod-deploy sensor (deploy_freshness.py only
covers review-app deploys, not "did this land in prod"). completion = merged
(poll.py) AND prod-deploy-contains-SHA (new sensor). The mark itself is mechanical
(pre-authorized, same trigger as closing the GUS ticket, per the mechanical-vs-ask
ledger).
