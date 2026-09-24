// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "CcsUsageMenuBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "CcsUsageMenuBar",
            path: "Sources/CcsUsageMenuBar",
            exclude: ["Resources/AppIcon.icns", "Resources/AppIcon2.icns"],
            resources: [.copy("Resources/usage-view.js")]
        ),
        .testTarget(
            name: "CcsUsageMenuBarTests",
            dependencies: ["CcsUsageMenuBar"],
            path: "Tests/CcsUsageMenuBarTests",
            resources: [.copy("Fixtures")]
        )
    ]
)
