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
            remaining: remaining, resetsAt: resetsAt, expiresAt: nil, exact: true, stale: nil, tier: nil
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
        XCTAssertEqual(fable.label, "Fable")
        XCTAssertEqual(fable.account, "miladmaaan")
        let plain = GaugeBuilder.allowanceGauge(observation(entitlement: "codex-pro:x@y.com"))
        XCTAssertEqual(plain.label, "All models")
    }

    func testEntitlementParts() {
        let parts = GaugeBuilder.entitlementParts("grok-super grok plus:m@x.com#build")
        XCTAssertEqual(parts.label, "Build")
        XCTAssertEqual(parts.account, "m")
        let bare = GaugeBuilder.entitlementParts("opencode-go-zen")
        XCTAssertEqual(bare.label, "All models")
        XCTAssertNil(bare.account)
    }

    func testGrokBreakdownRowsAndFriendlyNames() {
        let sections = GaugeBuilder.sections(from: snapshot([
            observation(provider: "grok", entitlement: "grok-super grok plus:m@x.com", window: "weekly"),
            observation(provider: "grok", entitlement: "grok-super grok plus:m@x.com#build", window: "weekly"),
            observation(entitlement: "claude-max:miladmaaan@gmail.com"),
            observation(entitlement: "claude-max:miladmaaan@gmail.com#Fable")
        ]))
        let grok = sections.first { $0.provider == "grok" }!
        // Grok sub-pools fold into the parent's stacked bar.
        XCTAssertEqual(grok.gauges.map(\.label), ["All Usage"])
        XCTAssertEqual(grok.gauges[0].breakdown?.map(\.name), ["Build"])
        let anthropic = sections.first { $0.provider == "anthropic" }!
        // Anthropic suffixed rows stay as their own rows.
        XCTAssertEqual(anthropic.gauges.map(\.label), ["All models", "Fable"])
    }

    func testUnnamedAccountMergesIntoSoleNamedAccount() {
        let sections = GaugeBuilder.sections(from: snapshot([
            observation(provider: "codex", entitlement: "codex-pro:miladmaaan@gmail.com"),
            observation(provider: "codex", entitlement: "codex-spark")
        ]))
        XCTAssertEqual(sections.count, 1)
        XCTAssertEqual(sections[0].accountDisplay, "personal")
        XCTAssertEqual(sections[0].gauges.count, 2)
    }

    func testOverallRemainingIsLimitWeightedAverage() {
        let gauges = [
            GaugeBuilder.allowanceGauge(observation(used: 100)), // 1.0
            GaugeBuilder.allowanceGauge(observation(used: 0))    // 0.0
        ]
        let section = UsageSection(provider: "anthropic", account: nil,
                                   plan: PlanInfo(name: "", dollars: 100), gauges: gauges)
        XCTAssertEqual(GaugeBuilder.overallUsedFraction([section])!, 0.5)
        XCTAssertNil(GaugeBuilder.overallUsedFraction([]))
    }

    func testDollarWeightingFavorsExpensivePlan() {
        // Max ($200, 50% used) should dominate Pro ($20, 100% used).
        let maxSection = UsageSection(
            provider: "anthropic", account: "a", plan: PlanInfo(name: "Max 20x", dollars: 200),
            gauges: [GaugeBuilder.allowanceGauge(observation(used: 50))])
        let proSection = UsageSection(
            provider: "anthropic", account: "b", plan: PlanInfo(name: "Pro", dollars: 20),
            gauges: [GaugeBuilder.allowanceGauge(observation(used: 100))])
        let overall = GaugeBuilder.overallUsedFraction([maxSection, proSection])!
        XCTAssertGreaterThan(overall, 0.5)
        XCTAssertLessThan(overall, 0.6)
    }

    func testCreditRowsKeepRateLimitsDropped() {
        let sections = GaugeBuilder.sections(from: snapshot([
            observation(metric: "credit", used: nil, limit: nil, remaining: 12.5),
            observation(provider: "venice", entitlement: "venice-model:gpt", metric: "rate_limit", window: "minute", used: nil, limit: 100),
            observation(entitlement: "codex-dollar-credit:x", metric: "credit", used: nil, limit: nil, remaining: 0)
        ]))
        // Credits are always shown now (bank/balance rows), even at $0; rate limits stay dropped.
        XCTAssertEqual(sections.count, 2)
        XCTAssertEqual(sections.reduce(0) { $0 + $1.gauges.count }, 2)
    }

    func testFractionClamped() {
        XCTAssertEqual(observation(used: 150).fractionUsed, 1.0)
        XCTAssertNil(observation(used: nil).fractionUsed)
    }
}
