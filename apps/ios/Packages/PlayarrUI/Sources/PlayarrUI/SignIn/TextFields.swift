import SwiftUI

extension View {
    /// What each kind of field wants from the keyboard (iOS only; nothing on the Mac).
    func playarrAddressField() -> some View {
        #if os(iOS)
        textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL).textContentType(.URL)
        #else
        autocorrectionDisabled()
        #endif
    }

    func playarrUsernameField() -> some View {
        #if os(iOS)
        textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.username)
        #else
        autocorrectionDisabled()
        #endif
    }

    func playarrPasswordField(new: Bool) -> some View {
        #if os(iOS)
        textContentType(new ? .newPassword : .password)
        #else
        self
        #endif
    }

    func playarrCodeField() -> some View {
        #if os(iOS)
        textInputAutocapitalization(.characters).autocorrectionDisabled().textContentType(.oneTimeCode)
        #else
        autocorrectionDisabled()
        #endif
    }
}
