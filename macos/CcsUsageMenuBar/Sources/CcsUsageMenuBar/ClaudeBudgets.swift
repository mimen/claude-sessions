import Foundation

/// Which meter is the lower ceiling: the budget's own cap, or the weekly pool it nests inside.
enum BudgetBinding: Equatable { case ownCap, sharedPool }

enum AllocationUsage: Equatable {
    case known(usedPct: Double, resetsAt: Date?, cached: Bool, binding: BudgetBinding)
    case unknown(reason: String)
}

/// Display budgets stay separate from provider limits and overall usage.
struct ClaudeBudget: Equatable, Identifiable {
    enum Name: String { case fable = "Fable budget", nonFable = "Non-Fable budget" }
    let name: Name
    let usage: AllocationUsage
    var id: String { name.rawValue }
}

/// Mirrors src/usage/claude-budgets.ts for one account at a time.
enum ClaudeBudgets {
    private static func percentage(_ o: UsageObservation?) -> Double? {
        guard let o, let used = o.used, let limit = o.limit, limit > 0 else { return nil }
        // Multiply before dividing, as the CLI does, so whole-number readings stay exact.
        let pct = used * 100 / limit
        return pct.isFinite && pct >= 0 ? pct : nil
    }

    private static func cached(_ o: UsageObservation) -> Bool { o.stale == true }

    private static func sameReset(_ l: Date?, _ r: Date?) -> Bool {
        guard let l, let r else { return false }
        return floor(l.timeIntervalSince1970) == floor(r.timeIntervalSince1970)
    }

    /// The CLI compares parsed millisecond timestamps, so two missing observation times
    /// (NaN !== NaN) read as differing. Mirror that: a missing time on either side means
    /// the two readings can't be proven simultaneous.
    private static func observationsAlign(_ a: UsageObservation, _ b: UsageObservation) -> Bool {
        guard let ao = a.observedAt, let bo = b.observedAt else { return false }
        return ao == bo
    }

    /// The Fable budget compares two readings, so it carries the guards that make the
    /// comparison meaningful. Reporting the Fable cap without the weekly pool it nests
    /// inside would hide an already exhausted account, so a missing weekly reading is unknown.
    private static func fableBudget(fable: UsageObservation?, fablePct: Double?,
                                    weekly: UsageObservation?, weeklyPct: Double?) -> AllocationUsage {
        guard let fable, let fablePct else { return .unknown(reason: "Fable reading unavailable") }
        guard let weekly, let weeklyPct else { return .unknown(reason: "weekly reading unavailable") }
        guard observationsAlign(weekly, fable) else { return .unknown(reason: "observation times differ") }
        guard sameReset(weekly.resetsAt, fable.resetsAt) || (fablePct == 0 && fable.resetsAt == nil) else {
            return .unknown(reason: "reset windows differ")
        }
        // A Fable request spends the shared weekly pool too, so the fuller meter is the real
        // ceiling. Taking the larger of two real readings can only report a number one of
        // them published.
        let ownCap = fablePct >= weeklyPct
        return .known(usedPct: ownCap ? fablePct : weeklyPct,
                      resetsAt: ownCap ? fable.resetsAt : weekly.resetsAt,
                      cached: cached(fable) || cached(weekly),
                      binding: ownCap ? .ownCap : .sharedPool)
    }

    static func compute(_ rows: [UsageObservation]) -> [ClaudeBudget] {
        let weeklyRows = rows.filter {
            $0.metric == "allowance" && $0.window == "weekly" && !$0.entitlement.contains("#")
        }
        let fableRows = rows.filter {
            $0.metric == "allowance" && $0.window == "weekly" && $0.entitlement.lowercased().hasSuffix("#fable")
        }
        if weeklyRows.count > 1 || fableRows.count > 1 { return [] }
        let weekly = weeklyRows.first
        let fable = fableRows.first
        if weekly == nil && fable == nil { return [] }
        if let weekly, let fable {
            let base = fable.entitlement.split(separator: "#", maxSplits: 1).first.map(String.init) ?? fable.entitlement
            if base != weekly.entitlement { return [] }
        }

        let weeklyPct = percentage(weekly)
        let fablePct = percentage(fable)

        // A non-Fable request spends only the shared weekly pool, so that one reading is the
        // whole budget and no cross-reading guard applies to it.
        let nonFableUsage: AllocationUsage
        if let weekly, let weeklyPct {
            nonFableUsage = .known(usedPct: weeklyPct, resetsAt: weekly.resetsAt,
                                   cached: cached(weekly), binding: .sharedPool)
        } else {
            nonFableUsage = .unknown(reason: "weekly reading unavailable")
        }

        return [ClaudeBudget(name: .fable,
                             usage: fableBudget(fable: fable, fablePct: fablePct,
                                                weekly: weekly, weeklyPct: weeklyPct)),
                ClaudeBudget(name: .nonFable, usage: nonFableUsage)]
    }
}
