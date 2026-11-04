import SwiftUI

/// Text-field behaviour the admin forms share: no capitals or corrections for names of things, URLs and keys.
extension View {
  func adminPlainField() -> some View {
    #if os(iOS)
    textInputAutocapitalization(.never).autocorrectionDisabled()
    #else
    autocorrectionDisabled()
    #endif
  }

  func adminURLField() -> some View {
    #if os(iOS)
    adminPlainField().keyboardType(.URL).textContentType(.URL)
    #else
    adminPlainField()
    #endif
  }

  func adminNumberField() -> some View {
    #if os(iOS)
    keyboardType(.numberPad)
    #else
    self
    #endif
  }
}
