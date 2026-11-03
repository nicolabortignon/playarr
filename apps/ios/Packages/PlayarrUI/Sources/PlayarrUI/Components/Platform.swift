import SwiftUI

#if canImport(UIKit)
  import UIKit
#else
  import AppKit
#endif

/// The few things iOS and the Mac (where `swift test` builds this package) do differently.
extension View {
  /// The mini player: in the tab bar's accessory on iOS, over the bottom edge elsewhere.
  @ViewBuilder
  func miniPlayer<Content: View>(isShown: Bool, @ViewBuilder _ content: () -> Content) -> some View {
    #if os(iOS)
      if #available(iOS 26.1, *) {
        tabViewBottomAccessory(isEnabled: isShown, content: content)
      } else {
        tabViewBottomAccessory(content: content)
      }
    #else
      safeAreaInset(edge: .bottom) { if isShown { content() } }
    #endif
  }

  /// Now Playing covers the whole screen on iOS; a sheet elsewhere.
  func nowPlayingCover<Content: View>(isPresented: Binding<Bool>, @ViewBuilder content: @escaping () -> Content) -> some View {
    #if os(iOS)
      fullScreenCover(isPresented: isPresented, content: content)
    #else
      sheet(isPresented: isPresented, content: content)
    #endif
  }

  /// A page title in the bar, not a large one.
  func inlineTitle() -> some View {
    #if os(iOS)
      navigationBarTitleDisplayMode(.inline)
    #else
      self
    #endif
  }

  /// The tab bar shrinks while scrolling down, as Apple Music's does.
  func minimizingTabBar() -> some View {
    #if os(iOS)
      tabBarMinimizeBehavior(.onScrollDown)
    #else
      self
    #endif
  }
}

extension Image {
  /// An image from JPEG, PNG or WebP bytes.
  static func decoded(_ data: Data) -> Image? {
    #if canImport(UIKit)
      UIImage(data: data).map(Image.init(uiImage:))
    #else
      NSImage(data: data).map(Image.init(nsImage:))
    #endif
  }
}
