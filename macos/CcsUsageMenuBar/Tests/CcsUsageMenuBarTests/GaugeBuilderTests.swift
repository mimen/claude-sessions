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

    func testSubscriptionMatchingUsesProviderAndFullAccount() throws {
        let sections = GaugeBuilder.sections(from: snapshot([
            observation(entitlement: "claude-max:miladmaaan@other.com"),
            observation(entitlement: "claude-max:miladmaaan@gmail.com")
        ], subscriptions: [subscription()]))
        let matching = try XCTUnwrap(sections.first { $0.account == "miladmaaan@gmail.com" })
        let other = try XCTUnwrap(sections.first { $0.account == "miladmaaan@other.com" })
        XCTAssertEqual(matching.subscription?.planName, "Max 20x")
        XCTAssertNil(other.subscription)
        XCTAssertEqual(matching.accountDisplay, "miladmaaan@gmail.com")
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
        XCTAssertEqual(sections[0].accountDisplay, "miladmaaan@gmail.com")
        XCTAssertEqual(sections[0].gauges.map(\.windowLabel), ["5h", "wk"])
        XCTAssertEqual(sections[1].accountDisplay, "milad@afternoonumbrellafriends.com")
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
    }

    func testUnnamedAccountMergesIntoSoleNamedAccount() {
        let sections = GaugeBuilder.sections(from: snapshot([
            observation(provider: "codex", entitlement: "codex-pro:miladmaaan@gmail.com"),
            observation(provider: "codex", entitlement: "codex-spark")
        ]))
        XCTAssertEqual(sections.count, 1)
        XCTAssertEqual(sections[0].accountDisplay, "miladmaaan@gmail.com")
        XCTAssertEqual(sections[0].gauges.count, 2)
    }

    func testFiveHourReadingRespectsTheWeeklyCap() {
        let gauges = [
            GaugeBuilder.allowanceGauge(observation(window: "weekly", used: 100)), // exhausted weekly cap
            GaugeBuilder.allowanceGauge(observation(window: "five_hour", used: 0)) // fresh 5h window
        ]
        let section = UsageSection(provider: "anthropic", account: nil,
                                   subscription: nil, gauges: gauges)
        // A fresh 5h window cannot outspend the exhausted weekly pool.
        let reading = GaugeBuilder.overallReading([section])
        XCTAssertEqual(reading.fiveHour!, 1.0)
        XCTAssertEqual(reading.sevenDay!, 1.0)
        let empty = GaugeBuilder.overallReading([])
        XCTAssertNil(empty.fiveHour)
        XCTAssertNil(empty.sevenDay)
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
        let reading = GaugeBuilder.overallReading(sections)
        XCTAssertEqual(try XCTUnwrap(reading.sevenDay), 0.54, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(reading.fiveHour), 0.54, accuracy: 0.001)
    }

    func testScopedRowCountsWhenItsParentPoolIsMissing() throws {
        let d = Date(timeIntervalSince1970: 1_757_000_000)
        let r = Date(timeIntervalSince1970: 1_757_500_000)
        let sections = GaugeBuilder.sections(from: snapshot([
            claudeWeekly(account: "x", fable: true, used: 100, observedAt: d, resetsAt: r)
        ]))
        let reading = GaugeBuilder.overallReading(sections)
        XCTAssertEqual(try XCTUnwrap(reading.sevenDay), 1.0, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(reading.fiveHour), 1.0, accuracy: 0.001)
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
        let overall = GaugeBuilder.overallReading([maxSection, proSection]).sevenDay!
        XCTAssertGreaterThan(overall, 0.5)
        XCTAssertLessThan(overall, 0.6)
    }

    func testWeeklyOnlySectionFallsThroughToFiveHour() {
        // A sub with no 5h cap reads its weekly cap as the 5h availability.
        let section = UsageSection(provider: "anthropic", account: nil, subscription: nil,
            gauges: [GaugeBuilder.allowanceGauge(observation(window: "weekly", used: 24))])
        let reading = GaugeBuilder.overallReading([section])
        XCTAssertEqual(reading.fiveHour!, 0.24, accuracy: 0.001)
        XCTAssertEqual(reading.sevenDay!, 0.24, accuracy: 0.001)
    }

    func testFiveHourAboveWeeklyReportsBothWindows() {
        let section = UsageSection(provider: "anthropic", account: nil, subscription: nil, gauges: [
            GaugeBuilder.allowanceGauge(observation(window: "five_hour", used: 54)),
            GaugeBuilder.allowanceGauge(observation(window: "weekly", used: 24))
        ])
        let reading = GaugeBuilder.overallReading([section])
        XCTAssertEqual(reading.fiveHour!, 0.54, accuracy: 0.001)
        XCTAssertEqual(reading.sevenDay!, 0.24, accuracy: 0.001)
    }

    func testAccountWithNeitherWindowDropsFromBoth() {
        let weekly = UsageSection(provider: "anthropic", account: "a", subscription: subscription(account: "a"),
            gauges: [GaugeBuilder.allowanceGauge(observation(window: "weekly", used: 40))])
        // A daily-only account has neither a 5h nor a weekly reading; it must not dilute either.
        let daily = UsageSection(provider: "codex", account: "b", subscription: nil,
            gauges: [GaugeBuilder.allowanceGauge(observation(provider: "codex",
                entitlement: "codex-pro:b@x.com", window: "daily", used: 90))])
        let reading = GaugeBuilder.overallReading([weekly, daily])
        XCTAssertEqual(reading.fiveHour!, 0.40, accuracy: 0.001)
        XCTAssertEqual(reading.sevenDay!, 0.40, accuracy: 0.001)
    }

    func testExhaustedWeeklyForcesFiveHourToOne() {
        let section = UsageSection(provider: "anthropic", account: nil, subscription: nil, gauges: [
            GaugeBuilder.allowanceGauge(observation(window: "five_hour", used: 20)),
            GaugeBuilder.allowanceGauge(observation(window: "weekly", used: 100))
        ])
        let reading = GaugeBuilder.overallReading([section])
        XCTAssertEqual(reading.fiveHour!, 1.0)
        XCTAssertEqual(reading.sevenDay!, 1.0)
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
        XCTAssertEqual(Set(gauges.map(\.id)).count, gauges.count)
        XCTAssertEqual(gauges.filter { $0.label == "Banked reset" && $0.provider == "codex" }.count, 2)
        let reading = GaugeBuilder.overallReading(sections)
        XCTAssertNotNil(reading.sevenDay)
        XCTAssertNotNil(reading.fiveHour)
        XCTAssertGreaterThan(GaugeBuilder.panelHeight(for: sections, noteCount: 1), 0)
    }

    func testFableScopeStaysOutOfTheOverallReading() throws {
        let d = Date(timeIntervalSince1970: 1_757_000_000)
        let r = Date(timeIntervalSince1970: 1_757_500_000)
        let sections = GaugeBuilder.sections(from: snapshot([
            claudeWeekly(account: "miladmaaan", fable: false, used: 48, observedAt: d, resetsAt: r),
            claudeWeekly(account: "miladmaaan", fable: true, used: 95, observedAt: d, resetsAt: r)
        ]))
        let personal = try XCTUnwrap(sections.first)
        XCTAssertEqual(personal.gauges.map(\.label), ["All models", "Fable"])
        // Weekly 48% binds, not the 95% Fable scope sitting inside it.
        XCTAssertEqual(try XCTUnwrap(GaugeBuilder.overallReading([personal]).sevenDay), 0.48, accuracy: 0.001)
    }

    func testPanelHeightAccountsForSubscriptionDetailRows() {
        let observation = observation(provider: "other", entitlement: "other-plan")
        let without = GaugeBuilder.sections(from: snapshot([observation]))
        let with = GaugeBuilder.sections(from: snapshot([observation], subscriptions: [
            subscription(provider: "other", account: nil, planName: "Pro", monthlyDollars: 68)
        ]))
        XCTAssertEqual(GaugeBuilder.panelHeight(for: with) - GaugeBuilder.panelHeight(for: without), 18)
    }

    // MARK: - Reliability and order

    func testUnreachableProviderKeepsItsLastRowsMarkedStale() {
        let old = Date(timeIntervalSince1970: 1_757_000_000)
        let previous = snapshot([
            observation(provider: "grok", entitlement: "grok-super grok plus:m@x.com", used: 40, observedAt: old),
            observation(provider: "codex", entitlement: "codex-pro:m@x.com", used: 10, observedAt: old)
        ])
        let fresh = UsageSnapshot(
            generatedAt: old.addingTimeInterval(300),
            observations: [observation(provider: "codex", entitlement: "codex-pro:m@x.com", used: 12)],
            adapters: [AdapterHealth(provider: "grok", status: "unavailable", detail: "HTTP 500"),
                       AdapterHealth(provider: "codex", status: "ok", detail: nil)]
        )
        let merged = fresh.carryingForward(previous)
        XCTAssertEqual(merged.observations.map(\.provider), ["codex", "grok"])
        XCTAssertEqual(merged.observations[0].used, 12, "a reporting provider is never overwritten")
        XCTAssertEqual(merged.observations[1].used, 40)
        XCTAssertEqual(merged.observations[1].stale, true)
        XCTAssertEqual(merged.observations[1].observedAt, old, "the stale badge ages from the real fetch")
    }

    func testAProviderThatWasSimplyRemovedIsNotResurrected() {
        let previous = snapshot([observation(provider: "grok", entitlement: "grok-super grok plus:m@x.com")])
        let fresh = snapshot([observation(provider: "codex", entitlement: "codex-pro:m@x.com")])
        XCTAssertEqual(fresh.carryingForward(previous).observations.map(\.provider), ["codex"])
    }

    func testSavedOrderWinsAndUnknownSectionsKeepNaturalOrderAtTheEnd() {
        let sections = GaugeBuilder.sections(from: snapshot([
            observation(provider: "anthropic", entitlement: "claude-max:a@x.com"),
            observation(provider: "codex", entitlement: "codex-pro:a@x.com"),
            observation(provider: "grok", entitlement: "grok-super grok plus:a@x.com"),
            observation(provider: "venice", entitlement: "venice-pro")
        ]))
        let ordered = GaugeBuilder.ordered(sections, by: ["grok|a@x.com", "stale|gone", "anthropic|a@x.com"])
        XCTAssertEqual(ordered.map(\.provider), ["grok", "anthropic", "codex", "venice"])
    }

    func testDraggingReachesEverySlot() {
        let ids = ["a", "b", "c", "d"]
        XCTAssertEqual(GaugeBuilder.reordered(ids, moving: "a", onto: "d"), ["b", "c", "d", "a"])
        XCTAssertEqual(GaugeBuilder.reordered(ids, moving: "d", onto: "a"), ["d", "a", "b", "c"])
        XCTAssertEqual(GaugeBuilder.reordered(ids, moving: "b", onto: "c"), ["a", "c", "b", "d"])
        XCTAssertEqual(GaugeBuilder.reordered(ids, moving: "b", onto: "b"), ids)
    }


    func testRowsFollowTheirSavedOrderWithNewRowsAfter() {
        let ids = ["a|5h", "a|wk", "a|fable", "a|reset"]
        let ordered = GaugeBuilder.ordered(ids, by: ["a|fable", "a|5h"], id: { $0 })
        XCTAssertEqual(ordered, ["a|fable", "a|5h", "a|wk", "a|reset"])
    }

    func testAnUnconfiguredClaudeAccountNamesItsPlanFromItsTierOnly() {
        var row = observation(entitlement: "claude-max:someone@example.com")
        row = UsageObservation(provider: row.provider, entitlement: row.entitlement, metric: row.metric,
                               scope: row.scope, window: row.window, used: row.used, limit: row.limit,
                               remaining: row.remaining, resetsAt: row.resetsAt, expiresAt: nil,
                               exact: true, stale: nil, tier: "default_claude_max_20x")
        let claude = GaugeBuilder.sections(from: snapshot([row]))
        XCTAssertEqual(claude.first?.plan, PlanInfo(name: "Max 20x", dollars: 200))
        let codex = GaugeBuilder.sections(from: snapshot([observation(provider: "codex", entitlement: "codex-pro:miladmaaan@gmail.com")]))
        XCTAssertNil(codex.first?.plan, "no hardcoded per-account plan table")
    }

}
