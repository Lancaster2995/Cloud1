import Foundation

/// Parses the status block Claude produces on "CHECKPOINT" (same rules as Android and Windows):
///
///     <<<ESTADO
///     PROYECTO: ...
///     PROGRESO: 40%
///     HECHO:
///     - ...
///     ESTADO>>>
enum StateBlock {
    static let start = "<<<ESTADO"
    static let end = "ESTADO>>>"
    /// Only present in the unanswered template, never in a real answer.
    static let placeholder = "<número 0-100>"
    static let keys = ["PROYECTO", "PROGRESO", "RESUMEN", "HECHO", "EN_PROGRESO", "SIGUIENTES_PASOS",
                       "DECISIONES", "BLOQUEOS", "ARCHIVOS_CLAVE", "CONTEXTO_EXTRA"]

    private static let keyLine = try! NSRegularExpression(pattern: "^\\s*[*#>`\\s]*([A-ZÁÉÍÓÚÑ_]{3,})[*`\\s]*:\\s*(.*)$")
    private static let number = try! NSRegularExpression(pattern: "(\\d{1,3})")
    private static let edgeDecoration = try! NSRegularExpression(pattern: "^[*_`\\s]+|[*_`\\s]+$")

    struct Result: Equatable {
        /// Newest real block, or nil.
        var block: String?
        /// True when the newest occurrence is still the unanswered template.
        var newestIsTemplate: Bool
    }

    /// Key and inline value when the line is a section header.
    static func header(_ line: String) -> (key: String, value: String)? {
        let ns = line as NSString
        guard let m = keyLine.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { return nil }
        let key = ns.substring(with: m.range(at: 1))
        guard keys.contains(key) else { return nil }
        return (key, ns.substring(with: m.range(at: 2)))
    }

    static func knownKeys(_ block: String) -> Int {
        Set(block.components(separatedBy: "\n").compactMap { header($0)?.key }).count
    }

    static func isTemplate(_ block: String) -> Bool {
        block.contains(placeholder) || block.contains("<tarea completada>")
    }

    /// Newest status block in `text`. With `requireEnd` (page text that may still be streaming) a
    /// block without its closing marker is ignored; otherwise (clipboard) it runs to the end.
    static func find(_ text: String?, requireEnd: Bool) -> Result {
        guard let text else { return Result(block: nil, newestIsTemplate: false) }
        let t = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        var upper = t.endIndex
        var newest = true
        var newestTemplate = false
        while upper > t.startIndex {
            guard let s = t.range(of: start, options: .backwards, range: t.startIndex..<upper) else { break }
            var block: String?
            if let e = t.range(of: end, range: s.upperBound..<t.endIndex) {
                block = String(t[s.lowerBound..<e.upperBound])
            } else if !requireEnd {
                block = String(t[s.lowerBound...]).trimmingCharacters(in: .whitespacesAndNewlines) + "\n" + end
            }
            if let b = block, knownKeys(b) >= 2 {
                if isTemplate(b) {
                    if newest { newestTemplate = true }
                } else {
                    return Result(block: normalize(b), newestIsTemplate: newestTemplate)
                }
            }
            newest = false
            upper = s.lowerBound
        }
        return Result(block: nil, newestIsTemplate: newestTemplate)
    }

    /// Trims trailing spaces, drops stray code fences and collapses blank runs.
    static func normalize(_ block: String) -> String {
        var out: [String] = []
        var blank = 0
        for raw in block.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            let line = rtrim(raw)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") { continue }
            if trimmed.isEmpty {
                blank += 1
                if blank > 1 { continue }
            } else {
                blank = 0
            }
            out.append(line)
        }
        return out.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Section text: inline value plus the following lines up to the next known key.
    static func section(_ block: String?, _ key: String) -> String? {
        guard let block else { return nil }
        var acc: [String]?
        for line in block.components(separatedBy: "\n") {
            if line.contains(start) || line.contains(end) {
                if acc != nil { break }
                continue
            }
            if let h = header(line) {
                if acc != nil { break }
                if h.key == key {
                    let ns = h.value as NSString
                    let inline = edgeDecoration.stringByReplacingMatches(in: h.value, range: NSRange(location: 0, length: ns.length), withTemplate: "")
                    acc = inline.isEmpty ? [] : [inline]
                }
                continue
            }
            if acc != nil { acc?.append(line) }
        }
        return acc.map { $0.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    static func items(_ block: String?, _ key: String) -> [String] {
        guard let s = section(block, key), !s.isEmpty else { return [] }
        var out: [String] = []
        for line in s.components(separatedBy: "\n") {
            var l = line.trimmingCharacters(in: .whitespaces)
            if l.hasPrefix("- ") || l.hasPrefix("* ") || l.hasPrefix("• ") {
                l = String(l.dropFirst(2)).trimmingCharacters(in: .whitespaces)
            } else if l == "-" || l == "*" {
                continue
            }
            if !l.isEmpty { out.append(l) }
        }
        return out
    }

    /// PROGRESO clamped to 0...100, or -1 when missing.
    static func progress(_ block: String?) -> Int {
        guard let v = section(block, "PROGRESO") else { return -1 }
        let ns = v as NSString
        guard let m = number.firstMatch(in: v, range: NSRange(location: 0, length: ns.length)),
              let n = Int(ns.substring(with: m.range(at: 1))) else { return -1 }
        return max(0, min(100, n))
    }

    private static func rtrim(_ s: String) -> String {
        var end = s.endIndex
        while end > s.startIndex {
            let prev = s.index(before: end)
            guard s[prev].isWhitespace else { break }
            end = prev
        }
        return String(s[s.startIndex..<end])
    }
}
