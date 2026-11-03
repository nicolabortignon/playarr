import SwiftUI

/// The server needs a newer version of the app.
public struct UpdateRequiredView: View {
    let serverName: String
    let minAppVersion: String
    let appVersion: String

    public init(serverName: String, minAppVersion: String, appVersion: String) {
        self.serverName = serverName
        self.minAppVersion = minAppVersion
        self.appVersion = appVersion
    }

    public var body: some View {
        ContentUnavailableView {
            Label("Update Playarr", systemImage: "arrow.down.app")
        } description: {
            Text("\(serverName) needs Playarr \(minAppVersion) or later. This is \(appVersion): update it from the App Store or TestFlight.")
        }
    }
}
