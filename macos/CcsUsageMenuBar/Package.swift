// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "CcsUsageMenuBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "CcsUsageMenuBar",
            path: "Sources/CcsUsageMenuBar"
        ),
        .testTarget(
            name: "CcsUsageMenuBarTests",
            dependencies: ["CcsUsageMenuBar"],
            path: "Tests/CcsUsageMenuBarTests",
            resources: [.copy("Fixtures")]
        )
    ]
)
