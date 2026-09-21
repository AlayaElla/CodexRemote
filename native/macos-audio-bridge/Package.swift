// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CodexRemoteMacAudioBridge",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "CodexRemoteMacAudioBridge", targets: ["CodexRemoteMacAudioBridge"])
    ],
    targets: [
        .systemLibrary(
            name: "COpus",
            pkgConfig: "opus",
            providers: [.brew(["opus"])]
        ),
        .executableTarget(
            name: "CodexRemoteMacAudioBridge",
            dependencies: ["COpus"],
            linkerSettings: [
                .linkedFramework("AVFoundation"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("CoreAudio")
            ]
        )
    ]
)
