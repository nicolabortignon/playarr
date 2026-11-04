import SwiftUI

/// Songs from outside the library only know an artist's name: look it up on MusicBrainz, then show what it leads to
/// in place (the web redirects: FindArtist.tsx).
public struct FindArtistPage: View {
  let name: String
  let album: String?

  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init(name: String, album: String? = nil) {
    self.name = name
    self.album = album
  }

  public var body: some View {
    if let context {
      FindArtistView(model: FindArtistModel(api: context.api, name: name, album: album))
    }
  }
}

private struct FindArtistView: View {
  @State var model: FindArtistModel
  @Environment(AccountSession.self) private var session

  var body: some View {
    Group {
      if let destination = model.destination {
        RouteDestination(route: destination.route, session: session)
      } else {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            Kicker(text: "Artist")
            Text(model.name).font(.display(.largeTitle)).accessibilityAddTraits(.isHeader)
            if let error = model.error {
              Text(error).font(.sans(.footnote)).foregroundStyle(.secondary)
              if !model.name.isEmpty {
                Button("Search for “\(model.name)” instead") { session.router.search(model.name) }.font(.sans(.footnote))
              }
            } else {
              Text("Looking them up on MusicBrainz…").font(.mono(.caption)).foregroundStyle(.secondary)
              SlowLookup(what: "“\(model.name)”")
              Skeleton(aspectRatio: nil, height: 190)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(20)
        }
        .inlineTitle()
      }
    }
    .task { await model.load() }
  }
}
