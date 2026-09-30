package io.github.lancaster2995.relevo;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.TimePickerDialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;

/** Dialogs shared by the dashboard and the session windows. */
public final class Dialogs {

    static final String[] PAUSE_LABELS = {"No pausar", "1 hora", "2 horas", "3 horas", "5 horas", "8 horas", "24 horas"};
    static final long[] PAUSE_MS = {0, 3_600_000L, 7_200_000L, 10_800_000L, 18_000_000L, 28_800_000L, 86_400_000L};

    private Dialogs() {
    }

    private static LinearLayout form(Context c) {
        LinearLayout l = Ui.vbox(c);
        int p = Ui.dp(c, 20);
        l.setPadding(p, Ui.dp(c, 8), p, 0);
        return l;
    }

    private static View scroll(Context c, View content) {
        ScrollView s = new ScrollView(c);
        s.addView(content);
        return s;
    }

    // ------------------------------------------------------------ accounts

    public static void editAccount(Activity a, Data.Account existing, Runnable done) {
        Data d = Store.load(a);
        final int slot = existing != null ? existing.slot : d.freeSlot();
        if (slot == 0) {
            Ui.toast(a, "Máximo " + Data.MAX_SLOTS + " cuentas");
            return;
        }
        LinearLayout f = form(a);
        f.addView(Ui.label(a, "NOMBRE"));
        EditText name = Ui.field(a, "Cuenta " + slot, existing != null ? existing.name : "Cuenta " + slot, false);
        f.addView(name);
        f.addView(Ui.label(a, "NOTA (correo, plan, uso…)"));
        EditText note = Ui.field(a, "p. ej. personal@gmail.com · Pro", existing != null ? existing.note : "", false);
        f.addView(note);

        f.addView(Ui.label(a, "COLOR"));
        final String[] chosen = {existing != null ? existing.color : Data.COLORS[(slot - 1) % Data.COLORS.length]};
        HorizontalScrollView hs = new HorizontalScrollView(a);
        LinearLayout colors = Ui.hbox(a);
        colors.setPadding(0, Ui.dp(a, 6), 0, Ui.dp(a, 6));
        List<View> swatches = new ArrayList<>();
        for (String col : Data.COLORS) {
            View v = new View(a);
            LinearLayout.LayoutParams p = Ui.lp(Ui.dp(a, 34), Ui.dp(a, 34));
            p.rightMargin = Ui.dp(a, 10);
            v.setLayoutParams(p);
            v.setTag(col);
            swatches.add(v);
            v.setOnClickListener(x -> {
                chosen[0] = (String) x.getTag();
                paintSwatches(a, swatches, chosen[0]);
            });
            colors.addView(v);
        }
        paintSwatches(a, swatches, chosen[0]);
        hs.addView(colors);
        f.addView(hs);

        f.addView(Ui.label(a, "PÁGINA DE INICIO"));
        RadioGroup rg = new RadioGroup(a);
        RadioButton chat = radio(a, "Chat (claude.ai)");
        RadioButton code = radio(a, "Claude Code (claude.ai/code)");
        RadioButton other = radio(a, "Otra URL");
        rg.addView(chat);
        rg.addView(code);
        rg.addView(other);
        f.addView(rg);
        String current = existing != null ? existing.startUrl : Data.URL_CHAT;
        EditText url = Ui.field(a, "https://…", current, false);
        url.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        if (Data.URL_CHAT.equals(current)) chat.setChecked(true);
        else if (Data.URL_CODE.equals(current)) code.setChecked(true);
        else other.setChecked(true);
        url.setVisibility(other.isChecked() ? View.VISIBLE : View.GONE);
        rg.setOnCheckedChangeListener((g, id) -> url.setVisibility(id == other.getId() ? View.VISIBLE : View.GONE));
        f.addView(url);

        new AlertDialog.Builder(a)
                .setTitle(existing != null ? "Editar cuenta" : "Nueva cuenta (ventana " + slot + ")")
                .setView(scroll(a, f))
                .setNegativeButton("Cancelar", null)
                .setPositiveButton("Guardar", (dlg, w) -> {
                    String n = name.getText().toString().trim();
                    String start = chat.isChecked() ? Data.URL_CHAT
                            : code.isChecked() ? Data.URL_CODE : normalizeUrl(url.getText().toString());
                    Store.edit(a, data -> {
                        Data.Account acc = data.account(slot);
                        if (acc == null) {
                            acc = new Data.Account();
                            acc.slot = slot;
                            data.accounts.add(acc);
                        }
                        acc.name = n.isEmpty() ? "Cuenta " + slot : n;
                        acc.note = note.getText().toString().trim();
                        acc.color = chosen[0];
                        acc.startUrl = start;
                    });
                    if (done != null) done.run();
                })
                .show();
    }

