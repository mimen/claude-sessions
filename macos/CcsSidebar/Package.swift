// swift-tools-version:5.9
import PackageDescription

// The views live in a library, not in the extension target, so they can be rendered and
// snapshotted without building or launching an app. That separation is what keeps the visual
// iteration loop measured in seconds rather than in Xcode builds.
let package = Package(
    name: "CcsSidebar",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "CcsSidebarUI", targets: ["CcsSidebarUI"]),
        .executable(name: "ccs-sidebar-render", targets: ["ccs-sidebar-render"]),
    ],
    targets: [
        .target(name: "CcsSidebarUI"),
        .executableTarget(name: "ccs-sidebar-render", dependencies: ["CcsSidebarUI"]),
    ]
)
