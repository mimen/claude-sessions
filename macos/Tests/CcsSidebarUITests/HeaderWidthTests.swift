import AppKit
import SwiftUI
import XCTest
@testable import CcsSidebarUI

/// The header has to fit whatever width cmux gives the panel. When it asked for more, the whole
/// stack grew past the panel and got clipped on both edges, rows included.
@MainActor
final class HeaderWidthTests: XCTestCase {
    private func headerWidth(proposed width: CGFloat, clusters: Bool) -> CGFloat {
        let header = SidebarHeader(
            scope: .constant(.active),
            grouping: .constant(.recent),
            query: .constant(""),
            layouts: .constant(RowLayouts()),
            clusterFirst: .constant(clusters),
            clusterSplit: .constant(.none),
            counts: ["active": 288]
        )
        return NSHostingController(rootView: header)
            .sizeThatFits(in: CGSize(width: width, height: 10_000)).width
    }

    func testHeaderFitsANarrowPanel() {
        for width: CGFloat in [200, 240, 280, 320, 420] {
            for clusters in [false, true] {
                XCTAssertLessThanOrEqual(
                    headerWidth(proposed: width, clusters: clusters), width,
                    "width \(width), clusters \(clusters)"
                )
            }
        }
    }
}
