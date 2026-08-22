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

    private func snapshot(_ observations: [UsageObservation]) -> UsageSnapshot {
        UsageSnapshot(generatedAt: nil, observations: observations)
    }

    func testDecodesFractionalAndPlainTimestamps() throws {
        let json = """
        {"generatedAt":"2026-08-22T20:22:31.810Z","observations":[
          {"provider":"codex","entitlement":"codex-pro:x@y.com","metric":"allowance","scope":"account","window":"weekly","used":22,"limit":100,"remaining":78,"resetsAt":"2026-08-29T07:20:46Z","expiresAt":null,"observedAt":"2026-08-22T20:22:26Z","source":"official_api","exact":false},
          {"provider":"a","entitlement":"e","metric":"allowance","scope":"s","window":"five_hour","used":1,"limit":2,"remaining":1,"resetsAt":"2026-08-21T04:59:59.608363+00:00","expiresAt":null,"observedAt":"2026-08-22T20:22:30.051Z","source":"api","exact":true}
        ]}
        """.data(using: .utf8)!
        let parsed = try SnapshotDecoder.decode(json)
        XCTAssertEqual(parsed.observations.count, 2)
        XCTAssertNotNil(parsed.generatedAt)
        XCTAssertNotNil(parsed.observations[0].resetsAt)
        XCTAssertNotNil(parsed.observations[1].resetsAt)
    }

    func testSectionsGroupByProviderAndAccount() {
        let sections = GaugeBuilder.sections(from: snapshot([
            observation(entitlement: "claude-max:miladmaaan@gmail.com", window: "five_hour"),
            observation(entitlement: "claude-max:milad@auf.com", window: "weekly"),
            observation(entitlement: "claude-max:miladmaaan@gmail.com", window: "weekly")
        ]))
        XCTAssertEqual(sections.count, 2)
        XCTAssertEqual(sections[0].provider, "anthropic")
        XCTAssertEqual(sections[0].accountDisplay, "personal")
        XCTAssertEqual(sections[0].gauges.map(\.windowLabel), ["5h", "wk"])
        XCTAssertEqual(sections[1].accountDisplay, "auf")
    }

    func testLabelsCarrySuffixNotAccount() {
        let fable = GaugeBuilder.allowanceGauge(
            observation(entitlement: "claude-max:miladmaaan@gmail.com#Fable"))
        XCTAssertEqual(fable.label, "claude-max #Fable")
        XCTAssertEqual(fable.account, "miladmaaan")
        let plain = GaugeBuilder.allowanceGauge(observation(entitlement: "codex-pro:x@y.com"))
        XCTAssertEqual(plain.label, "codex-pro")
    }

    func testEntitlementParts() {
        let parts = GaugeBuilder.entitlementParts("grok-super grok plus:m@x.com#build")
        XCTAssertEqual(parts.name, "grok-super grok plus")
        XCTAssertEqual(parts.account, "m")
        XCTAssertEqual(parts.suffix, " #build")
        let bare = GaugeBuilder.entitlementParts("opencode-go-zen")
        XCTAssertEqual(bare.name, "opencode-go-zen")
        XCTAssertNil(bare.account)
    }

    func testGrokSubRowsCollapseButAnthropicSuffixedRowsStay() {
        let parent = observation(provider: "grok", entitlement: "grok-super plus:m@x.com", window: "weekly")
        let sub = observation(provider: "grok", entitlement: "grok-super plus:m@x.com#build", window: "weekly")
        let grok = GaugeBuilder.sections(from: snapshot([parent, sub]))
        XCTAssertEqual(grok.flatMap(\.gauges).count, 1)

        let maxRow = observation(entitlement: "claude-max:m@a.com")
        let fable = observation(entitlement: "claude-max:m@a.com#Fable")
        let anthropic = GaugeBuilder.sections(from: snapshot([maxRow, fable]))
        XCTAssertEqual(anthropic.flatMap(\.gauges).count, 2)
    }

    func testCreditRowsKeepRateLimitsDropped() {
        let sections = GaugeBuilder.sections(from: snapshot([
            observation(metric: "credit", used: nil, limit: nil, remaining: 12.5),
            observation(provider: "venice", entitlement: "venice-model:gpt", metric: "rate_limit", window: "minute", used: nil, limit: 100),
            observation(entitlement: "codex-dollar-credit:x", metric: "credit", used: nil, limit: nil, remaining: 0)
        ]))
        XCTAssertEqual(sections.count, 1)
        XCTAssertEqual(sections[0].gauges.first?.remaining, 12.5)
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