    private static RadioButton radio(Context c, String label) {
        RadioButton r = new RadioButton(c);
        r.setId(View.generateViewId());
        r.setText(label);
        r.setTextColor(Ui.color(c, R.color.text));
        return r;
    }

    private static void paintSwatches(Context c, List<View> swatches, String chosen) {
        for (View v : swatches) {
            String col = (String) v.getTag();
            GradientDrawable g = new GradientDrawable();
            g.setShape(GradientDrawable.OVAL);
            g.setColor(Ui.parseColor(col, Color.GRAY));
            if (col.equalsIgnoreCase(chosen)) g.setStroke(Ui.dp(c, 3), Ui.color(c, R.color.text));
            v.setBackground(g);
        }
    }

    static String normalizeUrl(String u) {
        u = u.trim();
        if (u.isEmpty()) return Data.URL_CHAT;
        if (!u.startsWith("http://") && !u.startsWith("https://")) u = "https://" + u;
        return u;
    }

    // ------------------------------------------------------------ pause

    public static void pause(Activity a, int slot, Runnable done) {
        Data d = Store.load(a);
        Data.Account acc = d.account(slot);
        if (acc == null) return;
        List<String> labels = new ArrayList<>();
        for (int i = 1; i < PAUSE_LABELS.length; i++) labels.add(PAUSE_LABELS[i]);
        labels.add("Hasta una hora exacta…");
        if (acc.isPaused(System.currentTimeMillis())) labels.add("Quitar la pausa (ya está disponible)");
        new AlertDialog.Builder(a)
                .setTitle("¿Hasta cuándo pausar «" + acc.name + "»?")
                .setItems(labels.toArray(new String[0]), (dlg, which) -> {
                    int timeIdx = PAUSE_LABELS.length - 1;
                    if (which < timeIdx) {
                        setPause(a, slot, System.currentTimeMillis() + PAUSE_MS[which + 1]);
                        if (done != null) done.run();
                    } else if (which == timeIdx) {
                        Calendar now = Calendar.getInstance();
                        new TimePickerDialog(a, (tp, h, m) -> {
                            Calendar at = Calendar.getInstance();
                            at.set(Calendar.HOUR_OF_DAY, h);
                            at.set(Calendar.MINUTE, m);
                            at.set(Calendar.SECOND, 0);
                            if (at.getTimeInMillis() <= System.currentTimeMillis()) at.add(Calendar.DAY_OF_YEAR, 1);
                            setPause(a, slot, at.getTimeInMillis());
                            if (done != null) done.run();
                        }, now.get(Calendar.HOUR_OF_DAY), now.get(Calendar.MINUTE), true).show();
                    } else {
                        setPause(a, slot, 0);
                        if (done != null) done.run();
                    }
                })
                .setNegativeButton("Cancelar", null)
                .show();
    }

    public static void setPause(Context c, int slot, long until) {
        Store.edit(c, data -> {
            Data.Account acc = data.account(slot);
            if (acc != null) acc.pausedUntil = until;
        });
        if (until > System.currentTimeMillis()) {
            Slots.schedulePauseEnd(c, slot, until);
            Ui.toast(c, "En pausa hasta las " + Ui.clock(until) + ". Te avisaré.");
        } else {
            Slots.cancelPauseEnd(c, slot);
        }
    }

    // ------------------------------------------------------------ projects

