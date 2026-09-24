import Foundation
import JavaScriptCore

// Mirrors of packages/usage-view/index.ts `View`, `Section`, and `Row`. Times are epoch ms.

struct UsageViewModel: Decodable, Equatable {
    struct Overall: Decodable, Equatable {
        let fiveHour: Double?
        let sevenDay: Double?
    }
    struct Bill: Decodable, Equatable {
        let total: Double
        let planCount: Int
    }
    let sections: [ViewSection]
    let overall: Overall
    let bill: Bill
    let notes: [String]
}

struct ViewSection: Decodable, Equatable, Identifiable {
    struct Plan: Decodable, Equatable {
        let name: String
        let dollars: Double
    }
    let id: String
    let provider: String
    let title: String
    let account: String?
    let plan: Plan?
    let renewsOn: String?
    let rows: [ViewRow]
    let staleSince: Double?
}

struct ViewSegment: Decodable, Equatable {
    let name: String
    let fractionUsed: Double?
}

enum ViewRow: Decodable, Equatable, Identifiable {
    struct Allowance: Decodable, Equatable {
        let id: String
        let label: String
        let window: String?
        let fractionUsed: Double?
        let resetsAt: Double?
        let stale: Bool
        let observedAt: Double?
        let segments: [ViewSegment]
    }
    struct Credit: Decodable, Equatable {
        let id: String
        let label: String
        let balance: Double
        let unit: String
        let resetsAt: Double?
    }
    struct Reset: Decodable, Equatable {
        let id: String
        let label: String
        let available: Bool
        let expiresAt: Double?
    }

    case allowance(Allowance)
    case credit(Credit)
    case reset(Reset)

    private enum Kind: String, Decodable { case allowance, credit, reset }
    private enum CodingKeys: String, CodingKey { case kind }

    init(from decoder: Decoder) throws {
        switch try decoder.container(keyedBy: CodingKeys.self).decode(Kind.self, forKey: .kind) {
        case .allowance: self = .allowance(try Allowance(from: decoder))
        case .credit: self = .credit(try Credit(from: decoder))
        case .reset: self = .reset(try Reset(from: decoder))
        }
    }

    var id: String {
        switch self {
        case .allowance(let r): r.id
        case .credit(let r): r.id
        case .reset(let r): r.id
        }
    }

    var label: String {
        switch self {
        case .allowance(let r): r.label
        case .credit(let r): r.label
        case .reset(let r): r.label
        }
    }
}

extension Date {
    init(epochMs: Double) { self.init(timeIntervalSince1970: epochMs / 1000) }
}

/// Saved drag orders, passed to the module as `{sections, rows}`.
struct ViewOrder: Encodable {
    var sections: [String]
    var rows: [String: [String]]
}

struct UsageViewError: LocalizedError {
    let message: String
    var errorDescription: String? { "usage view: \(message)" }
}

/// Runs packages/usage-view (bundled to Resources/usage-view.js) in one JSContext.
/// Strings cross the boundary, never objects.
final class UsageViewEngine: @unchecked Sendable {
    static let shared = UsageViewEngine()

    // JSContext is not reentrant from several threads at once; every call goes through the lock.
    private let lock = NSLock()
    private var context: JSContext?
    private var exception: String?

    private func call(_ name: String, _ arguments: [Any]) throws -> JSValue {
        lock.lock()
        defer { lock.unlock() }
        let context = try loadedContext()
        exception = nil
        let result = context.objectForKeyedSubscript("usageView")?.objectForKeyedSubscript(name)?
            .call(withArguments: arguments)
        if let exception { throw UsageViewError(message: exception) }
        guard let result, !result.isUndefined else { throw UsageViewError(message: "\(name) returned nothing") }
        return result
    }

    private func loadedContext() throws -> JSContext {
        if let context { return context }
        guard let url = Self.scriptURL, let script = try? String(contentsOf: url, encoding: .utf8) else {
            throw UsageViewError(message: "usage-view.js missing from the app bundle")
        }
        guard let context = JSContext() else { throw UsageViewError(message: "could not create a JSContext") }
        context.exceptionHandler = { [weak self] _, value in
            self?.exception = value?.toString() ?? "unknown JavaScript exception"
        }
        exception = nil
        context.evaluateScript(script, withSourceURL: url)
        if let exception { throw UsageViewError(message: exception) }
        self.context = context
        return context
    }

    /// The .app carries the script in Contents/Resources (make-app.sh copies it there);
    /// `swift build` and `swift test` find it through SwiftPM's resource bundle.
    private static var scriptURL: URL? {
        Bundle.main.url(forResource: "usage-view", withExtension: "js")
            ?? Bundle.module.url(forResource: "usage-view", withExtension: "js")
    }

    /// Carries unreachable providers forward from `previous`, then builds the view.
    /// Returns the carried snapshot, which is the next refresh's `previous`.
    func build(snapshotData: Data, previous: Data?, order: ViewOrder) throws
        -> (snapshot: Data, view: UsageViewModel, generatedAt: Date?) {
        let orderJson = String(decoding: try JSONEncoder().encode(order), as: UTF8.self)
        let output = try call("build", [
            String(decoding: snapshotData, as: UTF8.self),
            previous.map { String(decoding: $0, as: UTF8.self) } ?? NSNull(),
            orderJson,
        ]).toString() ?? ""
        let data = Data(output.utf8)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let snapshot = object["snapshot"], let view = object["view"] else {
            throw UsageViewError(message: "build returned no snapshot or view")
        }
        return (
            try JSONSerialization.data(withJSONObject: snapshot),
            try JSONDecoder().decode(UsageViewModel.self, from: JSONSerialization.data(withJSONObject: view)),
            ((snapshot as? [String: Any])?["generatedAt"] as? String).flatMap(Self.parseISO)
        )
    }

    func reordered(_ ids: [String], moving: String, onto target: String) -> [String] {
        guard let idsJson = try? JSONEncoder().encode(ids),
              let json = try? call("reordered", [String(decoding: idsJson, as: UTF8.self), moving, target]).toString(),
              let next = try? JSONDecoder().decode([String].self, from: Data(json.utf8)) else { return ids }
        return next
    }

    func shortAge(_ date: Date, now: Date) -> String {
        (try? call("shortAge", [date.timeIntervalSince1970 * 1000, now.timeIntervalSince1970 * 1000]).toString()) ?? ""
    }

    func renewalLabel(_ renewsOn: String) -> String {
        (try? call("renewalLabel", [renewsOn]).toString()) ?? renewsOn
    }

    private static func parseISO(_ s: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }
}

/// Single source of truth for the panel's height so the popover window can match it.
func panelHeight(for view: UsageViewModel, noteCount: Int) -> CGFloat {
    let rows = CGFloat(view.sections.reduce(0) { $0 + $1.rows.count })
    let sectionHeaders = CGFloat(view.sections.count)
    let detailRows = CGFloat(view.sections.filter { $0.account != nil || $0.plan != nil }.count)
    let legends = CGFloat(view.sections.flatMap(\.rows).filter {
        if case .allowance(let r) = $0 { return !r.segments.isEmpty }
        return false
    }.count)
    let notes = CGFloat(noteCount) * 28
    return min(680, 56 + rows * 46 - legends * 12 + sectionHeaders * 28 + detailRows * 18 + notes + 20)
}
