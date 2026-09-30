package io.github.lancaster2995.relevo;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Parses the project status block that Claude is asked to produce on "CHECKPOINT":
 *
 * <pre>
 * &lt;&lt;&lt;ESTADO
 * PROYECTO: ...
 * PROGRESO: 40%
 * RESUMEN: ...
 * HECHO:
 * - ...
 * ESTADO&gt;&gt;&gt;
 * </pre>
 *
 * Pure Java so it can be unit-tested off-device.
 */
public final class StateBlock {

    public static final String START = "<<<ESTADO";
    public static final String END = "ESTADO>>>";
    /** Placeholder only present in the unanswered template, never in a real answer. */
    public static final String PLACEHOLDER = "<número 0-100>";

    public static final List<String> KEYS = Arrays.asList(
            "PROYECTO", "PROGRESO", "RESUMEN", "HECHO", "EN_PROGRESO", "SIGUIENTES_PASOS",
            "DECISIONES", "BLOQUEOS", "ARCHIVOS_CLAVE", "CONTEXTO_EXTRA");

    private static final Pattern KEY_LINE =
            Pattern.compile("^\\s*[*#>`\\s]*([A-ZÁÉÍÓÚÑ_]{3,})[*`\\s]*:\\s*(.*)$");
    private static final Pattern NUMBER = Pattern.compile("(\\d{1,3})");

    private StateBlock() {
    }

    public static final class Result {
        /** Most recent real block, or null. */
        public final String block;
        /** True when the newest occurrence is still the unanswered template. */
        public final boolean newestIsTemplate;

        Result(String block, boolean newestIsTemplate) {
            this.block = block;
            this.newestIsTemplate = newestIsTemplate;
        }
    }

    /**
     * Finds the newest status block in {@code text}.
     *
     * @param requireEnd when true (page text, which may still be streaming) a block without its
     *                   closing marker is ignored; when false (clipboard) it runs to the end.
     */
    public static Result find(String text, boolean requireEnd) {
        if (text == null) return new Result(null, false);
        String t = text.replace("\r\n", "\n").replace('\r', '\n');
        int from = t.length();
        boolean newest = true;
        boolean newestTemplate = false;
        while (from > 0) {
            int start = t.lastIndexOf(START, from - 1);
            if (start < 0) break;
            int end = t.indexOf(END, start + START.length());
            String block = null;
            if (end >= 0) {
                block = t.substring(start, end + END.length());
            } else if (!requireEnd) {
                block = t.substring(start).trim() + "\n" + END;
            }
            if (block != null && knownKeys(block) >= 2) {
                if (isTemplate(block)) {
                    if (newest) newestTemplate = true;
                } else {
                    return new Result(normalize(block), newestTemplate);
                }
            }
            newest = false;
            from = start;
        }
        return new Result(null, newestTemplate);
    }

    /** Number of distinct section keys present; prose that merely mentions the markers has none. */
    static int knownKeys(String block) {
        int n = 0;
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (String line : block.split("\n")) {
            Matcher m = KEY_LINE.matcher(line);
            if (m.matches() && KEYS.contains(m.group(1)) && seen.add(m.group(1))) n++;
        }
        return n;
    }

    public static boolean isTemplate(String block) {
        return block.contains(PLACEHOLDER) || block.contains("<tarea completada>");
    }

    /** Trims trailing spaces, drops stray code fences and collapses blank runs. */
    public static String normalize(String block) {
        String[] lines = block.replace("\r\n", "\n").split("\n", -1);
        StringBuilder sb = new StringBuilder();
        int blank = 0;
        for (String raw : lines) {
            String line = rtrim(raw);
            if (line.trim().startsWith("```")) continue;
            if (line.trim().isEmpty()) {
                if (++blank > 1) continue;
            } else {
                blank = 0;
            }
            sb.append(line).append('\n');
        }
        return sb.toString().trim();
    }

    /** Value of PROGRESO clamped to 0..100, or -1 when missing. */
    public static int progress(String block) {
        String v = section(block, "PROGRESO");
        if (v == null) return -1;
        Matcher m = NUMBER.matcher(v);
        if (!m.find()) return -1;
        int p = Integer.parseInt(m.group(1));
        return Math.max(0, Math.min(100, p));
    }

    /** Text of a section: its inline value plus following lines up to the next known key. */
    public static String section(String block, String key) {
        if (block == null) return null;
        String[] lines = block.split("\n");
        StringBuilder sb = null;
        for (String line : lines) {
            if (line.contains(START) || line.contains(END)) {
                if (sb != null) break;
                continue;
            }
            Matcher m = KEY_LINE.matcher(line);
            if (m.matches() && KEYS.contains(m.group(1))) {
                if (sb != null) break;
                if (m.group(1).equals(key)) {
                    sb = new StringBuilder();
                    String inline = m.group(2).replaceAll("^[*_`\\s]+|[*_`\\s]+$", "");
                    if (!inline.isEmpty()) sb.append(inline).append('\n');
                }
                continue;
            }
            if (sb != null) sb.append(line).append('\n');
        }
        return sb == null ? null : sb.toString().trim();
    }

    /** Bullet items of a section without their leading "- ". */
    public static List<String> items(String block, String key) {
        List<String> out = new ArrayList<>();
        String s = section(block, key);
        if (s == null || s.isEmpty()) return out;
        for (String line : s.split("\n")) {
            String l = line.trim();
            if (l.startsWith("- ") || l.startsWith("* ") || l.startsWith("• ")) l = l.substring(2).trim();
            else if (l.equals("-") || l.equals("*")) continue;
            if (!l.isEmpty()) out.add(l);
        }
        return out;
    }

    private static String rtrim(String s) {
        int i = s.length();
        while (i > 0 && Character.isWhitespace(s.charAt(i - 1))) i--;
        return s.substring(0, i);
    }
}
