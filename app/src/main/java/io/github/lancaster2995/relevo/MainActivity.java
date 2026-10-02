package io.github.lancaster2995.relevo;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.Menu;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/** Dashboard: projects, accounts (session windows) and the guide. */
public class MainActivity extends Activity {

    private static final String STATE_TAB = "tab";
    private static final int TAB_PROJECTS = 0, TAB_ACCOUNTS = 1, TAB_GUIDE = 2;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final List<Runnable> tickers = new ArrayList<>();
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            for (Runnable r : tickers) r.run();
            handler.postDelayed(this, 30_000);
        }
    };

    private int tab = TAB_PROJECTS;
    private LinearLayout content;
    private ScrollView scroll;
    private final TextView[] tabs = new TextView[3];

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (saved != null) tab = saved.getInt(STATE_TAB, TAB_PROJECTS);

        LinearLayout root = Ui.vbox(this);
        root.setFitsSystemWindows(true);
        root.setBackgroundColor(Ui.color(this, R.color.bg));

        LinearLayout header = Ui.vbox(this);
        header.setPadding(Ui.dp(this, 20), Ui.dp(this, 18), Ui.dp(this, 20), Ui.dp(this, 6));
        TextView title = Ui.text(this, "Relevo", 26, R.color.text, true);
        header.addView(title);
        header.addView(Ui.muted(this, "Varias sesiones de Claude en paralelo, un proyecto que pasa de cuenta en cuenta hasta terminarse."));
        root.addView(header, Ui.matchWrap());

        LinearLayout tabRow = Ui.hbox(this);
        tabRow.setPadding(Ui.dp(this, 16), Ui.dp(this, 8), Ui.dp(this, 16), Ui.dp(this, 8));
        String[] names = {"Proyectos", "Cuentas", "Guía y ajustes"};
        for (int i = 0; i < names.length; i++) {
            final int index = i;
            TextView t = Ui.text(this, names[i], 14, R.color.text, true);
            t.setGravity(Gravity.CENTER);
            t.setPadding(Ui.dp(this, 8), Ui.dp(this, 9), Ui.dp(this, 8), Ui.dp(this, 9));
            t.setOnClickListener(v -> {
                tab = index;
                scroll.scrollTo(0, 0);
                render();
            });
            LinearLayout.LayoutParams p = Ui.weight(1);
            if (i > 0) p.leftMargin = Ui.dp(this, 6);
            tabRow.addView(t, p);
            tabs[i] = t;
        }
        root.addView(tabRow, Ui.matchWrap());

        scroll = new ScrollView(this);
        content = Ui.vbox(this);
        content.setPadding(Ui.dp(this, 16), Ui.dp(this, 6), Ui.dp(this, 16), Ui.dp(this, 32));
        scroll.addView(content, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);

        maybeAskNotifications();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putInt(STATE_TAB, tab);
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
        handler.removeCallbacks(tick);
        handler.postDelayed(tick, 30_000);
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacks(tick);
    }

    private void maybeAskNotifications() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        Data d = Store.load(this);
        if (d.askedNotifications) return;
        Store.edit(this, data -> data.askedNotifications = true);
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
    }

    private void render() {
        final int y = scroll.getScrollY();
        tickers.clear();
        content.removeAllViews();
        Data data = Store.load(this);
        for (int i = 0; i < tabs.length; i++) {
            boolean on = i == tab;
            tabs[i].setTextColor(Ui.color(this, on ? R.color.on_accent : R.color.text));
            tabs[i].setBackground(Ui.rounded(Ui.color(this, on ? R.color.accent : R.color.surface2),
                    Ui.color(this, on ? R.color.accent : R.color.border), Ui.dp(this, 20), Ui.dp(this, 1)));
        }
        switch (tab) {
            case TAB_ACCOUNTS:
                renderAccounts(data);
                break;
            case TAB_GUIDE:
                renderGuide(data);
                break;
            default:
                renderProjects(data);
        }
        scroll.post(() -> scroll.scrollTo(0, y));
    }

    // ------------------------------------------------------------------ projects

    private void renderProjects(Data d) {
        content.addView(Ui.buttonRow(this,
                Ui.button(this, "+ Nuevo proyecto", Ui.Style.PRIMARY,
                        v -> Dialogs.newProject(this, 0, id -> render())),
                Ui.button(this, "Importar", Ui.Style.NORMAL,
                        v -> Dialogs.importProject(this, this::render))));
        spacer(12);

        if (d.accounts.isEmpty()) {
            LinearLayout hint = Ui.card(this);
            hint.addView(Ui.title(this, "Empieza agregando tus cuentas"));
            TextView t = Ui.body(this, "Cada cuenta abre su propia ventana con la sesión aislada. Agrega al menos dos para poder pasar un proyecto de una a otra.");
            hint.addView(t);
            hint.addView(Ui.buttonRow(this, Ui.button(this, "Ir a Cuentas", Ui.Style.NORMAL, v -> {
                tab = TAB_ACCOUNTS;
                render();
            })));
            content.addView(hint);
        }

        List<Data.Project> projects = d.sortedProjects();
        if (projects.isEmpty()) {
            LinearLayout empty = Ui.card(this);
            empty.addView(Ui.title(this, "Sin proyectos todavía"));
            empty.addView(Ui.body(this, "Crea un proyecto con su objetivo. Relevo genera el prompt de inicio, guarda los estados (checkpoints) que te da Claude y los traspasa a la siguiente cuenta con todo el contexto."));
            content.addView(empty);
            return;
        }
        for (Data.Project p : projects) content.addView(projectCard(d, p));
    }

    private View projectCard(Data d, Data.Project p) {
        LinearLayout card = Ui.card(this);
        LinearLayout top = Ui.hbox(this);
        TextView name = Ui.title(this, p.name);
        top.addView(name, Ui.weight(1));
        top.addView(Ui.text(this, p.progress + "%", 16, R.color.accent, true));
        card.addView(top);
        card.addView(Ui.progress(this, p.progress));

        LinearLayout where = Ui.hbox(this);
        Data.Account acc = d.account(p.currentSlot);
        if (acc != null) where.addView(Ui.dot(this, Ui.parseColor(acc.color, 0xFF888888), 9));
        where.addView(Ui.muted(this, (acc != null ? acc.name : "Sin cuenta asignada")
                + " · actualizado " + Ui.ago(p.updated)));
        card.addView(where);

        if (p.pendingSlot > 0) {
            TextView pending = Ui.text(this, "⏳ Traspaso pendiente → " + d.accountName(p.pendingSlot), 13, R.color.warn, true);
            pending.setPadding(0, Ui.dp(this, 4), 0, 0);
            card.addView(pending);
        }
        String summary = Prompts.summary(p);
        if (!TextUtils.isEmpty(summary)) {
            TextView s = Ui.body(this, summary);
            s.setMaxLines(3);
            s.setEllipsize(TextUtils.TruncateAt.END);
            s.setPadding(0, Ui.dp(this, 8), 0, 0);
            card.addView(s);
        } else if (!TextUtils.isEmpty(p.goal)) {
            TextView s = Ui.body(this, p.goal);
            s.setMaxLines(3);
            s.setEllipsize(TextUtils.TruncateAt.END);
            s.setPadding(0, Ui.dp(this, 8), 0, 0);
            card.addView(s);
        }
        String next = Prompts.nextStep(p);
        if (!TextUtils.isEmpty(next)) {
            TextView n = Ui.muted(this, "Siguiente: " + next);
            n.setMaxLines(2);
            n.setEllipsize(TextUtils.TruncateAt.END);
            n.setPadding(0, Ui.dp(this, 4), 0, 0);
            card.addView(n);
        }

        card.addView(Ui.buttonRow(this,
                Ui.button(this, "Continuar", Ui.Style.PRIMARY, v -> continueProject(p.id)),
                Ui.button(this, "Pasar a…", Ui.Style.NORMAL, v -> Dialogs.transfer(this, p.id, p.currentSlot)),
                Ui.button(this, "Detalles", Ui.Style.NORMAL, v -> openProject(p.id))));
        card.setOnClickListener(v -> openProject(p.id));
        return card;
    }

    private void openProject(String id) {
        Intent i = new Intent(this, ProjectActivity.class);
        i.putExtra(ProjectActivity.EXTRA_ID, id);
        startActivity(i);
    }

    /** Opens the project's current account window, offering the prompt there. */
    private void continueProject(String id) {
        Data d = Store.load(this);
        Data.Project p = d.project(id);
        if (p == null) return;
        if (p.currentSlot == 0 || d.account(p.currentSlot) == null) {
            Dialogs.chooseAccount(this, "¿En qué cuenta continuar «" + p.name + "»?",
                    slot -> Slots.transfer(this, id, 0, slot, 0, false));
            return;
        }
        final int slot = p.currentSlot;
        Store.edit(this, data -> {
            Data.Account a = data.account(slot);
            if (a != null) a.activeProjectId = id;
            Data.Project pr = data.project(id);
            // A project that was never started here gets the start prompt offered.
            if (pr != null && !pr.hasState()) pr.pendingSlot = slot;
        });
        Slots.open(this, slot, false);
    }

    // ------------------------------------------------------------------ accounts

    private void renderAccounts(Data d) {
        content.addView(Ui.buttonRow(this,
                Ui.button(this, "+ Agregar cuenta", Ui.Style.PRIMARY,
                        v -> Dialogs.editAccount(this, null, this::render)),
                Ui.button(this, "Abrir disponibles", Ui.Style.NORMAL, v -> openAllAvailable())));
        spacer(12);
        List<Data.Account> accounts = d.sortedAccounts();
        if (accounts.isEmpty()) {
            LinearLayout empty = Ui.card(this);
            empty.addView(Ui.title(this, "Agrega tu primera cuenta"));
            empty.addView(Ui.body(this, "Cada cuenta usa su propia ventana (hasta " + Data.MAX_SLOTS
                    + ") con cookies separadas: puedes tener varias cuentas de Claude abiertas al mismo tiempo. Después de agregarla, pulsa Abrir e inicia sesión."));
            content.addView(empty);
            return;
        }
        for (Data.Account a : accounts) content.addView(accountCard(d, a));
    }

    private View accountCard(Data d, Data.Account a) {
        LinearLayout card = Ui.card(this);
        LinearLayout top = Ui.hbox(this);
        top.addView(Ui.dot(this, Ui.parseColor(a.color, 0xFF888888), 14));
        LinearLayout names = Ui.vbox(this);
        names.addView(Ui.title(this, a.name));
        if (!TextUtils.isEmpty(a.note)) names.addView(Ui.muted(this, a.note));
        top.addView(names, Ui.weight(1));
        top.addView(Ui.muted(this, "Ventana " + a.slot));
        card.addView(top);

        TextView status = Ui.text(this, "", 14, R.color.ok, true);
        status.setPadding(0, Ui.dp(this, 8), 0, 0);
        Runnable updateStatus = () -> {
            long now = System.currentTimeMillis();
            if (a.isPaused(now)) {
                status.setText("En pausa · vuelve en " + Ui.duration(a.pausedUntil - now)
                        + " (" + Ui.clock(a.pausedUntil) + ")");
                status.setTextColor(Ui.color(this, R.color.warn));
            } else {
                status.setText("Disponible");
                status.setTextColor(Ui.color(this, R.color.ok));
            }
        };
        updateStatus.run();
        tickers.add(updateStatus);
        card.addView(status);

        Data.Project p = d.project(a.activeProjectId);
        StringBuilder info = new StringBuilder();
        info.append(p != null ? "Proyecto: " + p.name + " (" + p.progress + "%)" : "Sin proyecto activo");
        info.append(" · activa ").append(Ui.ago(a.lastActive));
        if (a.startUrl.equals(Data.URL_CODE)) info.append(" · Claude Code");
        if (a.desktopMode) info.append(" · escritorio");
        TextView i = Ui.muted(this, info.toString());
        i.setPadding(0, Ui.dp(this, 2), 0, 0);
        card.addView(i);

        Button more = Ui.button(this, "⋯", Ui.Style.NORMAL, v -> accountMenu(v, a));
        card.addView(Ui.buttonRow(this,
                Ui.button(this, "Abrir", Ui.Style.PRIMARY, v -> Slots.open(this, a.slot, false)),
                Ui.button(this, "Al lado", Ui.Style.NORMAL, v -> Slots.open(this, a.slot, true)),
                Ui.button(this, "Pausa", Ui.Style.NORMAL, v -> Dialogs.pause(this, a.slot, this::render)),
                more));
        return card;
    }

    private void accountMenu(View anchor, Data.Account a) {
        PopupMenu pm = new PopupMenu(this, anchor);
        Menu m = pm.getMenu();
        m.add(0, 1, 0, "Editar");
        if (a.isPaused(System.currentTimeMillis())) m.add(0, 2, 0, "Quitar pausa");
        m.add(0, 3, 0, "Cerrar sesión (borrar cookies)");
        m.add(0, 4, 0, "Eliminar cuenta");
        pm.setOnMenuItemClickListener(item -> {
            switch (item.getItemId()) {
                case 1:
                    Dialogs.editAccount(this, a, this::render);
                    return true;
                case 2:
                    Dialogs.setPause(this, a.slot, 0);
                    render();
                    return true;
                case 3:
                    Dialogs.confirm(this, "Cerrar sesión de «" + a.name + "»",
                            "Se borrarán las cookies y los datos de navegación de esta ventana.",
                            "Cerrar sesión", () -> Slots.launch(this, a.slot, Slots.ACTION_CLEAR, false));
                    return true;
                case 4:
                    Dialogs.confirm(this, "Eliminar «" + a.name + "»",
                            "Se cerrará su ventana y se borrarán sus datos de sesión. Los proyectos se conservan.",
                            "Eliminar", () -> deleteAccount(a.slot));
                    return true;
            }
            return false;
        });
        pm.show();
    }

    private void deleteAccount(int slot) {
        Store.edit(this, d -> {
            Data.Account a = d.account(slot);
            if (a != null) d.accounts.remove(a);
            for (Data.Project p : d.projects) {
                if (p.pendingSlot == slot) p.pendingSlot = 0;
                if (p.currentSlot == slot) p.currentSlot = 0;
            }
        });
        Slots.cancelPauseEnd(this, slot);
        Slots.launch(this, slot, Slots.ACTION_CLEAR_AND_CLOSE, false);
        render();
    }

    private void openAllAvailable() {
        Data d = Store.load(this);
        long now = System.currentTimeMillis();
        int opened = 0;
        for (Data.Account a : d.sortedAccounts()) {
            if (a.isPaused(now)) continue;
            Slots.open(this, a.slot, false);
            opened++;
        }
        Ui.toast(this, opened == 0 ? "No hay cuentas disponibles" : "Abiertas " + opened
                + " ventanas: cambia entre ellas desde Recientes o en pantalla dividida");
    }

    // ------------------------------------------------------------------ guide

    private void renderGuide(Data d) {
        LinearLayout settings = Ui.card(this);
        settings.addView(Ui.title(this, "Ajustes"));
        CheckBox auto = new CheckBox(this);
        auto.setText("Insertar los prompts directamente en el cuadro de mensaje (si no, solo se copian)");
        auto.setTextColor(Ui.color(this, R.color.text));
        auto.setChecked(d.autoInsert);
        auto.setOnCheckedChangeListener((b, on) -> Store.edit(this, data -> data.autoInsert = on));
        settings.addView(auto);
        content.addView(settings);

        section("Cómo funciona",
                "1. Cuentas: agrega cada cuenta de Claude que uses. Cada una abre su propia ventana (como un perfil de Chrome) con cookies separadas, así varias sesiones funcionan al mismo tiempo.\n\n"
                        + "2. Inicia sesión una vez en cada ventana con tu correo (tu dirección de Gmail sirve: Claude te envía un código o enlace). Google no permite «Continuar con Google» dentro de apps porque no son un navegador completo. Si el correo trae un enlace, mantenlo pulsado, cópialo y ábrelo con ⋮ → «Abrir un enlace aquí» para que la sesión quede en esa cuenta (y no en Chrome).\n\n"
                        + "3. Proyectos: crea un proyecto con su objetivo (y repositorio, si lo hay). En la ventana de una cuenta elige el proyecto arriba y pulsa «📨 Traspaso»: se inserta el prompt de inicio en el chat. Revísalo y envíalo.");
        section("Pasar el proyecto a otra cuenta",
                "1. En la ventana actual pulsa «🧭 Pedir estado» y envía el mensaje. Claude responde con un bloque <<<ESTADO … ESTADO>>> (hecho, en progreso, siguientes pasos, decisiones, archivos…).\n\n"
                        + "2. Pulsa «💾 Guardar»: Relevo lee ese bloque de la conversación (o del portapapeles) y lo guarda como checkpoint con su % de progreso.\n\n"
                        + "3. Pulsa «⇄ Pasar», elige la cuenta destino y, si esta alcanzó su límite, cuánto tiempo pausarla. Relevo registra el traspaso, te avisa cuando la cuenta pausada vuelve a estar disponible y abre la ventana destino.\n\n"
                        + "4. En la ventana destino aparece «Traspaso pendiente»: pulsa «Insertar prompt» en un chat nuevo y envíalo. Claude continúa desde los siguientes pasos. Repite hasta terminar.");
        section("Ventanas simultáneas",
                "• «Al lado» abre la cuenta en pantalla dividida (tabletas, plegables y Android 12L o superior).\n"
                        + "• En Samsung DeX o en modo escritorio cada cuenta es una ventana independiente.\n"
                        + "• En el teléfono cambia entre cuentas desde Recientes: cada ventana aparece con su nombre y color.\n"
                        + "• Atrás no cierra la sesión; para cerrarla usa ⋮ → Cerrar ventana.");
        section("Con código (Claude Code)",
                "Si el proyecto tiene repositorio, los prompts piden a Claude hacer commit y push de cada avance y mantener el bloque de estado en HANDOFF.md. Así el estado viaja también con el código. Puedes poner claude.ai/code como página de inicio de una cuenta.");
        section("Privacidad y límites",
                "• Relevo no envía mensajes por ti ni automatiza Claude: solo inserta texto en el cuadro de mensaje cuando pulsas un botón, y tú decides enviarlo.\n"
                        + "• Los proyectos se guardan solo en este teléfono. Puedes exportarlos (Detalles → Exportar JSON) e importarlos en otro.\n"
                        + "• Usa solo tus propias cuentas y respeta los Términos de uso de Anthropic.");
        TextView version = Ui.muted(this, "Relevo " + versionName());
        version.setGravity(Gravity.CENTER);
        version.setPadding(0, Ui.dp(this, 8), 0, 0);
        content.addView(version);
    }

    private void section(String title, String body) {
        LinearLayout card = Ui.card(this);
        card.addView(Ui.title(this, title));
        TextView b = Ui.body(this, body);
        b.setPadding(0, Ui.dp(this, 6), 0, 0);
        card.addView(b);
        content.addView(card);
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "";
        }
    }

    private void spacer(int dp) {
        View v = new View(this);
        content.addView(v, Ui.lp(1, Ui.dp(this, dp)));
    }
}
