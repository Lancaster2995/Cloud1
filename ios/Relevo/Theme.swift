import SwiftUI
import UIKit

/// Same palette as Android and Windows, light and dark.
enum Theme {
    static let bg = dynamic(0xF6F4EF, 0x191817)
    static let surface = dynamic(0xFFFFFF, 0x252422)
    static let surface2 = dynamic(0xF0ECE4, 0x2F2D2A)
    static let border = dynamic(0xE2DCD1, 0x3A3834)
    static let text2 = dynamic(0x6B665E, 0xA9A49B)
    static let accent = dynamic(0xC4623F, 0xE07F5C)
    static let banner = dynamic(0xFBE9DD, 0x3A2A22)
    static let ok = dynamic(0x2E7D32, 0x72C177)
    static let warn = dynamic(0xB35C00, 0xFFB060)

    private static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { traits in
            UIColor(rgb: traits.userInterfaceStyle == .dark ? dark : light)
        })
    }
}

extension UIColor {
    convenience init(rgb: UInt32) {
        self.init(red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255,
                  blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }
}

extension Color {
    /// "#RRGGBB" (account colors); gray when unreadable.
    init(hex: String) {
        let s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "# "))
        if s.count == 6, let v = UInt32(s, radix: 16) {
            self = Color(UIColor(rgb: v))
        } else {
            self = .gray
        }
    }
}

/// Rounded card used across the app.
struct Card<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) { content }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.border, lineWidth: 1))
    }
}

struct AccountDot: View {
    let color: String
    var size: CGFloat = 10

    var body: some View {
        Circle().fill(Color(hex: color)).frame(width: size, height: size)
    }
}

/// Wraps a value so it can drive `.sheet(item:)`.
struct Ref<Value>: Identifiable {
    let id = UUID()
    let value: Value
}
