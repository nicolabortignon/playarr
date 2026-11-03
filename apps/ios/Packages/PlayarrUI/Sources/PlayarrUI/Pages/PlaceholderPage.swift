import SwiftUI

/// A page the app doesn't have yet (later phases replace these one by one).
struct PlaceholderPage: View {
  let title: String

  var body: some View {
    ContentUnavailableView(title, systemImage: "hammer", description: Text("Not in the app yet: use Playarr on the web for this for now."))
      .navigationTitle(title)
  }
}
