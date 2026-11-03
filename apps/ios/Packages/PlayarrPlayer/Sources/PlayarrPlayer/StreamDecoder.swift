import AVFoundation
import AudioToolbox

/// Decodes a song's own file as its bytes arrive: AudioFileStream finds the packets, one AVAudioConverter turns them
/// into engine-format PCM (decoding, converting the rate and the channels in one step). FLAC, MP3 and AAC (ADTS, or
/// M4A with its index first).
///
/// AudioFileStream's C callbacks run synchronously inside `AudioFileStreamParseBytes`, on the caller's thread, so the
/// decoder is a plain non-Sendable class owned by one actor (`TrackSource`): the callbacks reach it through an
/// unretained pointer and need no lock.
final class StreamDecoder {
  enum Failure: Error, Equatable {
    /// Not a format this decoder streams (found before any audio): the caller falls back.
    case unsupported(OSStatus)
    /// The data is damaged.
    case damaged(OSStatus)
  }

  private var stream: AudioFileStreamID?
  private var format: AVAudioFormat?
  private var cookie: Data?
  private var packetTable: AudioFilePacketTableInfo?
  private var packets: [(data: Data, description: AudioStreamPacketDescription)] = []
  private var converter: AVAudioConverter?
  private var inputEnded = false
  /// The header says plain PCM (WAV, AIFF): not streamed here.
  private var plainPCM = false
  private var outputEnded = false
  /// Engine frames still to drop at the start (an encoder's priming), and the most to give in all (its padding).
  private var toDrop: Int64 = 0
  private var limit: Int64?
  private var produced: Int64 = 0

  /// The AudioFileStream type for a file extension, nil for formats it can't stream (they go another way).
  static func fileType(forContainer container: String) -> AudioFileTypeID? {
    switch container.lowercased() {
    case "flac": kAudioFileFLACType
    case "mp3": kAudioFileMP3Type
    case "aac": kAudioFileAAC_ADTSType
    case "m4a", "mp4", "alac": kAudioFileM4AType
    default: nil
    }
  }

  init(fileType: AudioFileTypeID) throws {
    let context = Unmanaged.passUnretained(self).toOpaque()
    let status = AudioFileStreamOpen(context, { context, stream, property, _ in
      Unmanaged<StreamDecoder>.fromOpaque(context).takeUnretainedValue().property(property, of: stream)
    }, { context, _, count, bytes, descriptions in
      Unmanaged<StreamDecoder>.fromOpaque(context).takeUnretainedValue().packets(count, bytes, descriptions)
    }, fileType, &stream)
    guard status == noErr else { throw Failure.unsupported(status) }
  }

  deinit {
    if let stream { AudioFileStreamClose(stream) }
  }

  /// The source's format, once the header has been read.
  var sourceFormat: AVAudioFormat? { format }

  func feed(_ data: Data) throws {
    guard let stream, !data.isEmpty else { return }
    let status = data.withUnsafeBytes { raw in
      AudioFileStreamParseBytes(stream, UInt32(raw.count), raw.baseAddress, [])
    }
    guard status == noErr else {
      throw converter == nil ? Failure.unsupported(status) : Failure.damaged(status)
    }
    if plainPCM { throw Failure.unsupported(kAudioFileUnsupportedDataFormatError) }
  }

  /// No more bytes: hand over the last packet, which the parser holds until it knows where it ends.
  func endOfInput() throws {
    guard let stream, !inputEnded else { return }
    _ = AudioFileStreamParseBytes(stream, 0, nil, [])
    inputEnded = true
    if converter == nil { throw Failure.unsupported(kAudioFileStreamError_DataUnavailable) }
  }

