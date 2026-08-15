import XCTest
@testable import CcsSidebarUI

/// The change channel's wire format, which is the one place the native client parses by hand.
///
/// Everything else it consumes is JSON through `Codable`. This is line-oriented SSE, where a
/// heartbeat and a change differ only by a prefix, so a parser that is too eager turns keep-alives
/// into refetches and one that is too strict silently stops noticing change at all.
final class ChangeFrameTests: XCTestCase {
    func testReadsTheRevisionFromADataFrame() {
        XCTAssertEqual(SnapshotClient.revision(inFrame: #"data: {"revision":7}"#), 7)
    }

    func testAcceptsAFrameWithoutTheConventionalSpace() {
        XCTAssertEqual(SnapshotClient.revision(inFrame: #"data:{"revision":7}"#), 7)
    }

    func testIgnoresHeartbeatComments() {
        // Sent every twenty seconds purely to prove the connection is alive. Treating one as a
        // change would have the sidebar refetch on a timer again, which is what this replaced.
        XCTAssertNil(SnapshotClient.revision(inFrame: ": heartbeat"))
    }

    func testIgnoresFramesItCannotUnderstand() {
        XCTAssertNil(SnapshotClient.revision(inFrame: "event: something"))
        XCTAssertNil(SnapshotClient.revision(inFrame: "data: not json"))
        XCTAssertNil(SnapshotClient.revision(inFrame: #"data: {"other":1}"#))
        XCTAssertNil(SnapshotClient.revision(inFrame: ""))
    }
}
