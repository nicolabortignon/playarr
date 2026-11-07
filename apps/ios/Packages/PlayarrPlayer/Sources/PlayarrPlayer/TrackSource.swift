import AudioToolbox
import Foundation
import PlayarrAPI

/// A song's audio for a deck, from a frame on: a copy on this device, the server's encoded stream of it, or its own
/// file, downloaded ahead into the stream cache and decoded as it arrives; or, for a seek beyond what's downloaded,
/// the server's levelled stream at gain 0 from that very sample while the download catches up. Which one is chosen at
/// the first read:
///
/// 1. A copy that will do is on the device (`origin.kept`, or the cache's at `origin.accepts` or better): decoded from
///    disk (`FileDecoder`), exact seek.
/// 2. The song comes encoded at this network's quality (`origin.encoded`, plan 2 §1): its encoded stream, from the
///    very frame asked for (`start=`), decoded as it arrives (`StreamDecoder`, an M4A trimmed by its packet table);
///    from the start it goes into the cache, as the song's own file would. A server or song without one (404), an
///    encode that failed (502) or a busy server (503) plays the song's own file instead, for the rest of the session
///    (`EncodeSupport`).
/// 3. From the start: the file's download, decoded progressively (`StreamDecoder`).
/// 4. From a later frame, the song measured (`origin.levelled` set): `levelled.wav?gain=0` from byte
///    `44 + frame × 4`; the file's download carries on for next time.
/// 5. From a later frame, not measured: the file from its start, decoding and dropping frames up to the seek.
///
/// A file the decoder can't stream (unknown format) plays from the levelled stream if there is one, else once
/// downloaded whole. Broken connections are retried by `Download`; what's left is explained in the web's words.
public actor TrackSource: PCMSource {
  public struct Origin: Sendable {
    /// The song's own file (`/stream/:fileId`), authorized.
    public var stream: URLRequest
    /// Its levelled stream at gain 0, when the server has measured the song; nil otherwise.
    public var levelled: URLRequest?
    /// The whole file kept on this device elsewhere (a download's copy, a transition continuation): decoded from there.
    public var kept: URL?
    /// The least a copy in the stream cache must be to play: the quality wanted on this network (anything offline).
    public var accepts: StreamQuality
    /// Its encoded stream at this network's quality, when it comes encoded.
    public var encoded: Encoded?

    public init(stream: URLRequest, levelled: URLRequest?, kept: URL? = nil, accepts: StreamQuality = .original, encoded: Encoded? = nil) {
      self.stream = stream
      self.levelled = levelled
      self.kept = kept
      self.accepts = accepts
      self.encoded = encoded
    }
  }

  /// A song's encoded stream (`/stream/:fileId/aac`).
  public struct Encoded: Sendable {
    public var quality: StreamQuality
    /// The stream from an engine frame on (the server's `start`, samples at 44.1 kHz), authorized.
    public var request: @Sendable (Int64) -> URLRequest
    /// What the session has learned of the server's encoded streams.
    public var support: EncodeSupport

    public init(quality: StreamQuality, support: EncodeSupport, request: @escaping @Sendable (Int64) -> URLRequest) {
      self.quality = quality
      self.support = support
      self.request = request
    }
  }

  static let readSize = 64 * 1024

  private enum Mode {
    case file(FileDecoder)
    case stream(Download, StreamDecoder)
    case levelled(Download)
    /// An encoded stream: `temporary` when it's from a later frame, a file of its own.
    case encoded(Download, StreamDecoder, Encoded, temporary: Bool)
  }

  private let track: Track
  /// Where the song starts here: the frame asked for, moved on when an encoded stream gives way to the song's own file.
  private var firstFrame: Int64
  private let origin: Origin
  private let cache: StreamCache
  private let probeSession: URLSession
  private var mode: Mode?
  private var readOffset: Int64 = 0
  private var skipFrames: Int64 = 0
  private var wav = WAVDecoder()
  private var produced = false
  /// Frames given since `firstFrame`.
  private var framesOut: Int64 = 0
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
          framesOut += Int64(block.frames)
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
    switch mode {
    case .levelled(let download), .encoded(let download, _, _, temporary: true): await cache.discard(download)
    default: break
    }
    mode = nil
  }

  private func open() async throws -> Mode {
    if let url = origin.kept, FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) {
      return .file(try FileDecoder(url: url, firstFrame: firstFrame))
    }
    if let url = await cache.completedFile(for: track, atLeast: origin.accepts) {
      return .file(try FileDecoder(url: url, firstFrame: firstFrame))
    }
    if let encoded = origin.encoded, encoded.support.allows(track.fileId) {
      readOffset = 0
      let temporary = firstFrame > 0
      let download =
        temporary
        ? await cache.temporaryEncoded(request: encoded.request(firstFrame))
        : await cache.download(for: track, quality: encoded.quality, request: encoded.request(0))
      return .encoded(download, try StreamDecoder(fileType: kAudioFileM4AType), encoded, temporary: temporary)
    }
    return try await original()
  }

  /// An encoded stream gives way to the song's own file, from the frame it got to.
  private func giveWay(_ download: Download, temporary: Bool) async throws -> PCMBlock {
    if temporary { await cache.discard(download) }
    firstFrame += framesOut
    framesOut = 0
    mode = try await original()
    return PCMBlock(left: [], right: [])
  }

  /// The song's own file, from `firstFrame`.
  private func original() async throws -> Mode {
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

    case .encoded(let download, let decoder, let encoded, let temporary):
      do {
        guard let block = try decoder.decode(maxFrames: maxFrames) else { return nil }
        if block.frames > 0 { return block }
        let data = try await download.bytes(at: readOffset, maxLength: Self.readSize)
        if data.isEmpty {
          try decoder.endOfInput()
        } else {
          readOffset += Int64(data.count)
          try decoder.feed(data)
        }
        return PCMBlock(left: [], right: [])
      } catch Download.Failure.server(let status, let message) {
        // No encoded stream after all (an old server, a song it can't encode, an encode that failed, a busy server):
        // the song's own file from where this one got to, sample for sample.
        encoded.support.failed(track.fileId, status: status, message: message)
        return try await giveWay(download, temporary: temporary)
      } catch StreamDecoder.Failure.unsupported where !produced {
        encoded.support.failed(track.fileId, status: 0, message: nil)
        return try await giveWay(download, temporary: temporary)
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
