import XCTest
@testable import CcsSidebarUI

/// The open-sessions filter, which decides what the list carries before any group is drawn.
///
/// Independent of collapse by design, so these pin what "open" means and that filtering empties a
/// group out of existence rather than leaving a header with nothing under it.
final class RowVisibilityTests: XCTestCase {
    private func row(_ name: String, density: String) -> SidebarRow {
        let json: [String: Any] = [
            "kind": "session", "id": name, "name": name, "density": density,
            "unread": 0, "pinned": false, "focused": false,
        ]
        return try! JSONDecoder().decode(
            SidebarRow.self, from: try! JSONSerialization.data(withJSONObject: json)
        )
    }

    private func workspaceRow(_ name: String) -> SidebarRow {
        let json: [String: Any] = [
            "kind": "workspace", "id": name, "name": name, "density": "compact",
            "unread": 0, "pinned": false, "focused": false,
        ]
        return try! JSONDecoder().decode(
            SidebarRow.self, from: try! JSONSerialization.data(withJSONObject: json)
        )
    }

    func testOpenMeansStillRunning() {
        XCTAssertTrue(row("live", density: "full").isOpen)
        XCTAssertFalse(row("closed", density: "compact").isOpen)
        // A workspace tab has no session to have ended; it is on screen by definition.
        XCTAssertTrue(workspaceRow("tab").isOpen)
    }

    func testEachSettingCarriesWhatItSays() {
        let rows = [row("live", density: "full"), row("closed", density: "compact")]

        XCTAssertEqual(RowVisibility.all.filter(rows).map(\.name), ["live", "closed"])
        XCTAssertEqual(RowVisibility.openOnly.filter(rows).map(\.name), ["live"])
    }

    func testFilteringRemovesAGroupRatherThanEmptyingIt() {
        // Filtering before grouping is what keeps the sidebar short: an event whose sessions have
        // all finished should not leave a header behind with nothing under it.
        let rows = [
            row("live worker", density: "full"),
            row("finished worker", density: "compact"),
        ]

        let groups = Grouping.group(rows: RowVisibility.openOnly.filter(rows), by: .recent)

        XCTAssertEqual(groups.map(\.totalRows), [1])
        XCTAssertEqual(groups.first?.rows.map(\.name), ["live worker"])
    }
}
