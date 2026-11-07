import AVFoundation
import Accelerate
import Synchronization

/// The engine's meter on what's heard (plan 7 §2): how loud the bass (40–200 Hz), the middle (200 Hz–2 kHz) and the
/// treble (2–10 kHz) are, sixty times for each second of music. Read as the web reads them (apps/web/src/player/
/// pulse.ts `levelsOf`, on an AnalyserNode with an FFT of 1024, smoothing 0.55 and its scale from −100 to −30 dB): each
/// band against how loud it has lately been, over a range of 24.5 dB under a peak that falls 1.4 dB a second and never
/// below −68.5 dB, so the volume set doesn't matter and a quiet song moves its bars as much as a loud one.
struct BandMeter {
  /// The analyzer's window: 1024 samples, a Blackman window, as Web Audio's.
  static let size = 1024
  /// Each reading keeps this much of the last one, bin by bin (Web Audio's `smoothingTimeConstant`).
  static let smoothing: Float = 0.55
  /// The analyzer's scale, in dB: a level is where a bin falls between the two, 0–1, as its bytes are.
  static let floorDb: Float = -100
  static let ceilingDb: Float = -30
  /// The three bars' parts of the spectrum, in Hz: the bass, the middle, the treble.
  static let bands: [(low: Double, high: Double)] = [(40, 200), (200, 2000), (2000, 10_000)]
  /// A band reads against the loudest it has lately been, over this much of the scale (24.5 dB)…
  static let range = 0.35
  /// …that loudest falling back this much a second (1.4 dB), so a quiet bridge reads quiet for a while…
  static let peakFall = 0.02
  /// …and never below this (−68.5 dB): near silence reads as silence, not as the loudest yet.
  static let minPeak = 0.45
  /// Readings per second of music, as many as the web's frames.
  static let readingsPerSecond = 60.0

  let sampleRate: Double
  private let hop: Int
  private let window: [Float]
  private let dft: vDSP.DiscreteFourierTransform<Float>
  /// Each band's bins, as `levelsOf` picks them.
  private let bins: [ClosedRange<Int>]
  /// The last `size` samples, oldest first.
  private var recent: [Float]
  private var sinceReading = 0
  private var smoothed: [Float]
  private var peaks = [0.0, 0.0, 0.0]

  init?(sampleRate: Double) {
    let size = Self.size
    guard sampleRate > 0,
      let dft = try? vDSP.DiscreteFourierTransform(previous: nil, count: size, direction: .forward, transformType: .complexReal, ofType: Float.self)
    else { return nil }
    self.sampleRate = sampleRate
    self.dft = dft
    hop = max(1, Int((sampleRate / Self.readingsPerSecond).rounded()))
    // Web Audio's Blackman window (α 0.16) over the whole block.
    window = (0..<size).map { n in
      let x = 2 * Double.pi * Double(n) / Double(size)
      return Float(0.42 - 0.5 * cos(x) + 0.08 * cos(2 * x))
    }
    let binHz = sampleRate / Double(size)
    let count = size / 2
    bins = Self.bands.map { band in
      let from = max(1, Int((band.low / binHz).rounded(.down)))
      let to = max(from, min(count - 1, Int((band.high / binHz).rounded(.up))))
      return from...to
    }
    recent = [Float](repeating: 0, count: size)
    smoothed = [Float](repeating: 0, count: count)
  }

  /// Takes the next samples of what's heard (mixed to one channel), the first at host time `start`, and gives a reading
  /// for every sixtieth of a second of them, stamped with the host time of its last sample.
  mutating func hear(_ samples: UnsafeBufferPointer<Float>, start: Double) -> [Pulse.Reading] {
    var readings: [Pulse.Reading] = []
    var index = 0
    while index < samples.count {
      let take = min(hop - sinceReading, samples.count - index)
      keep(UnsafeBufferPointer(rebasing: samples[index..<index + take]))
      index += take
      sinceReading += take
      guard sinceReading == hop else { continue }
      sinceReading = 0
      let heard = read()
      let elapsed = Double(hop) / sampleRate
      let levels = (0..<3).map { Self.follow(heard[$0], peak: &peaks[$0], elapsed: elapsed) }
      readings.append(Pulse.Reading(at: start + Double(index) / sampleRate, levels: BandLevels(bass: levels[0], middle: levels[1], treble: levels[2])))
    }
    return readings
  }

