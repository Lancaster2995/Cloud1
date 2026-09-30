package io.github.lancaster2995.relevo;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** Project detail: edit the brief and the current state, copy prompts, history, export. */
public class ProjectActivity extends Activity {

    public static final String EXTRA_ID = "project_id";

    private String projectId;
    private LinearLayout content;
    private EditText name, goal, repo, branch, notes, state;
    /** Snapshot of what is on screen, so returning to the screen keeps unsaved edits. */
    private String rendered = "";

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        projectId = getIntent().getStringExtra(EXTRA_ID);
        LinearLayout root = Ui.vbox(this);
        root.setFitsSystemWindows(true);
        root.setBackgroundColor(Ui.color(this, R.color.bg));

        LinearLayout bar = Ui.hbox(this);
        bar.setPadding(Ui.dp(this, 6), Ui.dp(this, 6), Ui.dp(this, 16), Ui.dp(this, 6));
        Button back = Ui.button(this, "←", Ui.Style.QUIET, v -> finish());
        back.setTextSize(20);
        back.setTextColor(Ui.color(this, R.color.text));
        bar.addView(back);
        bar.addView(Ui.text(this, "Proyecto", 18, R.color.text, true), Ui.weight(1));
        root.addView(bar, Ui.matchWrap());

        ScrollView scroll = new ScrollView(this);
        content = Ui.vbox(this);
        content.setPadding(Ui.dp(this, 16), 0, Ui.dp(this, 16), Ui.dp(this, 32));
        content.setFocusableInTouchMode(true);
        content.setDescendantFocusability(ViewGroup.FOCUS_BEFORE_DESCENDANTS);
        scroll.addView(content, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (!signature(Store.load(this)).equals(rendered)) render();
    }

    private String signature(Data d) {
        Data.Project p = project(d);
        if (p == null) return "none";
        return p.updated + "|" + p.stateTime + "|" + p.history.size() + "|" + p.currentSlot + "|"
                + p.pendingSlot + "|" + p.progress + "|" + d.accounts.size();
    }

    private Data.Project project(Data d) {
        return d.project(projectId);
    }

