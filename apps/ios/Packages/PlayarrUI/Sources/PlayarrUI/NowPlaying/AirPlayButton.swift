import SwiftUI

#if os(iOS)
  import AVKit

  /// The system's AirPlay button (`AVRoutePickerView`, docs/design.md, Icons): where the music plays, this iPhone or a
  /// speaker, picked from the system's list; in the accent while it plays somewhere else.
  struct AirPlayButton: UIViewRepresentable {
    var tint: Color
    var activeTint: Color

    func makeUIView(context: Context) -> AVRoutePickerView {
      let picker = AVRoutePickerView()
      picker.prioritizesVideoDevices = false
      return picker
    }

    func updateUIView(_ picker: AVRoutePickerView, context: Context) {
      picker.tintColor = UIColor(tint)
      picker.activeTintColor = UIColor(activeTint)
    }
  }
#else
  /// The Mac runs only the packages' tests: no route picker there.
  struct AirPlayButton: View {
    var tint: Color
    var activeTint: Color

    var body: some View { EmptyView() }
  }
#endif