  /// A band's level against how loud it has lately been (the second half of `levelsOf`): the peak falls `peakFall` a
  /// second unless the level is above it, and counts as no lower than `minPeak`.
  static func follow(_ level: Double, peak: inout Double, elapsed: Double) -> Double {
    peak = max(level, peak - peakFall * elapsed)
    let top = max(peak, minPeak)
    return min(1, max(0, (level - (top - range)) / range))
  }

  /// The newest samples onto the end of the window.
  private mutating func keep(_ samples: UnsafeBufferPointer<Float>) {
    if samples.count >= recent.count {
      recent = Array(samples.suffix(recent.count))
    } else {
      recent.removeFirst(samples.count)
      recent.append(contentsOf: samples)
    }
  }

  /// One reading of the window: each band's mean on the analyzer's scale, 0–1 (the first half of `levelsOf`, on what
  /// `getByteFrequencyData` gives: the windowed spectrum's magnitudes over the block's length, smoothed, in dB).
  private mutating func read() -> [Double] {
    let half = Self.size / 2
    let windowed = vDSP.multiply(recent, window)
    // The real transform takes the even samples as its real part and the odd as its imaginary part, and gives twice
    // the spectrum, its first bin holding the constant in its real part (and the middle frequency in its imaginary).
    var evens = [Float](repeating: 0, count: half), odds = [Float](repeating: 0, count: half)
    for k in 0..<half {
      evens[k] = windowed[2 * k]
      odds[k] = windowed[2 * k + 1]
    }
    var real = [Float](repeating: 0, count: half), imaginary = [Float](repeating: 0, count: half)
    dft.transform(inputReal: evens, inputImaginary: odds, outputReal: &real, outputImaginary: &imaginary)
    let scale = 1 / Float(2 * Self.size)
    for k in 0..<half {
      let magnitude = (k == 0 ? abs(real[0]) : hypot(real[k], imaginary[k])) * scale
      smoothed[k] = Self.smoothing * smoothed[k] + (1 - Self.smoothing) * magnitude
    }
    let span = Self.ceilingDb - Self.floorDb
    return bins.map { band in
      var sum: Float = 0
      for k in band {
        let db = smoothed[k] > 0 ? 20 * log10(smoothed[k]) : Self.floorDb
        sum += min(1, max(0, (db - Self.floorDb) / span))
      }
      return Double(sum / Float(band.count))
    }
  }
}

/// The meter's side of the tap on the engine's output: the buffers AVFoundation hands over on a thread of its own,
/// mixed to one channel and read, the readings into the `Pulse`.
final class MeterTap: Sendable {
  private let meter = Mutex<BandMeter?>(nil)

  func hear(_ buffer: AVAudioPCMBuffer, at time: AVAudioTime, into pulse: Pulse) {
    guard let channels = buffer.floatChannelData, buffer.frameLength > 0, buffer.format.channelCount > 0 else { return }
    let frames = Int(buffer.frameLength)
    let count = Int(buffer.format.channelCount)
    let rate = buffer.format.sampleRate
    var mono = [Float](repeating: 0, count: frames)
    for channel in 0..<count {
      vDSP.add(mono, UnsafeBufferPointer(start: channels[channel], count: frames), result: &mono)
    }
    vDSP.multiply(1 / Float(count), mono, result: &mono)
    let start = time.isHostTimeValid ? AVAudioTime.seconds(forHostTime: time.hostTime) : Pulse.hostNow() - Double(frames) / rate
    let readings = meter.withLock { meter -> [Pulse.Reading] in
      if meter?.sampleRate != rate { meter = BandMeter(sampleRate: rate) }
      return mono.withUnsafeBufferPointer { meter?.hear($0, start: start) ?? [] }
    }
    if !readings.isEmpty { pulse.hear(readings) }
  }
}