    public static void newProject(Activity a, int slot, Consumer<String> created) {
        LinearLayout f = form(a);
        f.addView(Ui.label(a, "NOMBRE DEL PROYECTO"));
        EditText name = Ui.field(a, "p. ej. App de inventario", "", false);
        f.addView(name);
        f.addView(Ui.label(a, "OBJETIVO"));
        EditText goal = Ui.field(a, "Qué debe quedar terminado", "", true);
        f.addView(goal);
        f.addView(Ui.label(a, "REPOSITORIO (opcional)"));
        EditText repo = Ui.field(a, "https://github.com/usuario/repo", "", false);
        repo.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        f.addView(repo);
        f.addView(Ui.label(a, "RAMA (opcional)"));
        EditText branch = Ui.field(a, "main", "", false);
        branch.setInputType(android.text.InputType.TYPE_CLASS_TEXT);
        f.addView(branch);
        AlertDialog dlg = new AlertDialog.Builder(a)
                .setTitle("Nuevo proyecto")
                .setView(scroll(a, f))
                .setNegativeButton("Cancelar", null)
                .setPositiveButton("Crear", null)
                .create();
        dlg.setOnShowListener(x -> dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String n = name.getText().toString().trim();
            if (n.isEmpty()) {
                name.setError("Escribe un nombre");
                return;
            }
            final long now = System.currentTimeMillis();
            final String id = UUID.randomUUID().toString();
            Store.edit(a, data -> {
                Data.Project p = new Data.Project();
                p.id = id;
                p.name = n;
                p.goal = goal.getText().toString().trim();
                p.repo = repo.getText().toString().trim();
                p.branch = branch.getText().toString().trim();
                p.created = now;
                p.updated = now;
                p.currentSlot = slot;
                Data.Event e = new Data.Event();
                e.time = now;
                e.type = Data.Event.CREATE;
                e.slot = slot;
                e.accountName = slot > 0 ? data.accountName(slot) : "";
                e.progress = 0;
                p.addEvent(e);
                data.projects.add(p);
                Data.Account acc = data.account(slot);
                if (acc != null) acc.activeProjectId = id;
            });
            dlg.dismiss();
            if (created != null) created.accept(id);
        }));
        dlg.show();
    }

    public static void chooseAccount(Activity a, String title, Consumer<Integer> chosen) {
        Data d = Store.load(a);
        List<Data.Account> list = d.sortedAccounts();
        if (list.isEmpty()) {
            Ui.toast(a, "Primero agrega una cuenta en la pestaña Cuentas");
            return;
        }
        long now = System.currentTimeMillis();
        String[] labels = new String[list.size()];
        for (int i = 0; i < list.size(); i++) labels[i] = accountLabel(list.get(i), now);
        new AlertDialog.Builder(a)
                .setTitle(title)
                .setItems(labels, (dlg, which) -> chosen.accept(list.get(which).slot))
                .setNegativeButton("Cancelar", null)
                .show();
    }

    static String accountLabel(Data.Account acc, long now) {
        if (acc.isPaused(now)) {
            return acc.name + " — en pausa (" + Ui.duration(acc.pausedUntil - now) + ")";
        }
        return acc.name + " — disponible";
    }

    /**
     * Transfer dialog: pick destination account, optional pause for the source account, and
     * whether to open it side by side.
     */
    public static void transfer(Activity a, String projectId, int fromSlot) {
        Data d = Store.load(a);
        Data.Project p = d.project(projectId);
        if (p == null) {
            Ui.toast(a, "Elige un proyecto primero");
            return;
        }
        long now = System.currentTimeMillis();
        List<Data.Account> targets = new ArrayList<>();
        for (Data.Account acc : d.sortedAccounts()) if (acc.slot != fromSlot) targets.add(acc);
        if (targets.isEmpty()) {
            Ui.toastLong(a, "Agrega otra cuenta en el panel principal para poder pasar el proyecto");
            return;
        }
        // Available accounts first.
        int firstAvailable = 0;
        for (int i = 0; i < targets.size(); i++) {
            if (!targets.get(i).isPaused(now)) {
                firstAvailable = i;
                break;
            }
        }
        LinearLayout f = form(a);
        TextView info = Ui.body(a, "«" + p.name + "» · " + p.progress + "%"
                + (p.hasState() ? " · estado guardado " + Ui.ago(p.stateTime)
                : "\nAún no hay estado guardado: se enviará el prompt de inicio."));
        f.addView(info);
        f.addView(Ui.label(a, "PASAR A"));
        String[] labels = new String[targets.size()];
        for (int i = 0; i < targets.size(); i++) labels[i] = accountLabel(targets.get(i), now);
        Spinner target = new Spinner(a);
        target.setAdapter(new ArrayAdapter<>(a, android.R.layout.simple_spinner_dropdown_item, labels));
        target.setSelection(firstAvailable);
        f.addView(target);
        Spinner pause = null;
        if (fromSlot > 0 && d.account(fromSlot) != null) {
            f.addView(Ui.label(a, "PAUSAR «" + d.accountName(fromSlot) + "» (límite alcanzado)"));
            pause = new Spinner(a);
            pause.setAdapter(new ArrayAdapter<>(a, android.R.layout.simple_spinner_dropdown_item, PAUSE_LABELS));
            f.addView(pause);
        }
        CheckBox side = new CheckBox(a);
        side.setText("Abrir al lado (pantalla dividida)");
        side.setTextColor(Ui.color(a, R.color.text));
        f.addView(side);
        final Spinner pauseSpinner = pause;
        new AlertDialog.Builder(a)
                .setTitle("Pasar proyecto a otra cuenta")
                .setView(scroll(a, f))
                .setNegativeButton("Cancelar", null)
                .setPositiveButton("Pasar", (dlg, w) -> {
                    int to = targets.get(target.getSelectedItemPosition()).slot;
                    long pauseMs = pauseSpinner == null ? 0 : PAUSE_MS[pauseSpinner.getSelectedItemPosition()];
                    Slots.transfer(a, projectId, fromSlot, to, pauseMs, side.isChecked());
                })
                .show();
    }

    // ------------------------------------------------------------ import / text

    public static void importProject(Activity a, Runnable done) {
        LinearLayout f = form(a);
        f.addView(Ui.muted(a, "Pega el JSON exportado desde Relevo (Detalles → Exportar JSON), o un bloque de estado <<<ESTADO … ESTADO>>> para crear un proyecto con él."));
        EditText input = Ui.field(a, "{ … }  o  <<<ESTADO …", Ui.paste(a), true);
        input.setMaxLines(12);
        input.setTypeface(Typeface.MONOSPACE);
        f.addView(input);
        new AlertDialog.Builder(a)
                .setTitle("Importar proyecto")
                .setView(scroll(a, f))
                .setNegativeButton("Cancelar", null)
                .setPositiveButton("Importar", (dlg, w) -> {
                    String text = input.getText().toString().trim();
                    try {
                        importText(a, text);
                        if (done != null) done.run();
                    } catch (Exception e) {
                        Ui.toastLong(a, "No se pudo importar: " + e.getMessage());
                    }
                })
                .show();
    }

    static void importText(Context c, String text) throws Exception {
        final long now = System.currentTimeMillis();
        if (text.startsWith("{")) {
            JSONObject o = new JSONObject(text);
            Data.Project imported = Data.Project.fromJson(o);
            if (imported.name.isEmpty()) throw new Exception("el JSON no parece un proyecto");
            Store.edit(c, data -> {
                if (data.project(imported.id) != null) imported.id = UUID.randomUUID().toString();
                imported.currentSlot = data.account(imported.currentSlot) != null ? imported.currentSlot : 0;
                imported.pendingSlot = 0;
                imported.updated = now;
                data.projects.add(imported);
            });
            Ui.toast(c, "Proyecto «" + imported.name + "» importado");
            return;
        }
        StateBlock.Result r = StateBlock.find(text, false);
        if (r.block == null) throw new Exception("no encontré JSON ni un bloque <<<ESTADO");
        String name = StateBlock.section(r.block, "PROYECTO");
        final String projectName = name == null || name.isEmpty() ? "Proyecto importado" : name.split("\n")[0];
        Store.edit(c, data -> {
            Data.Project p = new Data.Project();
            p.name = projectName;
            p.state = r.block;
            p.progress = Math.max(0, StateBlock.progress(r.block));
            p.stateTime = now;
            p.created = now;
            p.updated = now;
            Data.Event e = new Data.Event();
            e.time = now;
            e.type = Data.Event.CHECKPOINT;
            e.accountName = "importación";
            e.progress = p.progress;
            e.text = r.block;
            p.addEvent(e);
            data.projects.add(p);
        });
        Ui.toast(c, "Proyecto «" + projectName + "» creado desde el estado");
    }

    public static void showMonospace(Activity a, String title, String text,
                                     String action, Runnable onAction) {
        TextView t = Ui.text(a, text, 13, R.color.text, false);
        t.setTypeface(Typeface.MONOSPACE);
        t.setTextIsSelectable(true);
        int p = Ui.dp(a, 20);
        t.setPadding(p, Ui.dp(a, 8), p, Ui.dp(a, 8));
        AlertDialog.Builder b = new AlertDialog.Builder(a)
                .setTitle(title)
                .setView(scroll(a, t))
                .setNeutralButton("Copiar", (dlg, w) -> {
                    Ui.copy(a, title, text);
                    Ui.toast(a, "Copiado");
                })
                .setNegativeButton("Cerrar", null);
        if (action != null && onAction != null) b.setPositiveButton(action, (dlg, w) -> onAction.run());
        b.show();
    }

    public static void confirm(Activity a, String title, String message, String yes, Runnable onYes) {
        new AlertDialog.Builder(a)
                .setTitle(title)
                .setMessage(message)
                .setNegativeButton("Cancelar", null)
                .setPositiveButton(yes, (dlg, w) -> onYes.run())
                .show();
    }
}
