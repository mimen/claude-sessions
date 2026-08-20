import AppKit
import CcsSidebarUI
import Foundation
import SwiftUI

/// Renders the sidebar's views to PNG against live server data.
///
/// This is the visual feedback loop, and it exists because the alternative is launching an app and
/// photographing a window. `ImageRenderer` draws a view tree straight to an image with no window
/// and no screen-recording permission, so a change can be seen in the time a Swift build takes.
///
/// It renders a plain stack rather than the real scrolling list: `ScrollView` and `LazyVStack`
/// rasterise blank here, which is a limit of the renderer, not of the views. Scrolling behaviour
/// is verified against the running extension instead.
struct Harness {
    static func fetchRows(limit: Int) throws -> [SidebarRow] {
        let url = URL(string: "http://127.0.0.1:\(SidebarServer.defaultPort)/api/snapshot?limit=\(limit)")!
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(SidebarSnapshot.self, from: data).rows
    }

    /// Coarse ages, matching the web sidebar's bands closely enough to judge layout width.
    static func age(from epochMs: Double?) -> String {
        guard let epochMs else { return "" }
        let seconds = Date().timeIntervalSince1970 - epochMs / 1000
        if seconds < 90 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
        return "\(Int(seconds / 86_400))d"
    }
}

@main
struct Render {
    @MainActor
    static func main() throws {
        let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/ccs-sidebar.png"
        let count = CommandLine.arguments.count > 2 ? Int(CommandLine.arguments[2]) ?? 14 : 14
        let rows = try Harness.fetchRows(limit: 60).prefix(count)

        // Every row twice: at rest, then hovered. The hover controls only ever appear on a live
        // pointer, which makes them the hardest part of the row to see changes in; rendering the
        // state directly is the only way to check them without a mouse.
        let view = VStack(spacing: 6) {
            ForEach(Array(rows), id: \.id) { row in
                SessionRowView(
                    row: row,
                    age: Harness.age(from: row.lastActivityAt),
                    actions: RowActions(),
                    tracksHover: false
                )
                SessionRowView(
                    row: row,
                    age: Harness.age(from: row.lastActivityAt),
                    actions: RowActions(),
                    isHovered: true,
                    tracksHover: false
                )
            }
        }
        .padding(8)
        .frame(width: 420)
        .background(Color(white: 0.08))
        .environment(\.colorScheme, .dark)

        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        var produced: NSImage?
        NSAppearance(named: .darkAqua)!.performAsCurrentDrawingAppearance { produced = renderer.nsImage }
        guard let image = produced,
              let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
            FileHandle.standardError.write(Data("render produced no image\n".utf8))
            exit(1)
        }
        try png.write(to: URL(fileURLWithPath: out))
        print("wrote \(out) — \(rows.count) rows, \(Int(image.size.width))x\(Int(image.size.height))")
    }
}
