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
        workLabel: String? = nil
    ) -> SidebarRow {
        let membership: [String: Any] = [
            "cluster": cluster as Any,
            "role": role as Any,
            "workRef": workRef as Any,
            "workLabel": workLabel as Any,
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

        XCTAssertEqual(groups.map(\.name), ["event-watch · Kiki Factory"])
        XCTAssertEqual(groups.first?.rows.count, 2)
    }

    func testEventSplitKeepsDistinctEventsApart() {
        let groups = Grouping.group(
            rows: [
                row("a", workRef: "freakuency", workLabel: "Freakuency"),
                row("b", workRef: "kiki-factory", workLabel: "Kiki Factory"),
            ],
            by: .status, clusterFirst: true, clusterSplit: .work
        )

        XCTAssertEqual(groups.map(\.name), ["event-watch · Freakuency", "event-watch · Kiki Factory"])
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

        XCTAssertEqual(groups.map(\.name), [
            "event-watch · Coordinator",
            "event-watch · Operations",
            "event-watch · Closeout",
            "event-watch · Workers",
        ])
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
    }

    func testCloseoutWinsATitleNamingBothPhases() {
        XCTAssertEqual(WorkerPhase.of(row("Freedom Fest operations and closeout")), .closeout)
    }
}
