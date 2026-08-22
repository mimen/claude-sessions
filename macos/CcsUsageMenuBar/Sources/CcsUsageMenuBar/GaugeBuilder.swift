import Foundation

struct UsageGauge: Identifiable, Equatable {
    let id: String
    let provider: String
    let label: String
    let windowLabel: String?
    let fractionUsed: Double?
    let remaining: Double?
    let resetsAt: Date?
    let exact: Bool
    let subKey: String?
}

enum GaugeBuilder {
    static let windowShort: [String: String] = [
        "five_hour": "5h",
        "weekly": "wk",
        "monthly": "mo",
        "minute": "min",
        "daily": "day"
    ]

    /// Allowance rows become progress gauges; credit rows become balances.
    /// Per-model minute rate limits (Venice) and one-sided reset credits are dropped.
    static func build(from snapshot: UsageSnapshot) -> [UsageGauge] {
        var gauges: [UsageGauge] = []
        for o in snapshot.observations {
            if o.metric == "allowance" {
                gauges.append(allowanceGauge(o))
            } else if o.metric == "credit", let balance = o.remaining, balance > 0 || (o.used ?? 0) > 0 {
                gauges.append(creditGauge(o, balance: balance))
            }
        }
        return dedupe(gauges)
    }

    static func allowanceGauge(_ o: UsageObservation) -> UsageGauge {
        let suffix = Self.suffix(of: o.entitlement)
        let account = accountLabel(of: o.entitlement)
        var name = label(provider: o.provider, entitlement: o.entitlement, account: account)
        if !suffix.isEmpty { name += " \(suffix)" }
        return UsageGauge(
            id: "\(o.provider)|\(o.entitlement)|\(o.window ?? "")",
            provider: o.provider,
            label: name,
            windowLabel: o.window.flatMap { windowShort[$0] } ?? o.window,
            fractionUsed: o.fractionUsed,
            remaining: nil,
            resetsAt: o.resetsAt,
            exact: o.exact ?? false,
            subKey: suffix.isEmpty ? nil : String(suffix.dropFirst())
        )
    }

    static func creditGauge(_ o: UsageObservation, balance: Double) -> UsageGauge {
        UsageGauge(
            id: "credit|\(o.provider)|\(o.entitlement)",
            provider: o.provider,
            label: shortEntitlement(o.entitlement),
            windowLabel: nil,
            fractionUsed: nil,
            remaining: balance,
            resetsAt: o.resetsAt,
            exact: o.exact ?? true,
            subKey: nil
        )
    }

    /// Grok splits one pool into #build/#chat/#imagine sub-rows with identical numbers;
    /// collapse those to the parent row when a parent row exists.
    static func dedupe(_ gauges: [UsageGauge]) -> [UsageGauge] {
        let parents = Set(gauges.filter { $0.subKey == nil }.map { "\($0.provider)|\($0.label)" })
        var result: [UsageGauge] = []
        var seen = Set<String>()
        for g in gauges {
            if let sub = g.subKey, parents.contains("\(g.provider)|\(g.label.replacingOccurrences(of: " #\(sub)", with: ""))") {
                continue
            }
            if seen.insert(g.id).inserted {
                result.append(g)
            }
        }
        return result
    }

    static func tightest(_ gauges: [UsageGauge]) -> UsageGauge? {
        gauges.compactMap { gauge -> (UsageGauge, Double)? in
            guard let f = gauge.fractionUsed else { return nil }
            return (gauge, f)
        }.max(by: { $0.1 < $1.1 })?.0
    }

    static func suffix(of entitlement: String) -> String {
        if let hash = entitlement.range(of: "#") {
            return String(entitlement[hash.lowerBound...])
        }
        return ""
    }

    static func accountLabel(of entitlement: String) -> String? {
        guard entitlement.contains(":") else { return nil }
        let parts = entitlement.split(separator: ":", maxSplits: 1)
        guard parts.count == 2 else { return nil }
        let account = String(parts[1])
        if let hash = account.firstIndex(of: "#") {
            return String(account[..<hash])
        }
        return account
    }

    static func label(provider: String, entitlement: String, account: String?) -> String {
        var name = entitlement
        if name.contains(":") { name = String(name.split(separator: ":", maxSplits: 1)[0]) }
        if let account, !account.isEmpty {
            let localPart = account.split(separator: "@").first.map(String.init) ?? account
            name += " · \(localPart)"
        }
        return name
    }

    static func shortEntitlement(_ entitlement: String) -> String {
        entitlement
            .replacingOccurrences(of: "-usd-balance", with: " USD")
            .replacingOccurrences(of: "-diem-balance", with: " Diem")
            .replacingOccurrences(of: "venice-", with: "")
    }
}
