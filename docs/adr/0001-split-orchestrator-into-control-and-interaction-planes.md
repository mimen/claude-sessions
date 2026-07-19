# Split the orchestrator into a control plane and an interaction plane

The single orchestrator wore two conflicting hats on two different clocks:
a control plane (sense/drain/route/advance/revive, must run on cadence regardless
of humans) and an interaction plane (talks to Milad, human-paced). A turn-based
agent has one clock, and the human turn always won, so it dropped control-plane
hygiene during conversations (0 drains, stale board, stranded decisions) and went
fully dormant (~4 days) when nothing drove it. Two prior data-only fixes (v26
end-of-tick drain, v29 drain-in-sense.sh) failed for this same reason.

Decision: split into two agents above the workers. The **control plane** is
cadence-driven and ACTS on the world; the **interaction plane** (concierge) is
human-driven and SPEAKS to Milad. The line between them is acting vs speaking,
not different jobs. Workers are unchanged.

Considered and rejected: a UserPromptSubmit hook to force hygiene into the
conversational turn (Milad declined — it patches the symptom, forcing hygiene
into a conversation that is not ready for it).