  /// Up to `maxFrames` frames from the packets parsed so far: empty when it needs more bytes, nil once it's done.
  func decode(maxFrames: Int) throws -> PCMBlock? {
    if outputEnded { return nil }
    guard let converter, let format else {
      return inputEnded ? nil : PCMBlock(left: [], right: [])
    }
    guard let out = AVAudioPCMBuffer(pcmFormat: EngineFormat.av, frameCapacity: AVAudioFrameCount(maxFrames)) else { return nil }
    var error: NSError?
    let status = converter.convert(to: out, error: &error) { [self] wanted, inputStatus in
      guard !packets.isEmpty else {
        inputStatus.pointee = inputEnded ? .endOfStream : .noDataNow
        return nil
      }
      let take = packets.prefix(max(1, Int(wanted)))
      let bytes = take.reduce(0) { $0 + $1.data.count }
      let maxPacket = take.map(\.data.count).max() ?? 0
      let buffer = AVAudioCompressedBuffer(format: format, packetCapacity: AVAudioPacketCount(take.count), maximumPacketSize: maxPacket)
      var offset = 0
      for (i, packet) in take.enumerated() {
        packet.data.withUnsafeBytes { raw in
          if let base = raw.baseAddress { buffer.data.advanced(by: offset).copyMemory(from: base, byteCount: raw.count) }
        }
        var description = packet.description
        description.mStartOffset = Int64(offset)
        buffer.packetDescriptions?[i] = description
        offset += packet.data.count
      }
      buffer.packetCount = AVAudioPacketCount(take.count)
      buffer.byteLength = UInt32(bytes)
      packets.removeFirst(take.count)
      inputStatus.pointee = .haveData
      return buffer
    }
    if status == .error { throw Failure.damaged(OSStatus(error?.code ?? -1)) }
    if status == .endOfStream { outputEnded = true }
    var block = PCMBlock(out)
    // An encoder's priming and padding (MP3, AAC) aren't part of the song: trimmed, for gapless joins.
    if toDrop > 0 {
      let dropped = min(toDrop, Int64(block.frames))
      block = block.dropping(Int(dropped))
      toDrop -= dropped
    }
    if let limit, produced + Int64(block.frames) > limit {
      block = block.slice(0..<Int(max(0, limit - produced)))
      outputEnded = true
    }
    produced += Int64(block.frames)
    if block.frames == 0 && outputEnded { return nil }
    return block
  }

  // MARK: AudioFileStream callbacks

  private func property(_ property: AudioFileStreamPropertyID, of stream: AudioFileStreamID) {
    switch property {
    case kAudioFileStreamProperty_DataFormat:
      var asbd = AudioStreamBasicDescription()
      var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
      if AudioFileStreamGetProperty(stream, property, &size, &asbd) == noErr { format = AVAudioFormat(streamDescription: &asbd) }
    case kAudioFileStreamProperty_MagicCookieData:
      var size: UInt32 = 0
      guard AudioFileStreamGetPropertyInfo(stream, property, &size, nil) == noErr, size > 0 else { return }
      var data = Data(count: Int(size))
      let status = data.withUnsafeMutableBytes { raw in
        raw.baseAddress.map { AudioFileStreamGetProperty(stream, property, &size, $0) } ?? kAudioFileStreamError_DataUnavailable
      }
      if status == noErr { cookie = data }
    case kAudioFileStreamProperty_PacketTableInfo:
      var info = AudioFilePacketTableInfo()
      var size = UInt32(MemoryLayout<AudioFilePacketTableInfo>.size)
      if AudioFileStreamGetProperty(stream, property, &size, &info) == noErr { packetTable = info }
    case kAudioFileStreamProperty_ReadyToProducePackets:
      makeConverter()
    default:
      break
    }
  }

  private func packets(_ count: UInt32, _ bytes: UnsafeRawPointer, _ descriptions: UnsafeMutablePointer<AudioStreamPacketDescription>?) {
    // Formats without packet descriptions are constant-size PCM, which this decoder doesn't take (see makeConverter).
    guard let descriptions else { return }
    for i in 0..<Int(count) {
      let d = descriptions[i]
      packets.append((Data(bytes: bytes.advanced(by: Int(d.mStartOffset)), count: Int(d.mDataByteSize)), d))
    }
  }

  private func makeConverter() {
    guard let format else { return }
    guard format.streamDescription.pointee.mFormatID != kAudioFormatLinearPCM else { return plainPCM = true }
    if let cookie { format.magicCookie = cookie }
    converter = AVAudioConverter(from: format, to: EngineFormat.av)
    if let table = packetTable, table.mNumberValidFrames > 0 {
      let ratio = EngineFormat.sampleRate / format.sampleRate
      toDrop = Int64((Double(table.mPrimingFrames) * ratio).rounded())
      limit = Int64((Double(table.mNumberValidFrames) * ratio).rounded())
    }
  }
}
