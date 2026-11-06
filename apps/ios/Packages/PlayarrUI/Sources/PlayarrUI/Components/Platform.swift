import SwiftUI

#if canImport(UIKit)
  import UIKit
#else
  import AppKit
#endif

/// The window's own insets, without any bars.
enum ScreenInsets {
  /// The status bar's (Dynamic Island's) height: where a page that starts under the navigation bar puts its header,
  /// beside the bar's back button rather than below the bar.
  @MainActor static var top: CGFloat {
    #if os(iOS)
      UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?.safeAreaInsets.top ?? 0
    #else
      0
    #endif
  }
}

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

  /// The page header of a tab or a library list (docs/design.md, "Headers"): the system's large title (in Gloock,
  /// `Typography.register`), with the page's controls in the bar on the right. The bar shows the title only once the
  /// large one has scrolled away. Large whichever page it was opened from.
  func pageHeader(_ title: String) -> some View {
    #if os(iOS)
      navigationTitle(title).navigationBarTitleDisplayMode(.large)
    #else
      navigationTitle(title)
    #endif
  }

  /// A page header with how many the page holds under the title ("128 albums"), once known. Until then the line is
  /// kept blank rather than left out: a subtitle arriving after the page has opened folds its large title into the bar.
  func pageHeader(_ title: String, count: String?) -> some View {
    pageHeader(title).navigationSubtitle(count ?? "\u{00A0}")
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
