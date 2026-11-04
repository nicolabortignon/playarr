import Foundation
import PlayarrAPI

/// A song's audio for a deck, from a frame on: its own file, downloaded ahead into the stream cache and decoded as it
/// arrives; or, for a seek beyond what's downloaded, the server's levelled stream at gain 0 from that very sample
/// while the download catches up. Which one is chosen at the first read:
///
/// 1. The whole file is in the cache: decoded from disk (`FileDecoder`), exact seek.
/// 2. From the start: the file's download, decoded progressively (`StreamDecoder`).
/// 3. From a later frame, the song measured (`origin.levelled` set): `levelled.wav?gain=0` from byte
///    `44 + frame × 4`; the file's download carries on for next time.
/// 4. From a later frame, not measured: the file from its start, decoding and dropping frames up to the seek.
///
/// A file the decoder can't stream (unknown format) plays from the levelled stream if there is one, else once
/// downloaded whole. Broken connections are retried by `Download`; what's left is explained in the web's words.
public actor TrackSource: PCMSource {
  public struct Origin: Sendable {
    /// The song's own file (`/stream/:fileId`), authorized.
    public var stream: URLRequest
    /// Its levelled stream at gain 0, when the server has measured the song; nil otherwise.
    public var levelled: URLRequest?
    /// The whole file kept on this device elsewhere (a download's transition continuation): decoded from there.
    public var kept: URL?
    public init(stream: URLRequest, levelled: URLRequest?, kept: URL? = nil) {
      self.stream = stream
      self.levelled = levelled
      self.kept = kept
    }
  }

  static let readSize = 64 * 1024

  private enum Mode {
    case file(FileDecoder)
    case stream(Download, StreamDecoder)
    case levelled(Download)
  }

  private let track: Track
  private let firstFrame: Int64
  private let origin: Origin
  private let cache: StreamCache
  private let probeSession: URLSession
  private var mode: Mode?
  private var readOffset: Int64 = 0
  private var skipFrames: Int64 = 0
  private var wav = WAVDecoder()
  private var produced = false
  private var closed = false

  public init(track: Track, firstFrame: Int64, origin: Origin, cache: StreamCache, probeSession: URLSession = .shared) {
    self.track = track
    self.firstFrame = firstFrame
    self.origin = origin
    self.cache = cache
    self.probeSession = probeSession
  }

  public func read(maxFrames: Int) async throws -> PCMBlock? {
    do {
      while !closed {
        if mode == nil { mode = try await open() }
        guard let block = try await next(maxFrames: maxFrames) else { return nil }
        if block.frames > 0 {
          produced = true
          return block
        }
      }
      return nil
    } catch let error as PlaybackError {
      throw error
    } catch is CancellationError {
      throw CancellationError()
    } catch Download.Failure.server(_, let message) {
      throw PlaybackError.server(message ?? "Playback failed")
    } catch is Download.Failure {
      throw await PlaybackError.diagnose(.network, probe: origin.stream, session: probeSession)
    } catch {
      throw await PlaybackError.diagnose(.decoding, probe: origin.stream, session: probeSession)
    }
  }

  public func close() async {
    closed = true
    if case .levelled(let download) = mode { await cache.discard(download) }
    mode = nil
  }

  private func open() async throws -> Mode {
    if let url = origin.kept, FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) {
      return .file(try FileDecoder(url: url, firstFrame: firstFrame))
    }
    if let url = await cache.completedFile(for: track) {
      return .file(try FileDecoder(url: url, firstFrame: firstFrame))
    }
    let download = await cache.download(for: track, request: origin.stream)
    if firstFrame > 0, origin.levelled != nil { return try await levelled() }
    guard let type = StreamDecoder.fileType(forContainer: track.format.container) else { return try await fallback(download) }
    skipFrames = firstFrame
    readOffset = 0
    return .stream(download, try StreamDecoder(fileType: type))
  }

  /// The levelled stream from `firstFrame`, exact to the sample.
  private func levelled() async throws -> Mode {
    guard let request = origin.levelled else { throw PlaybackError.unsupported }
    readOffset = 0
    return .levelled(await cache.temporary(request: request, firstByte: LevelledWAV.byteOffset(ofFrame: firstFrame)))
  }

  /// A file the decoder can't stream: its levelled stream, else the whole file once it's here.
  private func fallback(_ download: Download) async throws -> Mode {
    if origin.levelled != nil { return try await levelled() }
    try await download.waitUntilFinished()
    do {
      return .file(try FileDecoder(url: download.file, firstFrame: firstFrame))
    } catch {
      throw await PlaybackError.diagnose(.format, probe: origin.stream, session: probeSession)
    }
  }

  /// The next frames of the chosen way: empty when it wants calling again, nil at the end.
  private func next(maxFrames: Int) async throws -> PCMBlock? {
    switch mode {
    case .file(let decoder):
      return try decoder.decode(maxFrames: maxFrames)

    case .stream(let download, let decoder):
      do {
        guard let block = try decoder.decode(maxFrames: maxFrames) else { return nil }
        if block.frames == 0 {
          let data = try await download.bytes(at: readOffset, maxLength: Self.readSize)
          if data.isEmpty {
            try decoder.endOfInput()
          } else {
            readOffset += Int64(data.count)
            try decoder.feed(data)
          }
          return PCMBlock(left: [], right: [])
        }
        guard skipFrames > 0 else { return block }
        let dropped = min(skipFrames, Int64(block.frames))
        skipFrames -= dropped
        return block.dropping(Int(dropped))
      } catch StreamDecoder.Failure.unsupported where !produced {
        mode = try await fallback(download)
        return PCMBlock(left: [], right: [])
      }

    case .levelled(let download):
      do {
        let data = try await download.bytes(at: readOffset, maxLength: min(Self.readSize, maxFrames * 4))
        if data.isEmpty { return nil }
        readOffset += Int64(data.count)
        return wav.decode(data)
      } catch Download.Failure.server where !produced {
        // No levelled stream after all (the file changed since it was measured): its own file from the start.
        await cache.discard(download)
        let file = await cache.download(for: track, request: origin.stream)
        guard let type = StreamDecoder.fileType(forContainer: track.format.container) else {
          try await file.waitUntilFinished()
          mode = .file(try FileDecoder(url: file.file, firstFrame: firstFrame))
          return PCMBlock(left: [], right: [])
        }
        skipFrames = firstFrame
        readOffset = 0
        mode = .stream(file, try StreamDecoder(fileType: type))
        return PCMBlock(left: [], right: [])
      }

    case nil:
      return nil
    }
  }
}
