import Foundation
#if os(iOS)
import UIKit
#endif

/// How this device names itself to the server's session list (Settings → Accounts).
public struct DeviceInfo: Sendable, Equatable {
    public var name: String
    public var platform: String

    public init(name: String, platform: String) {
        self.name = name
        self.platform = platform
    }

    @MainActor public static func current() -> DeviceInfo {
        #if os(iOS)
        DeviceInfo(name: UIDevice.current.name, platform: UIDevice.current.userInterfaceIdiom == .pad ? "ipados" : "ios")
        #else
        DeviceInfo(name: ProcessInfo.processInfo.hostName, platform: "macos")
        #endif
    }
}
