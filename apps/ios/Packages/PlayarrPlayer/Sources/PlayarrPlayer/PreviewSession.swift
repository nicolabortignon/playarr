/// The previews of one edit: whether the queue was playing before the first (it goes on after the last), and the
/// engine playing one now, until `until` seconds into its song.
@MainActor
struct PreviewSession {
  var resume: Bool
  var engine: AudioEngine?
  var until: Double = 0

  init(resume: Bool) {
    self.resume = resume
  }
}
