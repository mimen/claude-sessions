import XCTest
@testable import CcsUsageMenuBar

final class GaugeBuilderTests: XCTestCase {
    private func observation(
        provider: String = "anthropic",
        entitlement: String = "claude-max:milad@example.com",
        metric: String = "allowance",
        window: String? = "weekly",
        used: Double? = 50,
        limit: Double? = 100,
        remaining: Double? = nil,
        resetsAt: Date? = Date(timeIntervalSinceNow: 3600)
    ) -> UsageObservation {
        UsageObservation(
            provider: provider, entitlement: entitlement, metric: metric,
            scope: "account", window: window, used: used, limit: limit,
            remaining: remaining, resetsAt: resetsAt, exact: true
        )
    }

    func testDecodesFractionalAndPlainTimestamps() throws {
        let json = """
        {"generatedAt":"2026-08-22T20:22:31.810Z","observations":[
          {"provider":"codex","entitlement":"codex-pro:x@y.com","metric":"allowance","scope":"account","window":"weekly","used":22,"limit":100,"remaining":78,"resetsAt":"2026-08-29T07:20:46Z","expiresAt":null,"observedAt":"2026-08-22T20:22:26Z","source":"official_api","exact":false},
          {"provider":"a","entitlement":"e","metric":"allowance","scope":"s","window":"five_hour","used":1,"limit":2,"remaining":1,"resetsAt":"2026-08-21T04:59:59.608363+00:00","expiresAt":null,"observedAt":"2026-08-22T20:22:30.051Z","source":"api","exact":true}
        ]}
        """.data(using: .utf8)!
        let snapshot = try SnapshotDecoder.decode(json)
        XCTAssertEqual(snapshot.observations.count, 2)
        XCTAssertNotNil(snapshot.generatedAt)
        XCTAssertNotNil(snapshot.observations[0].resetsAt)
        XCTAssertNotNil(snapshot.observations[1].resetsAt)
    }

    func testBuildKeepsAllowancesAndCreditsDropsRateLimits() {
        let snapshot = UsageSnapshot(generatedAt: nil, observations: [
            observation(),
            observation(metric: "credit", used: nil, limit: nil, remaining: 12.5),
            observation(provider: "venice", entitlement: "venice-model:gpt", metric: "rate_limit", window: "minute", used: nil, limit: 100),
            observation(entitlement: "codex-dollar-credit:x", metric: "credit", used: nil, limit: nil, remaining: 0)
        ])
        let gauges = GaugeBuilder.build(from: snapshot)
        XCTAssertEqual(gauges.count, 2)
        XCTAssertTrue(gauges.contains { $0.remaining == 12.5 })
    }

    func testGrokSubRowsCollapseWhenParentPresent() {
        let parent = observation(provider: "grok", entitlement: "grok-super plus:m@x.com", window: "weekly")
        let sub = observation(provider: "grok", entitlement: "grok-super plus:m@x.com#build", window: "weekly")
        let withParent = GaugeBuilder.build(from: .init(generatedAt: nil, observations: [parent, sub]))
        XCTAssertEqual(withParent.count, 1)
        let withoutParent = GaugeBuilder.build(from: .init(generatedAt: nil, observations: [sub]))
        XCTAssertEqual(withoutParent.count, 1)
    }

    func testLabels() {
        let gauge = GaugeBuilder.allowanceGauge(observation(entitlement: "claude-max:milad@example.com"))
        XCTAssertEqual(gauge.label, "claude-max · milad")
        XCTAssertEqual(gauge.windowLabel, "wk")
        let fable = GaugeBuilder.allowanceGauge(observation(entitlement: "claude-max:m@x.com#Fable"))
        XCTAssertEqual(fable.label, "claude-max · m #Fable")
    }

    func testTightestPicksHighestFraction() {
        let gauges = [
            GaugeBuilder.allowanceGauge(observation(used: 10)),
            GaugeBuilder.allowanceGauge(observation(used: 82)),
            GaugeBuilder.allowanceGauge(observation(used: 40))
        ]
        XCTAssertEqual(GaugeBuilder.tightest(gauges)?.fractionUsed, 0.82)
    }

    func testFractionClamped() {
        XCTAssertEqual(observation(used: 150).fractionUsed, 1.0)
        XCTAssertNil(observation(used: nil).fractionUsed)
    }
}
