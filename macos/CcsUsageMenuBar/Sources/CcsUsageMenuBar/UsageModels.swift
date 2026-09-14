import Foundation

struct UsageSnapshot: Decodable, Equatable {
    let generatedAt: Date?
    let observations: [UsageObservation]
    let adapters: [AdapterHealth]?
    let subscriptions: [SubscriptionInfo]

    init(
        generatedAt: Date?,
        observations: [UsageObservation],
        adapters: [AdapterHealth]? = nil,
        subscriptions: [SubscriptionInfo] = []
    ) {
        self.generatedAt = generatedAt
        self.observations = observations
        self.adapters = adapters
        self.subscriptions = subscriptions
    }

    private enum CodingKeys: String, CodingKey {
        case generatedAt, observations, adapters, subscriptions
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try values.decodeIfPresent(Date.self, forKey: .generatedAt)
        observations = try values.decode([UsageObservation].self, forKey: .observations)
        adapters = try values.decodeIfPresent([AdapterHealth].self, forKey: .adapters)
        subscriptions = try values.decodeIfPresent([SubscriptionInfo].self, forKey: .subscriptions) ?? []
    }
}

struct SubscriptionInfo: Decodable, Equatable {
    let provider: String
    let account: String?
    let planName: String
    let monthlyDollars: Double
    let renewsOn: String
    let source: String

    var renewalDisplay: String {
        guard renewsOn.count == 10,
              let date = SnapshotDecoder.dayOnly.date(from: renewsOn) else { return renewsOn }
        return SnapshotDecoder.monthDay.string(from: date)
    }
}

/// Per-provider adapter health from ccs: "ok", "degraded" (answered with caveats,
/// e.g. stale fallbacks), or "unavailable" (no answer at all).
struct AdapterHealth: Decodable, Equatable {
    let provider: String
    let status: String
    let detail: String?
}

struct UsageObservation: Decodable, Equatable {
    let provider: String
    let entitlement: String
    let metric: String
    let scope: String?
    let window: String?
    let used: Double?
    let limit: Double?
    let remaining: Double?
    let resetsAt: Date?
    let expiresAt: Date?
    let exact: Bool?
    let stale: Bool?
    let tier: String?
    /// When the number was actually fetched — for stale fallbacks this is the
    /// last successful fetch, not the current run.
    var observedAt: Date? = nil

    var fractionUsed: Double? {
        guard let used, let limit, limit > 0 else { return nil }
        return min(max(used / limit, 0), 1)
    }
}

/// One colored segment of a stacked breakdown bar.
struct UsageBreakdownSegment: Identifiable, Equatable {
    let name: String
    let fractionUsed: Double?
    let colorIndex: Int

    var id: String { name }
}

struct SnapshotDecoder {
    static let iso8601Fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static let dayOnly: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = TimeZone(secondsFromGMT: 0)
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static let monthDay: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = TimeZone(secondsFromGMT: 0)
        f.dateFormat = "MMM d"
        return f
    }()

    static func decode(_ data: Data, now: Date = Date()) throws -> UsageSnapshot {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { d in
            let s = try d.singleValueContainer().decode(String.self)
            if let date = iso8601Fractional.date(from: s) ?? iso8601.date(from: s) {
                return date
            }
            throw DecodingError.dataCorrupted(.init(codingPath: d.codingPath, debugDescription: "Unparseable date \(s)"))
        }
        return try decoder.decode(UsageSnapshot.self, from: data)
    }
}
