import Foundation

struct PlanInfo: Equatable {
    let name: String
    let dollars: Double
}

/// Dollar-weighted overall used fractions (0...1) for the two headline windows.
/// Either is nil when no account reports a reading of that kind.
struct OverallReading: Equatable {
    let fiveHour: Double?
    let sevenDay: Double?
}

struct UsageSection: Identifiable, Equatable {
    let provider: String
    let account: String?
    let subscription: SubscriptionInfo?
    let gauges: [UsageGauge]

    var plan: PlanInfo? {
        subscription.map { PlanInfo(name: $0.planName, dollars: $0.monthlyDollars) }
            ?? GaugeBuilder.tierPlan(provider: provider, gauges: gauges)
    }

    /// Rows reporting a scope inside another row's pool, where that pool is also
    /// present. Claude's weekly "#Fable" scope is one: it spends the weekly
    /// allowance rather than capping anything of its own, so a spent Fable must not
    /// read as a spent account. Grok's sub-pools never reach here, foldBreakdowns
    /// having already folded them into their parent's bar.
    var subPoolIds: Set<String> {
        let present = Set(gauges.map(\.id))
        return Set(gauges.filter { $0.parentGaugeId.map(present.contains) == true }.map(\.id))
    }

    /// True when any observation behind this section came from a stale cache.
    var isStale: Bool { gauges.contains { $0.stale } }

    /// Age of the oldest stale number in this section ("3d"), for the stale badge.
    func staleAge(now: Date = Date()) -> String? {
        let oldest = gauges.filter(\.stale).compactMap(\.observedAt).min()
        return oldest.map { GaugeBuilder.shortAge($0, now: now) }
    }

    var id: String { "\(provider)|\(account ?? "")" }

    var accountDisplay: String? { account }

    func withGauges(_ gauges: [UsageGauge]) -> UsageSection {
        UsageSection(provider: provider, account: account, subscription: subscription, gauges: gauges)
    }

    var allowanceGauges: [UsageGauge] {
        let subPools = subPoolIds
        return gauges.filter { $0.fractionUsed != nil && !subPools.contains($0.id) }
    }
}

struct UsageGauge: Identifiable, Equatable {
    var id: String
    let provider: String
    let account: String?
    let label: String
    let windowLabel: String?
    let fractionUsed: Double?
    let limit: Double?
    let remaining: Double?
    let resetsAt: Date?
    let exact: Bool
    var stale: Bool = false
    var observedAt: Date? = nil
    var tier: String? = nil
    var breakdown: [UsageBreakdownSegment]?

    static let windowRank = ["five_hour": 0, "daily": 1, "weekly": 2, "monthly": 3]
    static let windowShort = ["five_hour": "5h", "weekly": "wk", "monthly": "mo",
                              "minute": "min", "daily": "day"]
}

enum GaugeBuilder {
    static let nameLabel = [
        "claude-max": "All models",
        "codex-pro": "All models",
        "opencode-go-zen": "All models",
        "grok-super grok plus": "All Usage"
    ]

    static let fallbackDollars = 50.0

    /// Claude reports its tier on every row, so a Claude account without a configured
    /// subscription still names its plan. Nothing else is inferred.
    static func tierPlan(provider: String, gauges: [UsageGauge]) -> PlanInfo? {
        guard provider == "anthropic" else { return nil }
        return gauges.compactMap(\.tier).first.flatMap(planFromTier)
    }

