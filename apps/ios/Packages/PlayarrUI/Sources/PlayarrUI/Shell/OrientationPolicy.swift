#if canImport(UIKit)
  import UIKit

  /// Which way the app may turn: every screen turns, upright and sideways each with its own layout (an iPhone held
  /// sideways gets the gatefold pages and Now Playing's sleeve); an iPhone doesn't turn upside down, an iPad turns every
  /// way. The app delegate answers `application(_:supportedInterfaceOrientationsFor:)` from `mask`.
  @MainActor
  public enum OrientationPolicy {
    public static var mask: UIInterfaceOrientationMask { mask(pad: UIDevice.current.userInterfaceIdiom == .pad) }

    public static func mask(pad: Bool) -> UIInterfaceOrientationMask { pad ? .all : .allButUpsideDown }

    /// Nothing is presented over the app's root (no sheet, no Now Playing): turning the phone may open Now Playing.
    static var nothingPresented: Bool {
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.allSatisfy { scene in
        scene.windows.allSatisfy { $0.rootViewController?.presentedViewController == nil }
      }
    }
  }

  /// The screen stays on while Now Playing is sideways and the phone charges (Settings → Appearance), and sleeps as
  /// usual otherwise.
  @MainActor
  enum ScreenAwake {
    static func update(sideways: Bool, enabled: Bool) {
      UIDevice.current.isBatteryMonitoringEnabled = true
      let charging = UIDevice.current.batteryState == .charging || UIDevice.current.batteryState == .full
      UIApplication.shared.isIdleTimerDisabled = sideways && enabled && charging
    }
  }
#endif
