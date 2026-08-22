import Foundation

struct UsageSnapshot: Decodable, Equatable {
    let generatedAt: Date?
    let observations: [UsageObservation]
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
    let exact: Bool?

    var fractionUsed: Double? {
        guard let used, let limit, limit > 0 else { return nil }
        return min(max(used / limit, 0), 1)
    }
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