    private void render() {
        Data d = Store.load(this);
        Data.Project p = project(d);
        rendered = signature(d);
        content.removeAllViews();
        if (p == null) {
            content.addView(Ui.body(this, "Este proyecto ya no existe."));
            return;
        }

        // Status overview.
        LinearLayout head = Ui.card(this);
        LinearLayout top = Ui.hbox(this);
        top.addView(Ui.title(this, p.name), Ui.weight(1));
        top.addView(Ui.text(this, p.progress + "%", 18, R.color.accent, true));
        head.addView(top);
        head.addView(Ui.progress(this, p.progress));
        head.addView(Ui.muted(this, "Cuenta actual: " + d.accountName(p.currentSlot)
                + (p.hasState() ? " · estado del " + Prompts.stamp(p.stateTime) : " · sin estado guardado")));
        if (p.pendingSlot > 0) {
            head.addView(Ui.text(this, "⏳ Traspaso pendiente → " + d.accountName(p.pendingSlot), 13, R.color.warn, true));
        }
        head.addView(Ui.buttonRow(this,
                Ui.button(this, "Continuar", Ui.Style.PRIMARY, v -> continueHere(p)),
                Ui.button(this, "Pasar a…", Ui.Style.NORMAL, v -> Dialogs.transfer(this, p.id, p.currentSlot))));
        content.addView(head);

        // Prompts.
        LinearLayout prompts = Ui.card(this);
        prompts.addView(Ui.title(this, "Prompts"));
        prompts.addView(Ui.muted(this, "Cópialos para usarlos en cualquier sesión (también en Chrome u otro dispositivo)."));
        prompts.addView(Ui.buttonRow(this,
                Ui.button(this, p.hasState() ? "Traspaso" : "Inicio", Ui.Style.NORMAL,
                        v -> copyPrompt("Prompt de " + (p.hasState() ? "traspaso" : "inicio"), Prompts.next(p, d))),
                Ui.button(this, "Pedir estado", Ui.Style.NORMAL,
                        v -> copyPrompt("Prompt de checkpoint", Prompts.checkpoint(p)))));
        prompts.addView(Ui.buttonRow(this,
                Ui.button(this, "Ver prompt de traspaso", Ui.Style.QUIET,
                        v -> Dialogs.showMonospace(this, "Prompt", Prompts.next(p, d), null, null))));
        content.addView(prompts);

        // Current state.
        LinearLayout st = Ui.card(this);
        st.addView(Ui.title(this, "Estado actual"));
        st.addView(Ui.muted(this, "Bloque <<<ESTADO … ESTADO>>> que se envía en el traspaso. Puedes editarlo o pegar uno nuevo."));
        state = Ui.field(this, "Aún no hay estado. Pulsa «Pedir estado» en la ventana de la cuenta, o pega aquí el bloque.", p.state, true);
        state.setTypeface(Typeface.MONOSPACE);
        state.setTextSize(13);
        state.setMaxLines(18);
        st.addView(state, Ui.matchWrap());
        st.addView(Ui.buttonRow(this,
                Ui.button(this, "Pegar", Ui.Style.NORMAL, v -> {
                    StateBlock.Result r = StateBlock.find(Ui.paste(this), false);
                    if (r.block == null) {
                        Ui.toast(this, "El portapapeles no tiene un bloque <<<ESTADO");
                    } else {
                        state.setText(r.block);
                    }
                }),
                Ui.button(this, "Guardar estado", Ui.Style.PRIMARY, v -> saveState())));
        content.addView(st);

        // Brief.
        LinearLayout brief = Ui.card(this);
        brief.addView(Ui.title(this, "Datos del proyecto"));
        brief.addView(Ui.label(this, "NOMBRE"));
        name = Ui.field(this, "Nombre", p.name, false);
        brief.addView(name);
        brief.addView(Ui.label(this, "OBJETIVO"));
        goal = Ui.field(this, "Qué debe quedar terminado", p.goal, true);
        brief.addView(goal);
        brief.addView(Ui.label(this, "REPOSITORIO"));
        repo = Ui.field(this, "https://github.com/usuario/repo", p.repo, false);
        repo.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        brief.addView(repo);
        brief.addView(Ui.label(this, "RAMA"));
        branch = Ui.field(this, "main", p.branch, false);
        branch.setInputType(android.text.InputType.TYPE_CLASS_TEXT);
        brief.addView(branch);
        brief.addView(Ui.label(this, "INDICACIONES PARA CADA SESIÓN"));
        notes = Ui.field(this, "Stack, estilo, restricciones… se incluyen en cada prompt", p.notes, true);
        brief.addView(notes);
        brief.addView(Ui.buttonRow(this, Ui.button(this, "Guardar datos", Ui.Style.PRIMARY, v -> saveBrief())));
        content.addView(brief);

        // History.
        LinearLayout hist = Ui.card(this);
        hist.addView(Ui.title(this, "Historial"));
        if (p.history.isEmpty()) hist.addView(Ui.muted(this, "Sin eventos."));
        for (int i = p.history.size() - 1; i >= 0; i--) {
            final Data.Event e = p.history.get(i);
            TextView row = Ui.body(this, (TextUtils.isEmpty(e.text) ? "• " : "▸ ") + Prompts.describe(e));
            row.setPadding(0, Ui.dp(this, 8), 0, Ui.dp(this, 8));
            if (!TextUtils.isEmpty(e.text)) {
                row.setTextColor(Ui.color(this, R.color.accent));
                row.setOnClickListener(v -> Dialogs.showMonospace(this, Prompts.describe(e), e.text,
                        "Restaurar", () -> restore(e)));
            }
            hist.addView(row);
        }
        content.addView(hist);

        // Export / delete.
        LinearLayout more = Ui.card(this);
        more.addView(Ui.title(this, "Exportar"));
        more.addView(Ui.buttonRow(this,
                Ui.button(this, "Compartir resumen", Ui.Style.NORMAL, v -> share(p.name, Prompts.markdown(p, d))),
                Ui.button(this, "Exportar JSON", Ui.Style.NORMAL, v -> exportJson(p))));
        more.addView(Ui.buttonRow(this,
                Ui.button(this, "Eliminar proyecto", Ui.Style.DANGER, v -> Dialogs.confirm(this,
                        "Eliminar «" + p.name + "»", "Se borrarán su estado y su historial en este teléfono.",
                        "Eliminar", this::delete))));
        content.addView(more);
    }

