// swift-tools-version:5.9
import PackageDescription

// One copy of the views, compiled two ways.
//
// `CcsSidebarUI` points straight at the extension target's `Shared` folder, so SwiftPM and Xcode
// build the same files. Without that the views would exist twice — once to render headlessly and
// once to ship — and the rendered image would slowly stop describing the extension.
let package = Package(
    name: "CcsSidebar",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "CcsSidebarUI", targets: ["CcsSidebarUI"]),
        .executable(name: "ccs-sidebar-render", targets: ["ccs-sidebar-render"]),
    ],
    targets: [
        .target(name: "CcsSidebarUI", path: "CcsSidebarApp/SampleSidebarExtension/Shared"),
        .executableTarget(
            name: "ccs-sidebar-render",
            dependencies: ["CcsSidebarUI"],
            path: "Sources/ccs-sidebar-render"
        ),
        .testTarget(
            name: "CcsSidebarUITests",
            dependencies: ["CcsSidebarUI"],
            path: "Tests/CcsSidebarUITests"
        ),
    ]
)
