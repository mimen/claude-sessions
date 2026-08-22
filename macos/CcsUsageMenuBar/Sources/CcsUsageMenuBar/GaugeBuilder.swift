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
    let limit: Double?
    let remaining: Double?
    let resetsAt: Date?
    let exact: Bool

    static let windowRank = ["five_hour": 0, "daily": 1, "weekly": 2, "monthly": 3]
    static let windowShort = ["five_hour": "5h", "weekly": "wk", "monthly": "mo",
                              "minute": "min", "daily": "day"]
}

enum GaugeBuilder {
    static let accountAlias = ["miladmaaan": "personal", "milad": "auf"]

    static let nameLabel = [
        "claude-max": "All models",
        "codex-pro": "All models",
        "opencode-go-zen": "All models",
        "grok-super grok plus": "All Usage"
    ]

    static func sections(from snapshot: UsageSnapshot) -> [UsageSection] {
        var gauges: [UsageGauge] = []
        for o in snapshot.observations {
            switch o.metric {
            case "allowance":
                gauges.append(allowanceGauge(o))
            case "credit":
                if let balance = o.remaining { gauges.append(creditGauge(o, balance: balance)) }
            default:
                break
            }
        }

        // Group by provider+account; provider-level rows with no account join the
        // provider's sole named account when there is exactly one.
        var order: [String] = []
        var grouped: [String: [UsageGauge]] = [:]
        for g in gauges {
            let key = "\(g.provider)|\(g.account ?? "")"
            if grouped[key] == nil { order.append(key) }
            grouped[key, default: []].append(g)
        }
        for provider in Set(gauges.map(\.provider)) {
            let unnamed = "\(provider)|"
            let named = order.filter { $0.hasPrefix("\(provider)|") && $0 != unnamed }
            if grouped[unnamed] != nil, named.count == 1 {
                grouped[named[0]]!.append(contentsOf: grouped[unnamed]!)
                grouped[unnamed] = nil
                order.removeAll { $0 == unnamed }
            }
        }

        return order.map { key in
            let rows = grouped[key]!.sorted { rank($0.windowLabel) < rank($1.windowLabel) }
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
            label: parts.label,
            windowLabel: o.window.flatMap { UsageGauge.windowShort[$0] } ?? o.window,
            fractionUsed: o.fractionUsed,
            limit: o.limit,
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
            label: shortEntitlement(parts.label),
            windowLabel: nil,
            fractionUsed: nil,
            limit: nil,
            remaining: balance,
            resetsAt: o.resetsAt,
            exact: o.exact ?? true
        )
    }

    /// Single source of truth for the panel's height so the popover window can match it.
    static func panelHeight(for sections: [UsageSection]) -> CGFloat {
        let rows = CGFloat(sections.reduce(0) { $0 + $1.gauges.count })
        let sectionHeaders = CGFloat(sections.count)
        let accountSubheaders = CGFloat(sections.compactMap(\.accountDisplay).count)
        return min(520, 56 + rows * 46 + sectionHeaders * 28 + accountSubheaders * 18 + 20)
    }

    /// Weighted-average used fraction across all allowance gauges (weight = limit).
    static func overallUsedFraction(_ gauges: [UsageGauge]) -> Double? {
        var total = 0.0, weight = 0.0
        for g in gauges {
            guard let f = g.fractionUsed else { continue }
            let w = (g.limit ?? 100)
            total += f * w
            weight += w
        }
        guard weight > 0 else { return nil }
        return total / weight
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
            let localPart = accountFull.split(separator: "@").first.map(String.init) ?? accountFull
            account = localPart.isEmpty ? nil : localPart
            body = String(body[..<colon])
        }
        if !suffix.isEmpty {
            // "#Fable" -> "Fable"; sub-pools render under their own name alone.
            return (suffix.prefix(1).uppercased() + suffix.dropFirst(), account)
        }
        return (nameLabel[body.lowercased()] ?? body, account)
    }

    static func shortEntitlement(_ entitlement: String) -> String {
        entitlement
            .replacingOccurrences(of: "-usd-balance", with: " USD")
            .replacingOccurrences(of: "-diem-balance", with: " Diem")
            .replacingOccurrences(of: "venice-", with: "")
    }
}
