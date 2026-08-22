import Foundation

struct UsageSection: Identifiable, Equatable {
    let provider: String
    let account: String?
    let gauges: [UsageGauge]

    var id: String { "\(provider)|\(account ?? "")" }

    /// "personal", "auf", or the raw local part as fallback.
    var accountDisplay: String? {
        guard let account else { return nil }
        return GaugeBuilder.accountAlias[account.lowercased()] ?? account
    }
}

struct UsageGauge: Identifiable, Equatable {
    let id: String
    let provider: String
    let account: String?
    let label: String
    let windowLabel: String?
    let fractionUsed: Double?
    let remaining: Double?
    let resetsAt: Date?
    let exact: Bool

    static let windowRank = ["five_hour": 0, "daily": 1, "weekly": 2, "monthly": 3]

    static let windowShort = [
        "five_hour": "5h",
        "weekly": "wk",
        "monthly": "mo",
        "minute": "min",
        "daily": "day"
    ]
}

enum GaugeBuilder {
    static let accountAlias = [
        "miladmaaan": "personal",
        "milad": "auf"
    ]

    static func sections(from snapshot: UsageSnapshot) -> [UsageSection] {
        var gauges: [UsageGauge] = []
        for o in snapshot.observations {
            if o.metric == "allowance" {
                gauges.append(allowanceGauge(o))
            } else if o.metric == "credit", let balance = o.remaining, balance > 0 || (o.used ?? 0) > 0 {
                gauges.append(creditGauge(o, balance: balance))
            }
        }
        gauges = dedupe(gauges)

        var order: [String] = []
        var grouped: [String: [UsageGauge]] = [:]
        for g in gauges {
            let key = "\(g.provider)|\(g.account ?? "")"
            if grouped[key] == nil { order.append(key) }
            grouped[key, default: []].append(g)
        }

        return order.map { key in
            let rows = grouped[key]!.sorted {
                rank($0.windowLabel) < rank($1.windowLabel)
            }
            return UsageSection(provider: rows[0].provider, account: rows[0].account, gauges: rows)
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
            label: parts.name + parts.suffix,
            windowLabel: o.window.flatMap { UsageGauge.windowShort[$0] } ?? o.window,
            fractionUsed: o.fractionUsed,
            remaining: nil,
            resetsAt: o.resetsAt,
            exact: o.exact ?? false
        )
    }

    static func creditGauge(_ o: UsageObservation, balance: Double) -> UsageGauge {
        let parts = entitlementParts(o.entitlement)
        return UsageGauge(
            id: "credit|\(o.provider)|\(o.entitlement)",
            provider: o.provider,
            account: parts.account,
            label: shortEntitlement(parts.name),
            windowLabel: nil,
            fractionUsed: nil,
            remaining: balance,
            resetsAt: o.resetsAt,
            exact: o.exact ?? true
        )
    }

    /// Splits "claude-max:milad@x.com#Fable" into name "claude-max", account "milad", suffix " #Fable".
    static func entitlementParts(_ entitlement: String) -> (name: String, account: String?, suffix: String) {
        var body = entitlement
        var suffix = ""
        if let hash = body.firstIndex(of: "#") {
            suffix = " " + body[hash...]
            body = String(body[..<hash])
        }
        if let colon = body.firstIndex(of: ":") {
            let accountFull = String(body[body.index(after: colon)...])
            let localPart = accountFull.split(separator: "@").first.map(String.init) ?? accountFull
            return (String(body[..<colon]), localPart.isEmpty ? nil : localPart, suffix)
        }
        return (body, nil, suffix)
    }

    /// Grok splits one pool into #build/#chat/#imagine sub-rows with identical numbers;
    /// collapse those into the parent row when a parent exists. Grok only — other
    /// providers' suffixed rows (#Fable) carry genuinely different usage.
    static func dedupe(_ gauges: [UsageGauge]) -> [UsageGauge] {
        let parents = Set(gauges.filter { !$0.id.contains("#") }.map { "\($0.provider)|\($0.account ?? "")|\($0.label)" })
        var result: [UsageGauge] = []
        var seen = Set<String>()
        for g in gauges {
            if g.provider == "grok", let hash = g.id.firstIndex(of: "#") {
                let baseId = String(g.id[..<(g.id.range(of: "#")?.lowerBound ?? hash)])
                // baseId keeps entitlement prefix; compare against parent labels via entitlement base name
                let baseName = String(g.label.split(separator: " ").dropLast().joined(separator: " "))
                _ = baseId
                if parents.contains("\(g.provider)|\(g.account ?? "")|\(baseName)") { continue }
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

    static func shortEntitlement(_ entitlement: String) -> String {
        entitlement
            .replacingOccurrences(of: "-usd-balance", with: " USD")
            .replacingOccurrences(of: "-diem-balance", with: " Diem")
            .replacingOccurrences(of: "venice-", with: "")
    }
}
