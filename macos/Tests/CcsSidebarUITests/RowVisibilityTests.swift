import XCTest
@testable import CcsSidebarUI

/// The per-group open-sessions filter.
///
/// Independent of collapse by design, so these pin what "open" means, what the filtered header
/// counts, and that toggling is a plain two-state flip rather than a cycle.
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

    func testTogglingIsATwoStateFlip() {
        XCTAssertEqual(RowVisibility.all.toggled, .openOnly)
        XCTAssertEqual(RowVisibility.openOnly.toggled, .all)
    }

    func testFilteredHeaderCountsRunningAgainstTotal() {
        let group = SidebarGroup(
            key: "event-watch",
            name: "event-watch",
            rows: [row("core", density: "full")],
            children: [
                SidebarGroup(
                    key: "event-watch/Freakuency",
                    name: "Freakuency",
                    rows: [row("a", density: "full"), row("b", density: "compact")],
                    children: []
                ),
            ]
        )

        // Both counts reach through nested bands: a filtered cluster header has to speak for its
        // events, not just for the rows sitting directly under it.
        XCTAssertEqual(group.totalRows, 3)
        XCTAssertEqual(group.openRows, 2)
    }
}

/// The scope picker may only offer views the server serves.
///
/// `archived` sat in this enum without a matching server view, so choosing it answered
/// `bad_request`, the refresh threw, and the list kept the previous scope's rows under the new
/// scope's name — the sidebar looked fine and was showing the wrong thing.
final class SidebarScopeTests: XCTestCase {
    /// The server's own list, from `SIDEBAR_VIEWS` in src/sidebar/projection.ts. `incognito` is a
    /// server view the picker deliberately does not offer: marked sessions surface in their own
    /// section of the active list, and a scope for them would be a second door to one room.
    private static let serverViews: Set<String> = ["active", "triage", "completed", "saved", "incognito"]

    func testEveryOfferedScopeIsAViewTheServerServes() {
        for scope in SidebarScope.allCases {
            XCTAssertTrue(
                Self.serverViews.contains(scope.rawValue),
                "scope \(scope.rawValue) is offered by the picker but the server will refuse it"
            )
        }
    }

    func testTheScopesWorthOfferingAreAllPresent() {
        XCTAssertEqual(
            Set(SidebarScope.allCases.map(\.rawValue)),
            ["active", "triage", "completed", "saved"]
        )
    }
}

/// A query outranks how you had arranged the list to browse it.
final class SearchOverridesViewStateTests: XCTestCase {
    func testAQueryMatchesRegardlessOfHowAGroupWasLeft() {
        // The matching itself is what the list filters on; the view choices that hid these rows
        // (collapse, open-only) are suspended in SessionListView while a query is present, which is
        // covered live. This pins the half that is pure: what counts as a match.
        let row = try! JSONDecoder().decode(
            SidebarRow.self,
            from: try! JSONSerialization.data(withJSONObject: [
                "kind": "session", "id": "1", "name": "Kiki Factory event closeout",
                "density": "compact", "unread": 0, "pinned": false, "focused": false,
            ])
        )

        XCTAssertTrue(row.matches("kiki"))
        XCTAssertTrue(row.matches("CLOSEOUT"))
        XCTAssertFalse(row.matches("freakuency"))
        // A finished session still answers a search: that is the whole point of searching.
        XCTAssertFalse(row.isOpen)
    }
}
