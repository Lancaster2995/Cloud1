package io.github.lancaster2995.relevo;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/** Small helpers to build the (dependency-free) UI in code. */
public final class Ui {

    private Ui() {
    }

    public static int dp(Context c, float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                c.getResources().getDisplayMetrics()));
    }

    public static int color(Context c, int res) {
        return c.getColor(res);
    }

    public static int parseColor(String s, int fallback) {
        try {
            return Color.parseColor(s);
        } catch (Exception e) {
            return fallback;
        }
    }

    public static LinearLayout vbox(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    public static LinearLayout hbox(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(Gravity.CENTER_VERTICAL);
        return l;
    }

    public static LinearLayout.LayoutParams lp(int w, int h) {
        return new LinearLayout.LayoutParams(w, h);
    }

    public static LinearLayout.LayoutParams weight(float weight) {
        return new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, weight);
    }

    public static LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    public static LinearLayout.LayoutParams margins(LinearLayout.LayoutParams p, Context c,
                                                    int l, int t, int r, int b) {
        p.setMargins(dp(c, l), dp(c, t), dp(c, r), dp(c, b));
        return p;
    }

    public static TextView text(Context c, CharSequence s, float sp, int colorRes, boolean bold) {
        TextView t = new TextView(c);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color(c, colorRes));
        if (bold) t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        return t;
    }

    public static TextView title(Context c, CharSequence s) {
        return text(c, s, 18, R.color.text, true);
    }

    public static TextView body(Context c, CharSequence s) {
        TextView t = text(c, s, 14, R.color.text, false);
        t.setLineSpacing(0, 1.15f);
        return t;
    }

    public static TextView muted(Context c, CharSequence s) {
        return text(c, s, 13, R.color.text2, false);
    }

    public static GradientDrawable rounded(int fill, int stroke, float radiusPx, int strokePx) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(radiusPx);
        if (strokePx > 0) g.setStroke(strokePx, stroke);
        return g;
    }

    public static LinearLayout card(Context c) {
        LinearLayout l = vbox(c);
        int pad = dp(c, 16);
        l.setPadding(pad, pad, pad, pad);
        l.setBackground(rounded(color(c, R.color.surface), color(c, R.color.border), dp(c, 14), dp(c, 1)));
        LinearLayout.LayoutParams p = matchWrap();
        p.bottomMargin = dp(c, 12);
        l.setLayoutParams(p);
        return l;
    }

    public enum Style { PRIMARY, NORMAL, QUIET, DANGER }

    public static Button button(Context c, String label, Style style, View.OnClickListener l) {
        Button b = new Button(c);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        b.setMinHeight(0);
        b.setMinimumHeight(dp(c, 40));
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setStateListAnimator(null);
        b.setPadding(dp(c, 14), dp(c, 8), dp(c, 14), dp(c, 8));
        int fill, fg, stroke;
        switch (style) {
            case PRIMARY:
                fill = color(c, R.color.accent);
                fg = color(c, R.color.on_accent);
                stroke = fill;
                break;
            case DANGER:
                fill = color(c, R.color.surface);
                fg = color(c, R.color.danger);
                stroke = color(c, R.color.border);
                break;
            case QUIET:
                fill = Color.TRANSPARENT;
                fg = color(c, R.color.accent);
                stroke = Color.TRANSPARENT;
                break;
            default:
                fill = color(c, R.color.surface2);
                fg = color(c, R.color.text);
                stroke = color(c, R.color.border);
        }
        b.setTextColor(fg);
        GradientDrawable shape = rounded(fill, stroke, dp(c, 10), stroke == Color.TRANSPARENT ? 0 : dp(c, 1));
        GradientDrawable mask = rounded(Color.WHITE, Color.WHITE, dp(c, 10), 0);
        b.setBackground(new RippleDrawable(ColorStateList.valueOf(color(c, R.color.ripple)), shape, mask));
        if (l != null) b.setOnClickListener(l);
        return b;
    }

    /** Horizontal row of equally weighted buttons. */
    public static LinearLayout buttonRow(Context c, Button... buttons) {
        LinearLayout row = hbox(c);
        for (int i = 0; i < buttons.length; i++) {
            LinearLayout.LayoutParams p = weight(1);
            if (i > 0) p.leftMargin = dp(c, 8);
            row.addView(buttons[i], p);
        }
        LinearLayout.LayoutParams rp = matchWrap();
        rp.topMargin = dp(c, 10);
        row.setLayoutParams(rp);
        return row;
    }

    public static View dot(Context c, int color, int sizeDp) {
        View v = new View(c);
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(color);
        v.setBackground(g);
        LinearLayout.LayoutParams p = lp(dp(c, sizeDp), dp(c, sizeDp));
        p.rightMargin = dp(c, 8);
        v.setLayoutParams(p);
        return v;
    }

    public static ProgressBar progress(Context c, int value) {
        ProgressBar bar = new ProgressBar(c, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setProgress(Math.max(0, Math.min(100, value)));
        bar.setProgressTintList(ColorStateList.valueOf(color(c, R.color.accent)));
        bar.setProgressBackgroundTintList(ColorStateList.valueOf(color(c, R.color.border)));
        LinearLayout.LayoutParams p = matchWrap();
        p.topMargin = dp(c, 8);
        p.bottomMargin = dp(c, 4);
        bar.setLayoutParams(p);
        return bar;
    }

    public static EditText field(Context c, String hint, String value, boolean multiline) {
        EditText e = new EditText(c);
        e.setHint(hint);
        e.setText(value);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        e.setTextColor(color(c, R.color.text));
        e.setHintTextColor(color(c, R.color.text2));
        if (multiline) {
            e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE
                    | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
            e.setMinLines(2);
            e.setMaxLines(8);
            e.setGravity(Gravity.TOP | Gravity.START);
        } else {
            e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
            e.setSingleLine(true);
        }
        return e;
    }

    public static TextView label(Context c, String s) {
        TextView t = text(c, s, 12, R.color.text2, true);
        LinearLayout.LayoutParams p = matchWrap();
        p.topMargin = dp(c, 12);
        t.setLayoutParams(p);
        return t;
    }

    public static void toast(Context c, String s) {
        Toast.makeText(c, s, Toast.LENGTH_SHORT).show();
    }

    public static void toastLong(Context c, String s) {
        Toast.makeText(c, s, Toast.LENGTH_LONG).show();
    }

    public static void copy(Context c, String label, String text) {
        ClipboardManager cm = (ClipboardManager) c.getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm != null) cm.setPrimaryClip(ClipData.newPlainText(label, text));
    }

    public static String paste(Context c) {
        ClipboardManager cm = (ClipboardManager) c.getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null || !cm.hasPrimaryClip()) return "";
        ClipData clip = cm.getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) return "";
        CharSequence t = clip.getItemAt(0).coerceToText(c);
        return t == null ? "" : t.toString();
    }

    public static String ago(long t) {
        if (t <= 0) return "nunca";
        long s = (System.currentTimeMillis() - t) / 1000;
        if (s < 60) return "hace un momento";
        long m = s / 60;
        if (m < 60) return "hace " + m + " min";
        long h = m / 60;
        if (h < 24) return "hace " + h + " h";
        long d = h / 24;
        return d == 1 ? "hace 1 día" : "hace " + d + " días";
    }

    public static String duration(long ms) {
        long totalMin = Math.max(1, (ms + 59_999) / 60_000);
        long h = totalMin / 60, m = totalMin % 60;
        if (h == 0) return m + " min";
        if (m == 0) return h + " h";
        return h + " h " + m + " min";
    }

    public static String clock(long t) {
        java.util.Calendar now = java.util.Calendar.getInstance();
        java.util.Calendar at = java.util.Calendar.getInstance();
        at.setTimeInMillis(t);
        String hm = String.format(java.util.Locale.US, "%02d:%02d",
                at.get(java.util.Calendar.HOUR_OF_DAY), at.get(java.util.Calendar.MINUTE));
        java.util.Calendar tomorrow = (java.util.Calendar) now.clone();
        tomorrow.add(java.util.Calendar.DAY_OF_YEAR, 1);
        if (sameDay(now, at)) return hm;
        if (sameDay(tomorrow, at)) return "mañana " + hm;
        return at.get(java.util.Calendar.DAY_OF_MONTH) + "/" + (at.get(java.util.Calendar.MONTH) + 1) + " " + hm;
    }

    private static boolean sameDay(java.util.Calendar a, java.util.Calendar b) {
        return a.get(java.util.Calendar.YEAR) == b.get(java.util.Calendar.YEAR)
                && a.get(java.util.Calendar.DAY_OF_YEAR) == b.get(java.util.Calendar.DAY_OF_YEAR);
    }
}