    private void copyPrompt(String label, String text) {
        Ui.copy(this, label, text);
        Ui.toast(this, label + " copiado");
    }

    private void continueHere(Data.Project p) {
        if (p.currentSlot == 0 || Store.load(this).account(p.currentSlot) == null) {
            Dialogs.chooseAccount(this, "¿En qué cuenta continuar?",
                    slot -> Slots.transfer(this, p.id, 0, slot, 0, false));
            return;
        }
        final int slot = p.currentSlot;
        Store.edit(this, d -> {
            Data.Account a = d.account(slot);
            if (a != null) a.activeProjectId = p.id;
            Data.Project pr = d.project(p.id);
            if (pr != null && !pr.hasState()) pr.pendingSlot = slot;
        });
        Slots.open(this, slot, false);
    }

    private void saveState() {
        String text = state.getText().toString().trim();
        if (text.isEmpty()) {
            Ui.toast(this, "El estado está vacío");
            return;
        }
        StateBlock.Result r = StateBlock.find(text, false);
        String block = r.block != null ? r.block : text;
        boolean changed = Slots.saveCheckpoint(this, projectId, 0, block, Data.Event.EDIT);
        Ui.toast(this, changed ? "Estado guardado" : "Sin cambios");
        render();
    }

    private void saveBrief() {
        final String n = name.getText().toString().trim();
        if (n.isEmpty()) {
            name.setError("Escribe un nombre");
            return;
        }
        final String g = goal.getText().toString().trim();
        final String r = repo.getText().toString().trim();
        final String b = branch.getText().toString().trim();
        final String no = notes.getText().toString().trim();
        Store.edit(this, d -> {
            Data.Project p = project(d);
            if (p == null) return;
            p.name = n;
            p.goal = g;
            p.repo = r;
            p.branch = b;
            p.notes = no;
            p.updated = System.currentTimeMillis();
        });
        Ui.toast(this, "Datos guardados");
        render();
    }

    private void restore(Data.Event e) {
        Slots.saveCheckpoint(this, projectId, 0, e.text, Data.Event.RESTORE);
        Ui.toast(this, "Estado restaurado");
        render();
    }

    private void share(String subject, String text) {
        Intent i = new Intent(Intent.ACTION_SEND);
        i.setType("text/plain");
        i.putExtra(Intent.EXTRA_SUBJECT, subject);
        i.putExtra(Intent.EXTRA_TEXT, text);
        startActivity(Intent.createChooser(i, "Compartir"));
    }

    private void exportJson(Data.Project p) {
        try {
            String json = p.toJson().toString(2);
            Ui.copy(this, "Proyecto " + p.name, json);
            Ui.toast(this, "JSON copiado; también puedes compartirlo");
            share("Relevo · " + p.name, json);
        } catch (Exception e) {
            Ui.toast(this, "No se pudo exportar: " + e.getMessage());
        }
    }

    private void delete() {
        Store.edit(this, d -> {
            Data.Project p = project(d);
            if (p != null) d.projects.remove(p);
            for (Data.Account a : d.accounts) if (projectId.equals(a.activeProjectId)) a.activeProjectId = "";
        });
        finish();
    }
}
