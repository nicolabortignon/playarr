#if canImport(UIKit)
  import UIKit

  /// Which way the app may turn (docs/plans/2026-11-04-ios-now-playing-landscape.md): on an iPhone the tab pages stay
  /// upright, built as a column, and only Now Playing turns sideways; an iPad turns every way. The app delegate answers
  /// `application(_:supportedInterfaceOrientationsFor:)` from `mask`.
  @MainActor
  public enum OrientationPolicy {
    public private(set) static var mask: UIInterfaceOrientationMask = UIDevice.current.userInterfaceIdiom == .pad ? .all : .portrait

    /// The orientations for a phone with Now Playing open or closed, and for an iPad.
    public static func mask(pad: Bool, nowPlaying: Bool) -> UIInterfaceOrientationMask {
      pad ? .all : nowPlaying ? .allButUpsideDown : .portrait
    }

    /// Now Playing opened or closed: closing it sideways turns the phone's window back upright.
    public static func update(nowPlaying: Bool) {
      let pad = UIDevice.current.userInterfaceIdiom == .pad
      let new = mask(pad: pad, nowPlaying: nowPlaying)
      guard new != mask else { return }
      mask = new
      for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
        for window in scene.windows { window.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations() }
        if !nowPlaying { scene.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait)) }
      }
    }

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
