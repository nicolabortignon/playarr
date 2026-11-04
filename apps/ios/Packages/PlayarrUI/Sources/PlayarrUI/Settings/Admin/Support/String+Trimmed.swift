import Foundation

extension String {
  /// Without spaces and newlines at either end: what the web's forms send (`value.trim()`).
  var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
