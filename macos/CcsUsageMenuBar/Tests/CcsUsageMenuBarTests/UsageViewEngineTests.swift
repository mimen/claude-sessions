import XCTest
@testable import CcsUsageMenuBar

/// The view logic's coverage lives in packages/usage-view/index.test.ts; these check the bridge.
final class UsageViewEngineTests: XCTestCase {
    private let engine = UsageViewEngine.shared
    private let personal = "miladmaaan@gmail.com"
    private let auf = "milad@afternoonumbrellafriends.com"

    private func fixture() throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "usage-2026-09-05", withExtension: "json",
                                                  subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    private func build(_ order: ViewOrder = ViewOrder(sections: [], rows: [:])) throws -> UsageViewModel {
        try engine.build(snapshotData: fixture(), previous: nil, order: order).view
    }

    func testBuildsTheFixtureView() throws {
        let built = try engine.build(snapshotData: fixture(), previous: nil, order: ViewOrder(sections: [], rows: [:]))
        let view = built.view
        XCTAssertEqual(Array(view.sections.prefix(4).map(\.id)), [
            "codex|\(personal)", "anthropic|\(personal)", "anthropic|\(auf)", "grok|\(personal)",
        ])
        let claude = try XCTUnwrap(view.sections.first { $0.id == "anthropic|\(auf)" })
        XCTAssertEqual(claude.rows.map(\.label), ["All models", "All models", "Fable"])
        XCTAssertEqual(claude.plan, ViewSection.Plan(name: "Max 20x", dollars: 200))
        let grok = try XCTUnwrap(view.sections.first { $0.provider == "grok" })
        XCTAssertEqual(grok.rows.map(\.label), ["Banked reset", "Extra credits"])
        XCTAssertEqual(view.bill, UsageViewModel.Bill(total: 200, planCount: 1))
        XCTAssertNotNil(view.overall.fiveHour)
        XCTAssertNotNil(view.overall.sevenDay)
        XCTAssertEqual(view.notes, ["Claude: 1 account(s) on cached usage — token revoked or missing; re-auth via cswap"])
        XCTAssertEqual(built.generatedAt, Date(timeIntervalSince1970: 1_788_632_623.980))
    }

    func testAppliesASavedOrder() throws {
        let fiveHour = "anthropic|claude-max:\(auf)|five_hour"
        let fable = "anthropic|claude-max:\(auf)#Fable|weekly"
        let view = try build(ViewOrder(sections: ["grok|\(personal)", "anthropic|\(auf)"],
                                       rows: ["anthropic|\(auf)": [fable, fiveHour]]))
        XCTAssertEqual(view.sections.prefix(3).map(\.id), ["grok|\(personal)", "anthropic|\(auf)", "codex|\(personal)"])
        XCTAssertEqual(view.sections[1].rows.map(\.id), [fable, fiveHour, "anthropic|claude-max:\(auf)|weekly"])
    }

    func testReordered() {
        XCTAssertEqual(engine.reordered(["a", "b", "c"], moving: "a", onto: "c"), ["b", "c", "a"])
        XCTAssertEqual(engine.reordered(["a", "b", "c"], moving: "c", onto: "a"), ["c", "a", "b"])
    }

    func testFormatsAgesAndRenewals() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertEqual(engine.shortAge(now.addingTimeInterval(-3 * 86_400), now: now), "3d")
        XCTAssertEqual(engine.renewalLabel("2026-10-08"), "Oct 8")
    }

    func testAJavaScriptExceptionThrows() {
        XCTAssertThrowsError(try engine.build(snapshotData: Data("{not json".utf8), previous: nil,
                                              order: ViewOrder(sections: [], rows: [:]))) { error in
            XCTAssertTrue((error as? UsageViewError)?.message.contains("SyntaxError") == true, "\(error)")
        }
        // The context survives an exception.
        XCTAssertEqual(engine.renewalLabel("2026-10-08"), "Oct 8")
    }
}
