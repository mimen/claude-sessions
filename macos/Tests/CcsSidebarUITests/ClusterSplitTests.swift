import XCTest
@testable import CcsSidebarUI

/// Splitting a lifted cluster into readable parts.
///
/// The event axis is decoded from the identity, the role axis is half decoded and half derived
/// from the title, and the difference matters: a retitled worker must not change events.
final class ClusterSplitTests: XCTestCase {
    private func row(
        _ name: String,
        cluster: String? = "event-watch",
        role: String? = "event-worker",
        workRef: String? = nil,
        workLabel: String? = nil,
        workStartsAt: Double? = nil
    ) -> SidebarRow {
        let membership: [String: Any] = [
            "cluster": cluster as Any,
            "role": role as Any,
            "workRef": workRef as Any,
            "workLabel": workLabel as Any,
            "workStartsAt": workStartsAt as Any,
        ].compactMapValues { $0 is NSNull ? nil : $0 }
        let json: [String: Any] = [
            "kind": "session", "id": name, "name": name, "density": "full", "unread": 0,
            "pinned": false, "focused": false, "membership": membership,
        ]
        let data = try! JSONSerialization.data(withJSONObject: json)
        return try! JSONDecoder().decode(SidebarRow.self, from: data)
    }

    func testEventSplitGroupsByIdentityNotTitle() {
        let operations = row("Kiki Factory event operations", workRef: "kiki-factory", workLabel: "Kiki Factory")
        let closeout = row("Something else entirely", workRef: "kiki-factory", workLabel: "Kiki Factory")

        let groups = Grouping.group(
            rows: [operations, closeout], by: .status, clusterFirst: true, clusterSplit: .work
        )

        XCTAssertEqual(groups.map(\.name), ["event-watch"])
        XCTAssertEqual(groups.first?.children.map(\.name), ["Kiki Factory"])
        XCTAssertEqual(groups.first?.children.first?.rows.count, 2)
    }

    func testEventSplitKeepsDistinctEventsApart() {
        let groups = Grouping.group(
            rows: [
                row("a", workRef: "freakuency", workLabel: "Freakuency"),
                row("b", workRef: "kiki-factory", workLabel: "Kiki Factory"),
            ],
            by: .status, clusterFirst: true, clusterSplit: .work
        )

        XCTAssertEqual(groups.map(\.name), ["event-watch"])
        XCTAssertEqual(groups.first?.children.map(\.name), ["Freakuency", "Kiki Factory"])
        // The nested key is scoped by its parent, so two clusters may hold a part of the same name
        // without sharing one collapse state.
        XCTAssertEqual(groups.first?.children.map(\.key), ["event-watch/Freakuency", "event-watch/Kiki Factory"])
    }

    func testRoleSplitSeparatesCoreRolesFromWorkerPhases() {
        let groups = Grouping.group(
            rows: [
                row("event-watch · coordinator", role: "coordinator"),
                row("Kiki Factory event operations", workRef: "kiki-factory", workLabel: "Kiki Factory"),
                row("Freedom Fest event closeout", workRef: "freedom-fest", workLabel: "Freedom Fest"),
                row("Pizza popup August event worker", workRef: "pizza-popup-august", workLabel: "Pizza Popup August"),
            ],
            by: .status, clusterFirst: true, clusterSplit: .role
        )

        XCTAssertEqual(groups.map(\.name), ["event-watch"])
        // Core roles get their own bands here — this axis is "what kind of session is this", and a
        // coordinator is a kind. Under the event axis they instead sit directly under the cluster,
        // because a core identity is on no single event.
        XCTAssertEqual(groups.first?.children.map(\.name), ["Coordinator", "Operations", "Closeout", "Workers"])
        XCTAssertTrue(groups.first?.rows.isEmpty == true)
    }

    func testNoSplitLeavesTheClusterWhole() {
        let groups = Grouping.group(
            rows: [
                row("a", workRef: "freakuency", workLabel: "Freakuency"),
                row("b", workRef: "kiki-factory", workLabel: "Kiki Factory"),
            ],
            by: .status, clusterFirst: true, clusterSplit: .none
        )

        XCTAssertEqual(groups.map(\.name), ["event-watch"])
    }

    func testAClusterMemberWithNoWorkItemStaysUnderTheBareCluster() {
        // Splitting must never drop a row: a member the axis cannot place still belongs to its
        // cluster, so it lands in the plain group rather than vanishing or inventing "Other".
        let groups = Grouping.group(
            rows: [row("mystery", role: nil)], by: .status, clusterFirst: true, clusterSplit: .work
        )

        XCTAssertEqual(groups.map(\.name), ["event-watch"])
        XCTAssertEqual(groups.first?.rows.count, 1)
        XCTAssertTrue(groups.first?.children.isEmpty == true)
        XCTAssertEqual(groups.first?.totalRows, 1)
    }

    func testEventsReadInDateOrderWithCoreLeading() {
        let groups = Grouping.group(
            rows: [
                // Arrival order is deliberately not date order: the November event is listed first
                // and the core session last.
                row("a", workRef: "freakuency", workLabel: "Freakuency", workStartsAt: 1_793_000_000_000),
                row("b", workRef: "kiki-factory", workLabel: "Kiki Factory", workStartsAt: 1_784_000_000_000),
                row("undated", workRef: "mystery", workLabel: "Mystery"),
                row("event-watch · scout", role: "scout"),
            ],
            by: .status, clusterFirst: true, clusterSplit: .work
        )

        // Core first because it is the way in, then events oldest to newest, then whatever the
        // cluster recorded no date for — left in arrival order rather than guessed at.
        XCTAssertEqual(
            groups.first?.children.map(\.name),
            ["Core", "Kiki Factory", "Freakuency", "Mystery"]
        )
        XCTAssertTrue(groups.first?.rows.isEmpty == true)
    }

    func testTheParentCountsEveryNestedRow() {
        let groups = Grouping.group(
            rows: [
                row("event-watch · scout", role: "scout"),
                row("a", workRef: "freakuency", workLabel: "Freakuency"),
                row("b", workRef: "kiki-factory", workLabel: "Kiki Factory"),
            ],
            by: .status, clusterFirst: true, clusterSplit: .work
        )

        // A collapsed cluster still has to say how much is inside it.
        XCTAssertEqual(groups.first?.totalRows, 3)
    }

    func testCloseoutWinsATitleNamingBothPhases() {
        XCTAssertEqual(WorkerPhase.of(row("Freedom Fest operations and closeout")), .closeout)
    }
}
