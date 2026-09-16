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
        resetsAt: Date? = Date(timeIntervalSinceNow: 3600),
        stale: Bool? = nil,
        observedAt: Date? = nil
    ) -> UsageObservation {
        UsageObservation(
            provider: provider, entitlement: entitlement, metric: metric,
            scope: "account", window: window, used: used, limit: limit,
            remaining: remaining, resetsAt: resetsAt, expiresAt: nil, exact: true, stale: stale, tier: nil,
            observedAt: observedAt
        )
    }

    /// A weekly Claude allowance row for one account, `#Fable`-scoped when `fable` is set.
    private func claudeWeekly(
        account: String, fable: Bool, used: Double?, limit: Double? = 100,
        observedAt: Date?, resetsAt: Date?, stale: Bool? = nil
    ) -> UsageObservation {
        let fullAccount = account == "miladmaaan" ? "miladmaaan@gmail.com"
            : account == "milad" ? "milad@afternoonumbrellafriends.com"
            : account.contains("@") ? account : "\(account)@example.com"
        return observation(
            provider: "anthropic",
            entitlement: "claude-max:\(fullAccount)\(fable ? "#Fable" : "")",
            window: "weekly", used: used, limit: limit, resetsAt: resetsAt,
            stale: stale, observedAt: observedAt
        )
    }

    private func subscription(
        provider: String = "anthropic",
        account: String? = "miladmaaan@gmail.com",
        planName: String = "Max 20x",
        monthlyDollars: Double = 200,
        renewsOn: String? = "2026-10-10"
    ) -> SubscriptionInfo {
        SubscriptionInfo(
            provider: provider, account: account, planName: planName,
            monthlyDollars: monthlyDollars, renewsOn: renewsOn, source: "configured"
        )
    }

    private func snapshot(
        _ observations: [UsageObservation],
        subscriptions: [SubscriptionInfo] = []
    ) -> UsageSnapshot {
        UsageSnapshot(generatedAt: nil, observations: observations, subscriptions: subscriptions)
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
        XCTAssertEqual(parsed.subscriptions, [])
        XCTAssertNotNil(parsed.generatedAt)
        XCTAssertNotNil(parsed.observations[0].resetsAt)
        XCTAssertNotNil(parsed.observations[1].resetsAt)
    }

    func testDecodesSubscriptionAndBuildsPlanRenewalData() throws {
        let json = """
        {"generatedAt":"2026-09-13T00:00:00Z","observations":[],"subscriptions":[
          {"provider":"venice","account":null,"planName":"Pro","monthlyDollars":68,"renewsOn":"2026-10-09","source":"configured"}
        ],"adapters":[]}
        """.data(using: .utf8)!
        let parsed = try SnapshotDecoder.decode(json)
        XCTAssertEqual(parsed.subscriptions.count, 1)
        let section = try XCTUnwrap(GaugeBuilder.sections(from: parsed).first)
        XCTAssertNil(section.account)
        XCTAssertEqual(section.plan, PlanInfo(name: "Pro", dollars: 68))
        XCTAssertEqual(section.subscription?.renewalDisplay, "Oct 9")
        XCTAssertEqual(section.gauges, [])
    }

    func testDecodesUnknownSubscriptionRenewal() throws {
        let json = """
        {"generatedAt":"2026-09-13T00:00:00Z","observations":[],"subscriptions":[
          {"provider":"venice","account":null,"planName":"Pro","monthlyDollars":68,"renewsOn":null,"source":"unknown"}
        ],"adapters":[]}
        """.data(using: .utf8)!
        let parsed = try SnapshotDecoder.decode(json)
        XCTAssertNil(parsed.subscriptions.first?.renewalDisplay)
    }

    func testOldSnapshotWithoutSubscriptionsKeepsLegacyPlansAndBill() throws {
        let json = """
        {"generatedAt":"2026-09-13T18:00:00Z","observations":[
          {"provider":"codex","entitlement":"codex-pro:miladmaaan@gmail.com","metric":"allowance","scope":"account","window":"weekly","used":22,"limit":100,"remaining":78,"resetsAt":null,"expiresAt":null,"observedAt":"2026-09-13T18:00:00Z","source":"official_cli","exact":false}
        ],"adapters":[]}
        """.data(using: .utf8)!
        let sections = GaugeBuilder.sections(from: try SnapshotDecoder.decode(json))
        XCTAssertEqual(sections.first?.plan, PlanInfo(name: "Codex Pro", dollars: 200))
        XCTAssertEqual(GaugeBuilder.monthlyBill(sections).total, 200)
    }

    func testSubscriptionMatchingUsesProviderAndFullAccount() throws {
        let sections = GaugeBuilder.sections(from: snapshot([
            observation(entitlement: "claude-max:miladmaaan@other.com"),
            observation(entitlement: "claude-max:miladmaaan@gmail.com")
        ], subscriptions: [subscription()]))
        let matching = try XCTUnwrap(sections.first { $0.account == "miladmaaan@gmail.com" })
        let other = try XCTUnwrap(sections.first { $0.account == "miladmaaan@other.com" })
        XCTAssertEqual(matching.subscription?.planName, "Max 20x")
        XCTAssertNil(other.subscription)
        XCTAssertEqual(matching.accountDisplay, "personal")
        XCTAssertEqual(other.accountDisplay, "miladmaaan@other.com")
    }

    func testSectionsGroupByProviderAndAccount() {
        let sections = GaugeBuilder.sections(from: snapshot([
            observation(entitlement: "claude-max:miladmaaan@gmail.com", window: "five_hour"),
            observation(entitlement: "claude-max:milad@afternoonumbrellafriends.com", window: "weekly"),
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
        XCTAssertEqual(fable.account, "miladmaaan@gmail.com")
        let plain = GaugeBuilder.allowanceGauge(observation(entitlement: "codex-pro:x@y.com"))
        XCTAssertEqual(plain.label, "All models")
    }

    func testEntitlementParts() {
        let parts = GaugeBuilder.entitlementParts("grok-super grok plus:m@x.com#build")
        XCTAssertEqual(parts.label, "Build")
        XCTAssertEqual(parts.account, "m@x.com")
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
        XCTAssertEqual(anthropic.gauges.map(\.label), ["All models", "Fable"])
        XCTAssertEqual(anthropic.displayGauges.map(\.label), ["All models"])
        XCTAssertEqual(anthropic.budgets.map(\.name), [.fable, .nonFable])
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

    func testOverallUsesBindingConstraintPerAccount() {
        let gauges = [
            GaugeBuilder.allowanceGauge(observation(used: 100)), // exhausted weekly cap
            GaugeBuilder.allowanceGauge(observation(used: 0))    // fresh 5h window
        ]
        let section = UsageSection(provider: "anthropic", account: nil,
                                   subscription: nil, gauges: gauges)
        // The exhausted window cancels out the fresh one — binding constraint wins.
        XCTAssertEqual(GaugeBuilder.overallUsedFraction([section])!, 1.0)
        XCTAssertNil(GaugeBuilder.overallUsedFraction([]))
    }

    func testExhaustedFableScopeDoesNotPinTheAccount() throws {
        let d = Date(timeIntervalSince1970: 1_757_000_000)
        let r = Date(timeIntervalSince1970: 1_757_500_000)
        let sections = GaugeBuilder.sections(from: snapshot([
            observation(entitlement: "claude-max:x@example.com", window: "five_hour",
                        used: 11, resetsAt: r, observedAt: d),
            claudeWeekly(account: "x", fable: false, used: 54, observedAt: d, resetsAt: r),
            claudeWeekly(account: "x", fable: true, used: 100, observedAt: d, resetsAt: r)
        ]))
        // Fable is a scope inside the weekly pool, so an exhausted Fable leaves
        // the account's own weekly cap as the binding constraint.
        XCTAssertEqual(try XCTUnwrap(GaugeBuilder.overallUsedFraction(sections)), 0.54, accuracy: 0.001)
    }

    func testScopedRowCountsWhenItsParentPoolIsMissing() throws {
        let d = Date(timeIntervalSince1970: 1_757_000_000)
        let r = Date(timeIntervalSince1970: 1_757_500_000)
        let sections = GaugeBuilder.sections(from: snapshot([
            claudeWeekly(account: "x", fable: true, used: 100, observedAt: d, resetsAt: r)
        ]))
        XCTAssertEqual(try XCTUnwrap(GaugeBuilder.overallUsedFraction(sections)), 1.0, accuracy: 0.001)
    }

    func testDollarWeightingFavorsExpensivePlan() {
        // Max ($200, 50% used) should dominate Pro ($20, 100% used).
        let maxSection = UsageSection(
            provider: "anthropic", account: "a", subscription: subscription(account: "a"),
            gauges: [GaugeBuilder.allowanceGauge(observation(used: 50))])
        let proSection = UsageSection(
            provider: "anthropic", account: "b",
            subscription: subscription(account: "b", planName: "Pro", monthlyDollars: 20),
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

    func testDecodesStaleObservationsAndAdapterHealth() throws {
        let json = """
        {"generatedAt":"2026-08-31T17:00:00Z","observations":[
          {"provider":"anthropic","entitlement":"claude-max:a@b.c","metric":"allowance","scope":"account","window":"weekly","used":9,"limit":100,"remaining":91,"resetsAt":"2026-09-01T21:00:00Z","expiresAt":null,"observedAt":"2026-08-27T23:40:37Z","source":"official_api","exact":false,"stale":true}
        ],"adapters":[
          {"provider":"anthropic","status":"degraded","detail":"a@b.c needs re-login (cswap add) — showing data from 3d ago"}
        ]}
        """.data(using: .utf8)!
        let parsed = try SnapshotDecoder.decode(json)
        XCTAssertEqual(parsed.observations[0].stale, true)
        XCTAssertNotNil(parsed.observations[0].observedAt)
        XCTAssertEqual(GaugeBuilder.healthNotes(parsed.adapters),
                       ["Claude — a@b.c needs re-login (cswap add) — showing data from 3d ago"])
    }

    func testStaleAgeSurfacesOldestStaleObservation() {
        let now = Date()
        let staleObs = UsageObservation(
            provider: "anthropic", entitlement: "claude-max:a@b.c", metric: "allowance",
            scope: "account", window: "weekly", used: 9, limit: 100, remaining: 91,
            resetsAt: nil, expiresAt: nil, exact: false, stale: true, tier: nil,
            observedAt: now.addingTimeInterval(-3 * 86_400)
        )
        let sections = GaugeBuilder.sections(from: snapshot([staleObs]))
        XCTAssertEqual(sections[0].staleAge(now: now), "3d")
        XCTAssertEqual(GaugeBuilder.shortAge(now.addingTimeInterval(-300), now: now), "5m")
        XCTAssertEqual(GaugeBuilder.shortAge(now.addingTimeInterval(-5 * 3600), now: now), "5h")
        // Live sections have no stale badge age.
        XCTAssertNil(GaugeBuilder.sections(from: snapshot([observation()]))[0].staleAge(now: now))
    }

    func testHealthNotesSkipHealthyAdapters() {
        let notes = GaugeBuilder.healthNotes([
            AdapterHealth(provider: "codex", status: "ok", detail: nil),
            AdapterHealth(provider: "grok", status: "unavailable", detail: "no unexpired grok OIDC token")
        ])
        XCTAssertEqual(notes, ["Grok — no unexpired grok OIDC token"])
        XCTAssertEqual(GaugeBuilder.healthNotes(nil), [])
    }

    func testFractionClamped() {
        XCTAssertEqual(observation(used: 150).fractionUsed, 1.0)
        XCTAssertNil(observation(used: nil).fractionUsed)
    }

    func testDuplicateGaugeIdsNeverTrap() {
        // Two banked reset credits with different expiries share an entitlement.
        let a = observation(provider: "codex", entitlement: "codex-reset-credit:m@x.com",
                            metric: "reset_credit", window: nil, used: nil, limit: nil, remaining: 1)
        let b = a
        let sections = GaugeBuilder.sections(from: snapshot([a, b]))
        XCTAssertEqual(sections.count, 1)
        XCTAssertEqual(sections[0].gauges.count, 2)
        XCTAssertEqual(Set(sections[0].gauges.map(\.id)).count, 2, "ids stay distinct for SwiftUI")
    }

    func testLiveSnapshotFixtureBuildsEveryGauge() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "usage-2026-09-05", withExtension: "json",
                                                  subdirectory: "Fixtures"))
        let parsed = try SnapshotDecoder.decode(Data(contentsOf: url))
        XCTAssertEqual(parsed.observations.count, 225)
        let sections = GaugeBuilder.sections(from: parsed)
        let gauges = sections.flatMap(\.gauges)
        XCTAssertEqual(gauges.count, 20)
        let displayed = sections.flatMap(\.displayGauges)
        XCTAssertEqual(displayed.count, 18)
        XCTAssertFalse(displayed.contains { $0.provider == "anthropic" && $0.label == "Fable" })
        XCTAssertEqual(Set(gauges.map(\.id)).count, gauges.count)
        XCTAssertEqual(gauges.filter { $0.label == "Banked reset" && $0.provider == "codex" }.count, 2)
        XCTAssertNotNil(GaugeBuilder.overallUsedFraction(sections))
        XCTAssertGreaterThan(GaugeBuilder.panelHeight(for: sections, noteCount: 1), 0)

        // Both Claude accounts carry a Fable + non-Fable budget derived from their weekly rows.
        let anthropic = sections.filter { $0.provider == "anthropic" }
        XCTAssertEqual(anthropic.count, 2)
        for s in anthropic { XCTAssertEqual(s.budgets.map(\.name), [.fable, .nonFable]) }
        let personal = try XCTUnwrap(anthropic.first { $0.accountDisplay == "personal" })
        // personal weekly 29%, Fable 48%: the Fable cap is the fuller meter.
        guard case .known(let pFable, _, _, let pFableBinding) = personal.budgets[0].usage,
              case .known(let pNonFable, _, _, _) = personal.budgets[1].usage else { return XCTFail("personal budgets known") }
        XCTAssertEqual(pFable, 48, accuracy: 0.001)
        XCTAssertEqual(pFableBinding, .ownCap)
        XCTAssertEqual(pNonFable, 29, accuracy: 0.001)
        let auf = try XCTUnwrap(anthropic.first { $0.accountDisplay == "auf" })
        // auf weekly 18%, Fable 0% with no reset: the shared pool binds both budgets.
        guard case .known(let aFable, _, _, let aFableBinding) = auf.budgets[0].usage,
              case .known(let aNonFable, _, _, _) = auf.budgets[1].usage else { return XCTFail("auf budgets known") }
        XCTAssertEqual(aFable, 18, accuracy: 0.001)
        XCTAssertEqual(aFableBinding, .sharedPool)
        XCTAssertEqual(aNonFable, 18, accuracy: 0.001)
    }

    // MARK: - Claude Fable / non-Fable budgets

    func testFableCapBindsWhenItIsTheFullerMeter() {
        let d = Date(timeIntervalSince1970: 1_757_000_000)
        let r = Date(timeIntervalSince1970: 1_757_500_000)
        let personal = ClaudeBudgets.compute([
            claudeWeekly(account: "miladmaaan", fable: false, used: 48, observedAt: d, resetsAt: r),
            claudeWeekly(account: "miladmaaan", fable: true, used: 95, observedAt: d, resetsAt: r)
        ])
        XCTAssertEqual(personal.map(\.name), [.fable, .nonFable])
        XCTAssertEqual(personal[0].usage, .known(usedPct: 95, resetsAt: r, cached: false, binding: .ownCap))
        XCTAssertEqual(personal[1].usage, .known(usedPct: 48, resetsAt: r, cached: false, binding: .sharedPool))
    }

    func testSharedPoolBindsTheFableBudgetOnceItPassesTheFableCap() {
        let d = Date(timeIntervalSince1970: 1_757_000_000)
        let r = Date(timeIntervalSince1970: 1_757_500_000)
        // The old model read this as a 40% Fable budget while every Fable request was failing.
        let budgets = ClaudeBudgets.compute([
            claudeWeekly(account: "x", fable: false, used: 93, observedAt: d, resetsAt: r),
            claudeWeekly(account: "x", fable: true, used: 40, observedAt: d, resetsAt: r)
        ])
        XCTAssertEqual(budgets[0].usage, .known(usedPct: 93, resetsAt: r, cached: false, binding: .sharedPool))
        XCTAssertEqual(budgets[1].usage, .known(usedPct: 93, resetsAt: r, cached: false, binding: .sharedPool))
    }

    func testNeitherBudgetExceedsAMeterThatWasActuallyPublished() {
        let d = Date(timeIntervalSince1970: 1_757_000_000)
        let r = Date(timeIntervalSince1970: 1_757_500_000)
        // The old model turned these two in-range readings into an impossible 2*90 - 40 = 140%.
        let budgets = ClaudeBudgets.compute([
            claudeWeekly(account: "x", fable: false, used: 90, observedAt: d, resetsAt: r),
            claudeWeekly(account: "x", fable: true, used: 40, observedAt: d, resetsAt: r)
        ])
        XCTAssertEqual(budgets[0].usage, .known(usedPct: 90, resetsAt: r, cached: false, binding: .sharedPool))
        XCTAssertEqual(budgets[1].usage, .known(usedPct: 90, resetsAt: r, cached: false, binding: .sharedPool))
    }

    func testAnExhaustedFableCapOverAnEmptyPoolIsAnOrdinaryReading() {
        let d = Date(timeIntervalSince1970: 1_757_000_000)
        let r = Date(timeIntervalSince1970: 1_757_500_000)
        let budgets = ClaudeBudgets.compute([
            claudeWeekly(account: "x", fable: false, used: 10, observedAt: d, resetsAt: r),
            claudeWeekly(account: "x", fable: true, used: 100, observedAt: d, resetsAt: r)
        ])
        XCTAssertEqual(budgets[0].usage, .known(usedPct: 100, resetsAt: r, cached: false, binding: .ownCap))
        XCTAssertEqual(budgets[1].usage, .known(usedPct: 10, resetsAt: r, cached: false, binding: .sharedPool))
    }

    func testZeroFableUsageWithNoFableResetStillPermitsABudget() {
        let d = Date(timeIntervalSince1970: 1_757_000_000)
        let r = Date(timeIntervalSince1970: 1_757_500_000)
        let budgets = ClaudeBudgets.compute([
            claudeWeekly(account: "x", fable: false, used: 18, observedAt: d, resetsAt: r),
            claudeWeekly(account: "x", fable: true, used: 0, observedAt: d, resetsAt: nil)
        ])
        XCTAssertEqual(budgets[0].usage, .known(usedPct: 18, resetsAt: r, cached: false, binding: .sharedPool))
        XCTAssertEqual(budgets[1].usage, .known(usedPct: 18, resetsAt: r, cached: false, binding: .sharedPool))
    }

    func testStalenessRidesAlongAsCachedRatherThanBlockingTheBudget() {
        let d = Date(timeIntervalSince1970: 1_757_000_000)
        let r = Date(timeIntervalSince1970: 1_757_500_000)
        let budgets = ClaudeBudgets.compute([
            claudeWeekly(account: "x", fable: false, used: 40, observedAt: d, resetsAt: r, stale: true),
            claudeWeekly(account: "x", fable: true, used: 20, observedAt: d, resetsAt: r)
        ])
        XCTAssertEqual(budgets[0].usage, .known(usedPct: 40, resetsAt: r, cached: true, binding: .sharedPool))
        XCTAssertEqual(budgets[1].usage, .known(usedPct: 40, resetsAt: r, cached: true, binding: .sharedPool))
    }

    func testAMissingFableReadingLeavesTheNonFableBudgetIntact() {
        let d = Date(timeIntervalSince1970: 1_757_000_000)
        let r = Date(timeIntervalSince1970: 1_757_500_000)
        let budgets = ClaudeBudgets.compute([
            claudeWeekly(account: "x", fable: false, used: 55, observedAt: d, resetsAt: r)
        ])
        XCTAssertEqual(budgets[0].usage, .unknown(reason: "Fable reading unavailable"))
        XCTAssertEqual(budgets[1].usage, .known(usedPct: 55, resetsAt: r, cached: false, binding: .sharedPool))
    }

    func testAMissingWeeklyReadingLeavesBothBudgetsUnknown() {
        let d = Date(timeIntervalSince1970: 1_757_000_000)
        let r = Date(timeIntervalSince1970: 1_757_500_000)
        let budgets = ClaudeBudgets.compute([
            claudeWeekly(account: "x", fable: true, used: 95, observedAt: d, resetsAt: r)
        ])
        XCTAssertEqual(budgets[0].usage, .unknown(reason: "weekly reading unavailable"))
        XCTAssertEqual(budgets[1].usage, .unknown(reason: "weekly reading unavailable"))
    }

    func testUncomparableReadingsLeaveOnlyTheFableBudgetUnknown() {
        let d = Date(timeIntervalSince1970: 1_757_000_000)
        let r = Date(timeIntervalSince1970: 1_757_500_000)
        let mismatchTime = ClaudeBudgets.compute([
            claudeWeekly(account: "x", fable: false, used: 40, observedAt: d, resetsAt: r),
            claudeWeekly(account: "x", fable: true, used: 20, observedAt: d.addingTimeInterval(60), resetsAt: r)
        ])
        XCTAssertEqual(mismatchTime[0].usage, .unknown(reason: "observation times differ"))
        XCTAssertEqual(mismatchTime[1].usage, .known(usedPct: 40, resetsAt: r, cached: false, binding: .sharedPool))

        let mismatchReset = ClaudeBudgets.compute([
            claudeWeekly(account: "x", fable: false, used: 40, observedAt: d, resetsAt: r),
            claudeWeekly(account: "x", fable: true, used: 20, observedAt: d, resetsAt: r.addingTimeInterval(3600))
        ])
        XCTAssertEqual(mismatchReset[0].usage, .unknown(reason: "reset windows differ"))
        XCTAssertEqual(mismatchReset[1].usage, .known(usedPct: 40, resetsAt: r, cached: false, binding: .sharedPool))

        // Account mismatch inside one bucket yields no budgets at all.
        XCTAssertTrue(ClaudeBudgets.compute([
            claudeWeekly(account: "a", fable: false, used: 40, observedAt: d, resetsAt: r),
            claudeWeekly(account: "b", fable: false, used: 41, observedAt: d, resetsAt: r)
        ]).isEmpty)
    }

    func testBudgetsPerAccountPreserveProviderLimitsAndOverall() throws {
        let d = Date(timeIntervalSince1970: 1_757_000_000)
        let r = Date(timeIntervalSince1970: 1_757_500_000)
        let sections = GaugeBuilder.sections(from: snapshot([
            claudeWeekly(account: "miladmaaan", fable: false, used: 48, observedAt: d, resetsAt: r),
            claudeWeekly(account: "miladmaaan", fable: true, used: 95, observedAt: d, resetsAt: r),
            claudeWeekly(account: "milad", fable: false, used: 85, observedAt: d, resetsAt: r),
            claudeWeekly(account: "milad", fable: true, used: 50, observedAt: d, resetsAt: r)
        ]))
        XCTAssertEqual(sections.count, 2)
        for s in sections {
            XCTAssertEqual(s.budgets.map(\.name), [.fable, .nonFable])
            XCTAssertFalse(s.displayGauges.contains { $0.label == "Fable" })
            XCTAssertTrue(s.gauges.contains { $0.label == "Fable" })
        }
        let personal = try XCTUnwrap(sections.first { $0.accountDisplay == "personal" })
        // Weekly 48% binds, not the 95% Fable scope sitting inside it.
        XCTAssertEqual(try XCTUnwrap(GaugeBuilder.overallUsedFraction([personal])), 0.48, accuracy: 0.001)
        let auf = try XCTUnwrap(sections.first { $0.accountDisplay == "auf" })
        XCTAssertEqual(auf.budgets[0].usage, .known(usedPct: 85, resetsAt: r, cached: false, binding: .sharedPool))
        XCTAssertEqual(auf.budgets[1].usage, .known(usedPct: 85, resetsAt: r, cached: false, binding: .sharedPool))
        XCTAssertEqual(try XCTUnwrap(GaugeBuilder.overallUsedFraction([auf])), 0.85, accuracy: 0.001)
    }

    func testPanelHeightAccountsForSubscriptionDetailRows() {
        let observation = observation(provider: "other", entitlement: "other-plan")
        let without = GaugeBuilder.sections(from: snapshot([observation]))
        let with = GaugeBuilder.sections(from: snapshot([observation], subscriptions: [
            subscription(provider: "other", account: nil, planName: "Pro", monthlyDollars: 68)
        ]))
        XCTAssertEqual(GaugeBuilder.panelHeight(for: with) - GaugeBuilder.panelHeight(for: without), 18)
    }
}
