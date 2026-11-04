import SwiftUI

extension EnvironmentValues {
  /// Settings → Appearance → Motion, with the system's Reduce Motion when it's System: views that animate on their
  /// own (the playing waveform, springs) check this instead of the system setting alone. Set once by the shell.
  @Entry public var reducesMotion = false
}
