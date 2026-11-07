import AppIntents
import Foundation
import PlayarrAPI
import PlayarrPlayer
import PlayarrUI
import SwiftUI

@main
struct PlayarrApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @State private var model: AppModel

  init() {
    Typography.register()
    let model = PlayarrApp.makeModel()
    _model = State(initialValue: model)
    // The Shortcuts actions and Siri find the app's model through this (`@Dependency`), even when they start it.
    AppDependencyManager.shared.add(dependency: model)
  }

  var body: some Scene {
    WindowGroup {
      #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-UITestsDownloads") {
          DownloadsDemoView()
        } else {
          root
        }
      #else
        root
      #endif
    }
    // The keyboard's shortcuts, in the iPad's menu bar and the list shown while ⌘ is held.
    .commands { PlayarrCommands(model: model) }
  }

  private var root: some View {
    RootView(model: model)
      // No scroll bars anywhere: every page, list and sheet below inherits this.
      .scrollIndicators(.hidden)
      .onOpenURL { model.open($0) }
      #if DEBUG
        // A UI test may hand over a session it started on a dev server (AccountsUITests).
        .task { if ProcessInfo.processInfo.arguments.contains("-UITests") { await model.signInForUITests() } }
      #endif
  }

  /// The app's model: the live one. Debug builds take the UI tests' launch arguments first (`uiTestModel`); TestFlight's
  /// and the App Store's builds are Release, which don't contain them.
  static func makeModel() -> AppModel {
    #if DEBUG
      if let model = uiTestModel(ProcessInfo.processInfo.arguments) { return model }
    #endif
    return .live()
  }

  #if DEBUG
    /// UI tests launch with `-UITests` (no servers, nothing kept between runs; a dev server's session when the test
    /// hands one over in PLAYARR_UITEST_SERVER and PLAYARR_UITEST_TOKEN), plus `-UITestsDemo` to start signed in
    /// to the demo library, playing silence, or `-UITestsRequests` for the demo with Lidarr and an album to request
    /// (`-UITestsRequests asks-first` as a member whose requests wait for approval, `-UITestsRequests admin` as an admin
    /// with one to answer).
    /// With the demo, `-UITestsOffline` makes the server unreachable, `-UITestsLongQueue` queues 5,000 songs,
    /// `-UITestsTurnToOpen` turns on Settings → Appearance → Turn to open, `-UITestsDJ` DJ mix, `-UITestsFirstSteps` opens
    /// the owner's first steps, and `-UITestsRestore` brings back where the last run was (otherwise each run starts on
    /// Home).
    /// `-UITestsDownloads` opens Library → Downloads on made-up downloads (`DownloadsDemoView`).
    /// For the screen tour, `-UITestsSlowFan <times>` slows Feeling lucky's fan of covers down (`CoverFan`), and with
    /// the demo `-UITestsSlowLucky` has its songs take 8 seconds to come and `-UITestsPulse` gives the bars made-up
    /// levels to keep time with in place of its silence; with `-UITests`, `-UITestsSlowArt` has covers take 4 s to come
    /// and `-UITestsTilt` tilts Now Playing's cover, as a phone would. Nil without any: the live app.
    private static func uiTestModel(_ arguments: [String]) -> AppModel? {
      if let asker = DemoRequestsAPI.Asker(arguments: arguments) {
        let model = AppModel.demo(requests: asker)
        model.restoresPlace = arguments.contains("-UITestsRestore")
        return model
      }
      if arguments.contains("-UITestsDemo") {
        let model = AppModel.demo(api: demoAPI(arguments))
        model.restoresPlace = arguments.contains("-UITestsRestore")
        model.appearance.turnToOpen = arguments.contains("-UITestsTurnToOpen")
        // -UITestsDJ: DJ mix, the demo's songs mixed on their beats.
        if arguments.contains("-UITestsDJ") { model.playback.transitions = .dj }
        // -UITestsPulse: the demo plays silence, which its bars would rest at; made-up levels have them keep time.
        if arguments.contains("-UITestsPulse") { model.session?.player.pulse.makeUp(BandLevels(bass: 0.9, middle: 0.75, treble: 0.6)) }
        // -UITestsFirstSteps: Settings → Sources as the owner's first step, as claiming the server on this device leaves it.
        if arguments.contains("-UITestsFirstSteps") { model.session?.router.open(.firstStep(.music)) }
        // -UITestsLongQueue: 5,000 songs queued, paused.
        if arguments.contains("-UITestsLongQueue"), let player = model.session?.player {
          player.play(Demo.manyTracks(5000))
          player.setPlaying(false)
        }
        return model
      }
      if arguments.contains("-UITests") {
        let model = AppModel.empty()
        model.restoresPlace = arguments.contains("-UITestsRestore")
        return model
      }
      return nil
    }

    /// The demo's own server, unless `-UITestsOffline` puts it out of reach or `-UITestsSlowLucky` has its Feeling lucky
    /// take its time.
    private static func demoAPI(_ arguments: [String]) -> (any APISending)? {
      if arguments.contains("-UITestsOffline") { return OfflineAPI() }
      if arguments.contains("-UITestsSlowLucky") { return SlowLuckyAPI() }
      return nil
    }
  #endif
}