    static func sections(from snapshot: UsageSnapshot) -> [UsageSection] {
        var gauges: [UsageGauge] = []
        for o in snapshot.observations {
            switch o.metric {
            case "allowance":
                gauges.append(allowanceGauge(o))
            case "credit":
                if let balance = o.remaining { gauges.append(creditGauge(o, balance: balance)) }
            case "reset_credit":
                gauges.append(resetCreditGauge(o))
            default:
                break
            }
        }
        gauges = foldBreakdowns(disambiguated(gauges))

        // Group by provider+account; provider-level rows with no account join the
        // provider's sole named account when there is exactly one.
        var order: [String] = []
        var grouped: [String: [UsageGauge]] = [:]
        var identities: [String: (provider: String, account: String?)] = [:]
        for g in gauges {
            let key = "\(g.provider)|\(g.account ?? "")"
            if grouped[key] == nil { order.append(key) }
            grouped[key, default: []].append(g)
            identities[key] = (g.provider, g.account)
        }
        for provider in Set(gauges.map(\.provider)) {
            let unnamed = "\(provider)|"
            let named = order.filter { $0.hasPrefix("\(provider)|") && $0 != unnamed }
            if let orphans = grouped[unnamed], named.count == 1 {
                grouped[named[0], default: []].append(contentsOf: orphans)
                grouped[unnamed] = nil
                order.removeAll { $0 == unnamed }
            }
        }

        let subscriptions = Dictionary(
            snapshot.subscriptions.map { ("\($0.provider)|\($0.account ?? "")", $0) },
            uniquingKeysWith: { first, _ in first }
        )
        for subscription in snapshot.subscriptions {
            let key = "\(subscription.provider)|\(subscription.account ?? "")"
            if !order.contains(key) { order.append(key) }
            identities[key] = (subscription.provider, subscription.account)
        }

        return order.compactMap { key -> UsageSection? in
            let rows = (grouped[key] ?? []).sorted { rank($0.windowLabel) < rank($1.windowLabel) }
            guard let identity = identities[key] else { return nil }
            return UsageSection(
                provider: identity.provider,
                account: identity.account,
                subscription: subscriptions[key],
                gauges: rows
            )
        }
    }

