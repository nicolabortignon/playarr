import Foundation

/// A loose album-title key, so "Mezzanine (Deluxe Edition)" finds "Mezzanine" (lib/links.ts titleKey).
public enum TitleKey {
  public static func of(_ title: String) -> String {
    let folded = String(String.UnicodeScalarView(title.decomposedStringWithCanonicalMapping.unicodeScalars.filter { !(0x300...0x36F).contains($0.value) }))
    let key = folded.lowercased()
      .replacing(#/\s*[(\[].*?[)\]]/#, with: " ")
      .replacing(#/\s+-\s+.*$/#, with: "")
      .replacing(#/[^\p{L}\p{N}]+/#, with: " ")
      .trimmingCharacters(in: .whitespaces)
    return key.isEmpty ? title.trimmingCharacters(in: .whitespaces).lowercased() : key
  }
}
