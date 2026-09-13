import Foundation

enum AllocationUsage: Equatable {
    case known(usedPct: Double, resetsAt: Date?, cached: Bool)
    case unknown(reason: String)
}

/// Display allocations stay separate from provider limits and overall usage.
struct ClaudeBudget: Equatable, Identifiable {
    enum Name: String { case fable = "Fable budget", opus = "Opus budget" }
    let name: Name
    let usage: AllocationUsage
    var id: String { name.rawValue }
}

/// Mirrors src/usage/claude-budgets.ts for one account at a time.
enum ClaudeBudgets {
    private static func percentage(_ o: UsageObservation?) -> Double? {
        guard let o, let used = o.used, let limit = o.limit, limit > 0 else { return nil }
        let pct = used / limit * 100
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

        let fableUsage: AllocationUsage
        if let fable, let fablePct {
            fableUsage = .known(usedPct: fablePct, resetsAt: fable.resetsAt, cached: cached(fable))
        } else {
            fableUsage = .unknown(reason: "Fable reading unavailable")
        }

        let opusUsage: AllocationUsage
        if let fable, let fablePct, let weekly, let weeklyPct {
            if cached(weekly) || cached(fable) {
                opusUsage = .unknown(reason: "cached readings")
            } else if !observationsAlign(weekly, fable) {
                opusUsage = .unknown(reason: "observation times differ")
            } else if !sameReset(weekly.resetsAt, fable.resetsAt) && !(fablePct == 0 && fable.resetsAt == nil) {
                opusUsage = .unknown(reason: "reset windows differ")
            } else {
                // The user's 50/50 allocation model: Opus is all non-Fable weekly use,
                // estimated against its half of the allowance. Not a provider-reported quota.
                let opusPct = 2 * weeklyPct - fablePct
                opusUsage = opusPct < 0
                    ? .unknown(reason: "inconsistent 50/50 readings")
                    : .known(usedPct: opusPct, resetsAt: weekly.resetsAt, cached: false)
            }
        } else if fable == nil || fablePct == nil {
            opusUsage = .unknown(reason: "Fable reading unavailable")
        } else {
            opusUsage = .unknown(reason: "weekly reading unavailable")
        }

        return [ClaudeBudget(name: .fable, usage: fableUsage),
                ClaudeBudget(name: .opus, usage: opusUsage)]
    }
}