    /// Items in the user's saved order. Items the order doesn't name yet keep their
    /// natural position relative to each other, after the named ones.
    static func ordered<T>(_ items: [T], by order: [String], id: (T) -> String) -> [T] {
        let rank = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: min)
        return items.enumerated()
            .sorted { (rank[id($0.element)] ?? order.count, $0.offset) < (rank[id($1.element)] ?? order.count, $1.offset) }
            .map(\.element)
    }

    static func ordered(_ sections: [UsageSection], by order: [String]) -> [UsageSection] {
        ordered(sections, by: order, id: \.id)
    }

    /// Drops `moving` onto `target`: before it when dragged up, after it when dragged down,
    /// so every slot, including the last, is reachable.
    static func reordered(_ ids: [String], moving: String, onto target: String) -> [String] {
        guard moving != target, let from = ids.firstIndex(of: moving),
              let to = ids.firstIndex(of: target) else { return ids }
        var ids = ids
        ids.remove(at: from)
        ids.insert(moving, at: to)
        return ids
    }

    /// Grok-style #sub-pool rows become colored segments on their parent gauge.
    static func foldBreakdowns(_ gauges: [UsageGauge]) -> [UsageGauge] {
        let parents = Dictionary(gauges.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var childrenByParent: [String: [UsageGauge]] = [:]
        var foldedIds = Set<String>()
        // Only Grok reports sub-pool breakdowns as stacked-bar segments;
        // other providers' suffixed rows (#Fable) stay as their own rows.
        for g in gauges where g.provider == "grok" && g.parentGaugeId != nil {
            guard let parentId = g.parentGaugeId, parents[parentId] != nil else { continue }
            childrenByParent[parentId, default: []].append(g)
            foldedIds.insert(g.id)
        }
        var result: [UsageGauge] = []
        for g in gauges {
            if foldedIds.contains(g.id) { continue }
            if var parent = parents[g.id], var children = childrenByParent[g.id] {
                children.sort { ($0.fractionUsed ?? 0) > ($1.fractionUsed ?? 0) }
                parent.breakdown = children.enumerated().map { i, c in
                    UsageBreakdownSegment(name: c.label, fractionUsed: c.fractionUsed, colorIndex: i)
                }
                result.append(parent)
            } else {
                result.append(g)
            }
        }
        return result
    }

    /// The snapshot is external data: two observations can legitimately collapse to
    /// one gauge id (a provider reporting the same entitlement twice). Ids must stay
    /// unique for SwiftUI's ForEach and for the breakdown fold, so repeats get an
    /// ordinal suffix instead of trapping.
    static func disambiguated(_ gauges: [UsageGauge]) -> [UsageGauge] {
        var seen: [String: Int] = [:]
        return gauges.map { g in
            let n = seen[g.id, default: 0]
            seen[g.id] = n + 1
            guard n > 0 else { return g }
            var copy = g
            copy.id = "\(g.id)~\(n)"
            return copy
        }
    }

    private static func rank(_ window: String?) -> Int {
        guard let window else { return 99 }
        return UsageGauge.windowRank[window] ?? 50
    }

    static func allowanceGauge(_ o: UsageObservation) -> UsageGauge {
        let parts = entitlementParts(o.entitlement)
        return UsageGauge(
            id: "\(o.provider)|\(o.entitlement)|\(o.window ?? "")",
            provider: o.provider,
            account: parts.account,
            label: parts.label,
            windowLabel: o.window.flatMap { UsageGauge.windowShort[$0] } ?? o.window,
            fractionUsed: o.fractionUsed,
            limit: o.limit,
            remaining: nil,
            resetsAt: o.resetsAt,
            exact: o.exact ?? false,
            stale: o.stale ?? false,
            observedAt: o.observedAt,
            tier: o.tier,
            breakdown: nil
        )
    }

    static func creditGauge(_ o: UsageObservation, balance: Double) -> UsageGauge {
        let parts = entitlementParts(o.entitlement)
        return UsageGauge(
            id: "credit|\(o.provider)|\(o.entitlement)",
            provider: o.provider,
            account: parts.account,
            label: shortEntitlement(parts.label),
            windowLabel: nil,
            fractionUsed: nil,
            limit: nil,
            remaining: balance,
            resetsAt: o.resetsAt,
            exact: o.exact ?? true,
            breakdown: nil
        )
    }

    /// A banked full-reset token: binary (redeemable or not), with an expiry.
    static func resetCreditGauge(_ o: UsageObservation) -> UsageGauge {
        let expiry = (o.expiresAt ?? o.resetsAt).map { "|\(Int($0.timeIntervalSince1970))" } ?? ""
        return UsageGauge(
            id: "reset|\(o.provider)|\(o.entitlement)\(expiry)",
            provider: o.provider,
            account: entitlementParts(o.entitlement).account,
            label: "Banked reset",
            windowLabel: nil,
            fractionUsed: nil,
            limit: nil,
            remaining: o.remaining,
            // The grant's lifecycle is availability -> expiry; show expiry as the countdown.
            resetsAt: o.expiresAt ?? o.resetsAt,
            exact: true,
            breakdown: nil
        )
    }

    /// Dollar-weighted overall used fraction per window, each section weighted by
    /// its plan dollars (or fallbackDollars). Sub-pool scoped gauges are excluded
    /// via allowanceGauges, so an exhausted #Fable scope cannot pin the account.
    static func overallReading(_ sections: [UsageSection]) -> OverallReading {
        var fiveTotal = 0.0, fiveWeight = 0.0
        var sevenTotal = 0.0, sevenWeight = 0.0
        for s in sections {
            let allowances = s.allowanceGauges
            let weekly = allowances.first { $0.windowLabel == UsageGauge.windowShort["weekly"] }?.fractionUsed
            let raw5h = allowances.first { $0.windowLabel == UsageGauge.windowShort["five_hour"] }?.fractionUsed
            let dollars = s.plan?.dollars ?? fallbackDollars
            // A sub with no 5h cap falls through to its weekly cap, and even a real
            // 5h cap can't outspend the weekly pool, so 5h usage is the max of both.
            if let five = [raw5h, weekly].compactMap({ $0 }).max() {
                fiveTotal += five * dollars
                fiveWeight += dollars
            }
            if let seven = weekly {
                sevenTotal += seven * dollars
                sevenWeight += dollars
            }
        }
        return OverallReading(
            fiveHour: fiveWeight > 0 ? fiveTotal / fiveWeight : nil,
            sevenDay: sevenWeight > 0 ? sevenTotal / sevenWeight : nil
        )
    }

    static func monthlyBill(_ sections: [UsageSection]) -> (total: Double, planCount: Int) {
        let withPlan = sections.filter { ($0.plan?.name.isEmpty == false) }
        return (withPlan.reduce(0) { $0 + ($1.plan?.dollars ?? 0) }, withPlan.count)
    }

    static let providerTitle = [
        "anthropic": "Claude", "codex": "Codex", "grok": "Grok",
        "opencode-go": "OpenCode Go", "venice": "Venice"
    ]

    /// "3d" / "5h" / "12m" age of a timestamp; used by the stale badge and health notes.
    static func shortAge(_ date: Date, now: Date = Date()) -> String {
        let minutes = max(0, Int((now.timeIntervalSince(date) / 60).rounded()))
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 48 { return "\(hours)h" }
        return "\(hours / 24)d"
    }

    /// Footnote lines for adapters that answered with caveats or not at all.
    static func healthNotes(_ adapters: [AdapterHealth]?) -> [String] {
        (adapters ?? [])
            .filter { $0.status != "ok" }
            .map { "\(providerTitle[$0.provider] ?? $0.provider) — \($0.detail ?? $0.status)" }
    }

    /// Single source of truth for the panel's height so the popover window can match it.
    static func panelHeight(for sections: [UsageSection], noteCount: Int = 0) -> CGFloat {
        var rows = CGFloat(sections.reduce(0) { $0 + $1.gauges.count })
        rows -= CGFloat(sections.reduce(0) { $0 + ($1.gauges.first?.breakdown?.count ?? 0) })
        let sectionHeaders = CGFloat(sections.count)
        let detailRows = CGFloat(sections.filter { $0.accountDisplay != nil || $0.plan != nil }.count)
        let legends = CGFloat(sections.reduce(0) { $0 + (($1.gauges.first?.breakdown?.isEmpty == false) ? 1 : 0) })
        let notes = CGFloat(noteCount) * 28
        return min(680, 56 + rows * 46 - legends * 12 + sectionHeaders * 28 + detailRows * 18 + notes + 20)
    }

    /// Splits "claude-max:milad@x.com#Fable" into friendly label/account.
    static func entitlementParts(_ entitlement: String) -> (label: String, account: String?) {
        var body = entitlement
        var suffix = ""
        if let hash = body.firstIndex(of: "#") {
            suffix = String(body[body.index(after: hash)...])
            body = String(body[..<hash])
        }
        var account: String?
        if let colon = body.firstIndex(of: ":") {
            let accountFull = String(body[body.index(after: colon)...])
            account = accountFull.isEmpty ? nil : accountFull
            body = String(body[..<colon])
        }
        if !suffix.isEmpty {
            // "#Fable" renders as its own name alone.
            return (suffix.prefix(1).uppercased() + suffix.dropFirst(), account)
        }
        return (nameLabel[body.lowercased()] ?? body, account)
    }

    static func shortEntitlement(_ entitlement: String) -> String {
        entitlement
            .replacingOccurrences(of: "-usd-balance", with: " USD")
            .replacingOccurrences(of: "-diem-balance", with: " Diem")
            .replacingOccurrences(of: "-dollar-credit", with: " credit")
            .replacingOccurrences(of: "venice-", with: "")
    }

    static func planFromTier(_ tier: String) -> PlanInfo? {
        let value = tier.lowercased()
        if value.contains("max_20") || value.contains("max 20") { return PlanInfo(name: "Max 20x", dollars: 200) }
        if value.contains("max_5") || value.contains("max 5") { return PlanInfo(name: "Max 5x", dollars: 100) }
        if value.contains("pro") || value == "default_claude_ai" { return PlanInfo(name: "Pro", dollars: 20) }
        if value.contains("max") { return PlanInfo(name: "Max", dollars: 100) }
        return nil
    }
}

private extension UsageGauge {
    /// The parent allowance gauge's id: same id with the "#suffix" removed.
    /// Ids look like "provider|entitlement#suffix|window".
    var parentGaugeId: String? {
        // Strip suffix between "#" and the final "|".
        guard let hash = id.firstIndex(of: "#"),
              let lastPipe = id.lastIndex(of: "|"), hash < lastPipe else { return nil }
        let start = id.distance(from: id.startIndex, to: hash)
        let end = id.distance(from: id.startIndex, to: lastPipe)
        var chars = Array(id)
        chars.removeSubrange(start..<end)
        return String(chars)
    }
}
