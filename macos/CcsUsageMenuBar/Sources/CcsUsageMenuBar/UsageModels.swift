import Foundation

struct UsageSnapshot: Decodable, Equatable {
    let generatedAt: Date?
    let observations: [UsageObservation]
    var adapters: [AdapterHealth]? = nil
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
