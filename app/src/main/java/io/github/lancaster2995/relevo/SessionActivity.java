package io.github.lancaster2995.relevo;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.ActivityManager;
import android.app.Dialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.provider.MediaStore;
import android.text.TextUtils;
import android.util.Base64;
import android.view.Gravity;
import android.view.Menu;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebViewDatabase;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.Spinner;
import android.widget.TextView;

import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * One browser window bound to one account slot. Subclasses only pick the slot; the manifest
 * puts each of them in its own process (isolated cookies) and its own task (separate window).
 */
public abstract class SessionActivity extends Activity {

    protected abstract int slot();

    private static final int REQ_FILE = 41;
    private static final String STATE_URL = "relevo.url";

    private final Handler main = new Handler(Looper.getMainLooper());

    private FrameLayout webContainer;
    private WebView web;
    private ProgressBar loadBar;
    private View colorStrip;
    private View colorDot;
    private TextView accountLabel;
    private Spinner projectSpinner;
    private LinearLayout actionRow;
    private Button toggleButton;
    private LinearLayout banner;
    private TextView bannerText;

    private final List<String> spinnerIds = new ArrayList<>();
    private boolean spinnerUpdating;

    private String mobileUa;
    private String desktopUa;
    private boolean desktopApplied;
    private String startUrl = Data.URL_CHAT;
    private volatile String lastUrl = "";
    private volatile long downloadRequestedAt;

    private ValueCallback<Uri[]> fileCallback;
    private Dialog popupDialog;
    private WebView popupWeb;

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        String action = getIntent().getStringExtra(Slots.EXTRA_ACTION);
        if (Slots.ACTION_CLEAR_AND_CLOSE.equals(action)) {
            clearSessionData(true);
            return;
        }
        ensureAccount();
        buildUi();
        computeUserAgents();
        web = createWebView();
        webContainer.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        refresh();

        boolean restored = false;
        if (saved != null) {
            restored = web.restoreState(saved) != null;
            if (!restored) {
                String url = saved.getString(STATE_URL);
                if (!TextUtils.isEmpty(url)) {
                    web.loadUrl(url);
                    restored = true;
                }
            }
        }
        if (!restored) web.loadUrl(startUrl);
        if (Slots.ACTION_CLEAR.equals(action)) clearSessionData(false);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String action = intent.getStringExtra(Slots.EXTRA_ACTION);
        if (Slots.ACTION_CLEAR_AND_CLOSE.equals(action)) {
            clearSessionData(true);
        } else if (Slots.ACTION_CLEAR.equals(action)) {
            clearSessionData(false);
        } else if (web != null) {
            refresh();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web == null) return;
        web.onResume();
        refresh();
        touch();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web == null) return;
        web.onPause();
        CookieManager.getInstance().flush();
        touch();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) {
            web.saveState(out);
            out.putString(STATE_URL, web.getUrl());
        }
    }

    @Override
    protected void onDestroy() {
        closePopup();
        if (web != null) {
            webContainer.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (popupDialog != null) {
            closePopup();
        } else if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            // Keep the session alive; just send the window to the background.
            moveTaskToBack(true);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (fileCallback == null) return;
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    result = new Uri[n];
                    for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(result);
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // ------------------------------------------------------------------ data

    private void ensureAccount() {
        Data d = Store.load(this);
        if (d.account(slot()) != null) return;
        Store.edit(this, data -> {
            if (data.account(slot()) != null) return;
            Data.Account a = new Data.Account();
            a.slot = slot();
            a.name = "Cuenta " + slot();
            a.color = Data.COLORS[(slot() - 1) % Data.COLORS.length];
            data.accounts.add(a);
        });
    }

    private void touch() {
        final long now = System.currentTimeMillis();
        Store.edit(this, d -> {
            Data.Account a = d.account(slot());
            if (a != null) a.lastActive = now;
        });
    }

    private Data.Account account(Data d) {
        Data.Account a = d.account(slot());
        if (a == null) {
            a = new Data.Account();
            a.slot = slot();
            a.name = "Cuenta " + slot();
        }
        return a;
    }

    private Data.Project activeProject(Data d) {
        return d.project(account(d).activeProjectId);
    }

    /** Re-reads the shared store and updates toolbar, banner, title and user agent. */
    private void refresh() {
        Data d = Store.load(this);
        Data.Account a = account(d);
        int color = Ui.parseColor(a.color, Ui.color(this, R.color.accent));
        startUrl = TextUtils.isEmpty(a.startUrl) ? Data.URL_CHAT : a.startUrl;
        accountLabel.setText(a.name);
        colorStrip.setBackgroundColor(color);
        colorDot.setBackground(Ui.rounded(color, color, Ui.dp(this, 5), 0));
        setTaskDescription(new ActivityManager.TaskDescription("Relevo · " + a.name,
                R.mipmap.ic_launcher, color));

        // Project selector.
        spinnerUpdating = true;
        spinnerIds.clear();
        List<String> labels = new ArrayList<>();
        spinnerIds.add("");
        labels.add("Sin proyecto");
        int selected = 0;
        for (Data.Project p : d.sortedProjects()) {
            spinnerIds.add(p.id);
            labels.add(p.name + " · " + p.progress + "%");
            if (p.id.equals(a.activeProjectId)) selected = spinnerIds.size() - 1;
        }
        spinnerIds.add("+");
        labels.add("+ Nuevo proyecto…");
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this, R.layout.spinner_item, labels);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        projectSpinner.setAdapter(adapter);
        projectSpinner.setSelection(selected, false);
        main.post(() -> spinnerUpdating = false);

        // Toolbar collapse.
        actionRow.setVisibility(d.toolbarCollapsed ? View.GONE : View.VISIBLE);
        toggleButton.setText(d.toolbarCollapsed ? "▾" : "▴");

        // Pending handoff banner.
        Data.Project pending = null;
        for (Data.Project p : d.projects) if (p.pendingSlot == slot()) pending = p;
        if (pending != null) {
            bannerText.setText((pending.hasState()
                    ? "Traspaso pendiente: «" + pending.name + "» (" + pending.progress + "%)."
                    : "Proyecto nuevo asignado a esta cuenta: «" + pending.name + "».")
                    + " Pulsa «Insertar prompt» para continuarlo aquí.");
            banner.setTag(pending.id);
            banner.setVisibility(View.VISIBLE);
        } else {
            banner.setVisibility(View.GONE);
        }

        if (web != null && a.desktopMode != desktopApplied) {
            applyUserAgent(web.getSettings(), a.desktopMode);
            web.reload();
        }
    }

    // ------------------------------------------------------------------ UI

    private void buildUi() {
        LinearLayout root = Ui.vbox(this);
        root.setFitsSystemWindows(true);
        root.setBackgroundColor(Ui.color(this, R.color.surface));

        colorStrip = new View(this);
        root.addView(colorStrip, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 3)));

        // Row 1: account + project + toggle + menu.
        LinearLayout row1 = Ui.hbox(this);
        row1.setPadding(Ui.dp(this, 10), Ui.dp(this, 2), Ui.dp(this, 2), Ui.dp(this, 2));
        colorDot = new View(this);
        LinearLayout.LayoutParams dotLp = Ui.lp(Ui.dp(this, 10), Ui.dp(this, 10));
        dotLp.rightMargin = Ui.dp(this, 8);
        row1.addView(colorDot, dotLp);
        accountLabel = Ui.text(this, "", 14, R.color.text, true);
        accountLabel.setSingleLine(true);
        accountLabel.setEllipsize(TextUtils.TruncateAt.END);
        accountLabel.setMaxWidth(Ui.dp(this, 120));
        accountLabel.setOnClickListener(v -> openDashboard());
        row1.addView(accountLabel);
        projectSpinner = new Spinner(this);
        LinearLayout.LayoutParams spLp = new LinearLayout.LayoutParams(0, Ui.dp(this, 40), 1);
        spLp.leftMargin = Ui.dp(this, 4);
        row1.addView(projectSpinner, spLp);
        projectSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (spinnerUpdating || position < 0 || position >= spinnerIds.size()) return;
                String pid = spinnerIds.get(position);
                if ("+".equals(pid)) {
                    Dialogs.newProject(SessionActivity.this, slot(), created -> refresh());
                    refresh();
                    return;
                }
                Store.edit(SessionActivity.this, d -> {
                    Data.Account a = d.account(slot());
                    if (a != null) a.activeProjectId = pid;
                });
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {
            }
        });
        toggleButton = iconButton("▴", v -> {
            Data d = Store.edit(this, data -> data.toolbarCollapsed = !data.toolbarCollapsed);
            actionRow.setVisibility(d.toolbarCollapsed ? View.GONE : View.VISIBLE);
            toggleButton.setText(d.toolbarCollapsed ? "▾" : "▴");
        });
        row1.addView(toggleButton);
        Button more = iconButton("⋮", this::showMenu);
        row1.addView(more);
        root.addView(row1, Ui.matchWrap());

        // Row 2: the handoff actions.
        actionRow = Ui.hbox(this);
        actionRow.setPadding(Ui.dp(this, 8), 0, Ui.dp(this, 8), Ui.dp(this, 6));
        actionRow.addView(actionButton("📨 Traspaso", v -> insertHandoff(null)), weighted(0));
        actionRow.addView(actionButton("🧭 Pedir estado", v -> insertCheckpoint()), weighted(6));
        actionRow.addView(actionButton("💾 Guardar", v -> saveStateFromPage(false)), weighted(6));
        actionRow.addView(actionButton("⇄ Pasar", v -> startTransfer()), weighted(6));
        root.addView(actionRow, Ui.matchWrap());

        // Pending handoff banner.
        banner = Ui.vbox(this);
        banner.setPadding(Ui.dp(this, 12), Ui.dp(this, 10), Ui.dp(this, 12), Ui.dp(this, 10));
        banner.setBackgroundColor(Ui.color(this, R.color.banner));
        bannerText = Ui.text(this, "", 13, R.color.text, false);
        banner.addView(bannerText);
        LinearLayout bannerButtons = Ui.hbox(this);
        bannerButtons.setGravity(Gravity.END);
        bannerButtons.addView(Ui.button(this, "Descartar", Ui.Style.QUIET, v -> dismissPending()));
        Button insert = Ui.button(this, "Insertar prompt", Ui.Style.PRIMARY,
                v -> insertHandoff((String) banner.getTag()));
        LinearLayout.LayoutParams insLp = Ui.lp(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        insLp.leftMargin = Ui.dp(this, 8);
        bannerButtons.addView(insert, insLp);
        LinearLayout.LayoutParams bbLp = Ui.matchWrap();
        bbLp.topMargin = Ui.dp(this, 6);
        banner.addView(bannerButtons, bbLp);
        banner.setVisibility(View.GONE);
        root.addView(banner, Ui.matchWrap());

        loadBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        loadBar.setMax(100);
        loadBar.setIndeterminate(false);
        loadBar.setProgressTintList(android.content.res.ColorStateList.valueOf(Ui.color(this, R.color.accent)));
        root.addView(loadBar, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 3)));

        webContainer = new FrameLayout(this);
        webContainer.setBackgroundColor(Ui.color(this, R.color.bg));
        root.addView(webContainer, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        setContentView(root);
    }

    private LinearLayout.LayoutParams weighted(int leftMarginDp) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
        p.leftMargin = Ui.dp(this, leftMarginDp);
        return p;
    }

    private Button actionButton(String label, View.OnClickListener l) {
        Button b = Ui.button(this, label, Ui.Style.NORMAL, l);
        b.setTextSize(12);
        b.setMaxLines(2);
        b.setMinimumHeight(Ui.dp(this, 36));
        b.setPadding(Ui.dp(this, 4), Ui.dp(this, 4), Ui.dp(this, 4), Ui.dp(this, 4));
        return b;
    }

    private Button iconButton(String label, View.OnClickListener l) {
        Button b = Ui.button(this, label, Ui.Style.QUIET, l);
        b.setTextSize(18);
        b.setTextColor(Ui.color(this, R.color.text));
        b.setPadding(Ui.dp(this, 10), 0, Ui.dp(this, 10), 0);
        b.setMinimumWidth(Ui.dp(this, 40));
        return b;
    }

    private void showMenu(View anchor) {
        Data d = Store.load(this);
        Data.Account a = account(d);
        PopupMenu pm = new PopupMenu(this, anchor);
        Menu m = pm.getMenu();
        m.add(0, 1, 0, "Recargar");
        m.add(0, 2, 0, "Nuevo chat");
        m.add(0, 3, 0, "Claude Code");
        m.add(0, 4, 0, "Detalles del proyecto");
        m.add(0, 5, 0, "Panel principal");
        m.add(0, 15, 0, "Abrir otra cuenta al lado…");
        m.add(0, 6, 0, "Pausar esta cuenta…");
        m.add(0, 7, 0, "Modo escritorio").setCheckable(true).setChecked(a.desktopMode);
        m.add(0, 8, 0, "Insertar prompts en el chat").setCheckable(true).setChecked(d.autoInsert);
        m.add(0, 9, 0, "Pegar estado a mano…");
        m.add(0, 14, 0, "Abrir un enlace aquí (p. ej. de inicio de sesión)…");
        m.add(0, 10, 0, "Abrir en el navegador");
        m.add(0, 11, 0, "Copiar enlace");
        m.add(0, 12, 0, "Cerrar sesión de esta cuenta…");
        m.add(0, 13, 0, "Cerrar ventana");
        pm.setOnMenuItemClickListener(item -> {
            switch (item.getItemId()) {
                case 1:
                    web.reload();
                    return true;
                case 2:
                    web.loadUrl(Data.URL_CHAT);
                    return true;
                case 3:
                    web.loadUrl(Data.URL_CODE);
                    return true;
                case 4:
                    openProjectDetails();
                    return true;
                case 5:
                    openDashboard();
                    return true;
                case 6:
                    Dialogs.pause(this, slot(), null);
                    return true;
                case 7:
                    Store.edit(this, data -> {
                        Data.Account acc = data.account(slot());
                        if (acc != null) acc.desktopMode = !acc.desktopMode;
                    });
                    refresh();
                    return true;
                case 8:
                    Data after = Store.edit(this, data -> data.autoInsert = !data.autoInsert);
                    Ui.toast(this, after.autoInsert ? "Los prompts se insertarán en el chat"
                            : "Los prompts solo se copiarán al portapapeles");
                    return true;
                case 9:
                    manualState();
                    return true;
                case 10:
                    openExternal(Uri.parse(web.getUrl() == null ? startUrl : web.getUrl()));
                    return true;
                case 11:
                    Ui.copy(this, "enlace", web.getUrl() == null ? "" : web.getUrl());
                    Ui.toast(this, "Enlace copiado");
                    return true;
                case 12:
                    Dialogs.confirm(this, "Cerrar sesión", "Se borrarán las cookies y datos de «"
                                    + a.name + "» en esta ventana. Tendrás que volver a iniciar sesión.",
                            "Cerrar sesión", () -> clearSessionData(false));
                    return true;
                case 13:
                    finishAndRemoveTask();
                    return true;
                case 14:
                    openLinkDialog();
                    return true;
                case 15:
                    openOtherAdjacent();
                    return true;
            }
            return false;
        });
        pm.show();
    }

    /** Opens another account's window next to this one (split screen / free-form windows). */
    private void openOtherAdjacent() {
        Data d = Store.load(this);
        long now = System.currentTimeMillis();
        List<Data.Account> others = new ArrayList<>();
        for (Data.Account acc : d.sortedAccounts()) if (acc.slot != slot()) others.add(acc);
        if (others.isEmpty()) {
            Ui.toast(this, "Agrega otra cuenta en el panel principal");
            return;
        }
        String[] labels = new String[others.size()];
        for (int i = 0; i < others.size(); i++) labels[i] = Dialogs.accountLabel(others.get(i), now);
        new android.app.AlertDialog.Builder(this)
                .setTitle("Abrir al lado")
                .setItems(labels, (dlg, which) -> Slots.open(this, others.get(which).slot, true))
                .setNegativeButton("Cancelar", null)
                .show();
    }

    /** Sign-in links from e-mail open in the default browser; this loads them in this window. */
    private void openLinkDialog() {
        String clip = Ui.paste(this).trim();
        EditText input = Ui.field(this, "https://claude.ai/…", clip.startsWith("http") ? clip : "", false);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        int pad = Ui.dp(this, 20);
        FrameLayout wrap = new FrameLayout(this);
        wrap.setPadding(pad, Ui.dp(this, 8), pad, 0);
        wrap.addView(input);
        new android.app.AlertDialog.Builder(this)
                .setTitle("Abrir enlace en esta ventana")
                .setMessage("Útil para el enlace de inicio de sesión que llega por correo: mantén pulsado el enlace en el correo, cópialo y pégalo aquí, así la sesión se abre en esta cuenta y no en Chrome.")
                .setView(wrap)
                .setNegativeButton("Cancelar", null)
                .setPositiveButton("Abrir", (dlg, w) -> {
                    String url = input.getText().toString().trim();
                    if (url.isEmpty()) return;
                    web.loadUrl(Dialogs.normalizeUrl(url));
                })
                .show();
    }

    private void openDashboard() {
        Intent i = new Intent(this, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(i);
    }

    private void openProjectDetails() {
        Data.Project p = activeProject(Store.load(this));
        if (p == null) {
            Ui.toast(this, "Esta ventana no tiene un proyecto seleccionado");
            return;
        }
        Intent i = new Intent(this, ProjectActivity.class);
        i.putExtra(ProjectActivity.EXTRA_ID, p.id);
        startActivity(i);
    }

    // ------------------------------------------------------------------ handoff actions

    /** Inserts the start/handoff prompt of the active (or given) project into the chat box. */
    private void insertHandoff(String projectId) {
        Data d = Store.load(this);
        Data.Project p = projectId != null ? d.project(projectId) : activeProject(d);
        if (p == null) {
            askForProject(() -> insertHandoff(null));
            return;
        }
        final String id = p.id;
        final String text = Prompts.next(p, d);
        final Runnable done = () -> Store.edit(this, data -> {
            Data.Project pr = data.project(id);
            if (pr == null) return;
            if (pr.pendingSlot == slot()) pr.pendingSlot = 0;
            pr.currentSlot = slot();
            Data.Account a = data.account(slot());
            if (a != null) a.activeProjectId = id;
        });
        banner.setVisibility(View.GONE);
        String newChat = newChatUrlIfInConversation();
        if (newChat == null) {
            deliver(text, done);
            return;
        }
        new android.app.AlertDialog.Builder(this)
                .setTitle("Hay una conversación abierta")
                .setMessage("El traspaso funciona mejor en un chat nuevo. ¿Dónde lo inserto?")
                .setNegativeButton("Aquí", (dlg, w) -> deliver(text, done))
                .setPositiveButton("Chat nuevo", (dlg, w) -> {
                    web.loadUrl(newChat);
                    Ui.copy(this, "prompt", text);
                    main.postDelayed(() -> attemptInsert(text, 14, done), 1500);
                })
                .show();
    }

    /** The "new chat" URL when the page shows an existing conversation, else null. */
    private String newChatUrlIfInConversation() {
        String url = web == null ? null : web.getUrl();
        if (url == null) return null;
        Uri u = Uri.parse(url);
        String host = u.getHost() == null ? "" : u.getHost();
        String path = u.getPath() == null ? "" : u.getPath();
        if (!host.endsWith("claude.ai")) return null;
        if (path.matches("^/chat/.+")) return Data.URL_CHAT;
        if (path.matches("^/code/.+")) return Data.URL_CODE;
        return null;
    }

    private void insertCheckpoint() {
        Data d = Store.load(this);
        Data.Project p = activeProject(d);
        if (p == null) {
            askForProject(this::insertCheckpoint);
            return;
        }
        deliver(Prompts.checkpoint(p), null);
    }

    private void dismissPending() {
        final String id = (String) banner.getTag();
        Store.edit(this, d -> {
            Data.Project p = d.project(id);
            if (p != null && p.pendingSlot == slot()) p.pendingSlot = 0;
        });
        banner.setVisibility(View.GONE);
    }

    private void askForProject(Runnable then) {
        Data d = Store.load(this);
        List<Data.Project> list = d.sortedProjects();
        String[] labels = new String[list.size() + 1];
        for (int i = 0; i < list.size(); i++) labels[i] = list.get(i).name + " · " + list.get(i).progress + "%";
        labels[list.size()] = "+ Nuevo proyecto…";
        new android.app.AlertDialog.Builder(this)
                .setTitle("¿En qué proyecto trabaja esta ventana?")
                .setItems(labels, (dlg, which) -> {
                    if (which == list.size()) {
                        Dialogs.newProject(this, slot(), id -> {
                            refresh();
                            then.run();
                        });
                        return;
                    }
                    final String id = list.get(which).id;
                    Store.edit(this, data -> {
                        Data.Account a = data.account(slot());
                        if (a != null) a.activeProjectId = id;
                    });
                    refresh();
                    then.run();
                })
                .setNegativeButton("Cancelar", null)
                .show();
    }

    /** Copies the text and, if enabled, places it in the chat box (never sends it). */
    private void deliver(String text, Runnable delivered) {
        Ui.copy(this, "prompt", text);
        Data d = Store.load(this);
        if (!d.autoInsert || web == null) {
            Ui.toastLong(this, "Copiado. Mantén pulsado el cuadro de mensaje y elige Pegar.");
            if (delivered != null) delivered.run();
            return;
        }
        attemptInsert(text, 6, delivered);
    }

    /** Tries to place the text in the chat box, retrying while the page is still loading. */
    private void attemptInsert(String text, int retries, Runnable delivered) {
        if (web == null) return;
        web.evaluateJavascript(Js.insert(text), value -> {
            String r = Js.decode(value);
            if ("noel".equals(r) && retries > 0) {
                main.postDelayed(() -> attemptInsert(text, retries - 1, delivered), 700);
                return;
            }
            if ("ok".equals(r)) {
                Ui.toast(this, "Listo en el cuadro de mensaje: revísalo y envíalo.");
            } else if ("noel".equals(r)) {
                Ui.toastLong(this, "Copiado. Abre un chat y pega el texto en el cuadro de mensaje.");
            } else {
                Ui.toastLong(this, "Copiado. Mantén pulsado el cuadro de mensaje y elige Pegar.");
            }
            if (delivered != null) delivered.run();
        });
    }

    private interface BlockCallback {
        void onResult(StateBlock.Result pageResult);
    }

    private void readPageBlock(BlockCallback cb) {
        if (web == null) {
            cb.onResult(new StateBlock.Result(null, false));
            return;
        }
        web.evaluateJavascript(Js.PAGE_TEXT, value -> cb.onResult(StateBlock.find(Js.decode(value), true)));
    }

    /**
     * Saves the newest status block visible in the conversation (or, failing that, on the
     * clipboard) as the project's current state.
     */
    private void saveStateFromPage(boolean quiet) {
        Data d = Store.load(this);
        Data.Project p = activeProject(d);
        if (p == null) {
            if (!quiet) askForProject(() -> saveStateFromPage(false));
            return;
        }
        final String id = p.id;
        readPageBlock(result -> {
            String block = result.block;
            String source = "la conversación";
            if (block == null || result.newestIsTemplate) {
                StateBlock.Result clip = StateBlock.find(Ui.paste(this), false);
                if (clip.block != null) {
                    block = clip.block;
                    source = "el portapapeles";
                } else if (result.newestIsTemplate) {
                    if (!quiet) Ui.toastLong(this, "Claude aún no ha respondido con el estado. Espera a que termine y vuelve a pulsar Guardar.");
                    return;
                }
            }
            if (block == null) {
                if (!quiet) noBlockFound();
                return;
            }
            boolean changed = Slots.saveCheckpoint(this, id, slot(), block, Data.Event.CHECKPOINT);
            int progress = StateBlock.progress(block);
            if (changed) {
                Ui.toast(this, "Estado guardado desde " + source + (progress >= 0 ? " · " + progress + "%" : ""));
                refresh();
            } else if (!quiet) {
                Ui.toast(this, "Ese estado ya estaba guardado");
            }
        });
    }

    private void noBlockFound() {
        new android.app.AlertDialog.Builder(this)
                .setTitle("No encontré el bloque de estado")
                .setMessage("Pulsa «Pedir estado», envía el mensaje y, cuando Claude responda con el bloque <<<ESTADO … ESTADO>>>, vuelve a pulsar «Guardar». También puedes pegarlo a mano.")
                .setNegativeButton("Cerrar", null)
                .setNeutralButton("Pegar a mano", (dlg, w) -> manualState())
                .setPositiveButton("Pedir estado", (dlg, w) -> insertCheckpoint())
                .show();
    }

    private void manualState() {
        Data d = Store.load(this);
        Data.Project p = activeProject(d);
        if (p == null) {
            askForProject(this::manualState);
            return;
        }
        final String id = p.id;
        EditText input = Ui.field(this, "<<<ESTADO …", p.state, true);
        input.setTypeface(Typeface.MONOSPACE);
        input.setMaxLines(14);
        int pad = Ui.dp(this, 20);
        FrameLayout wrap = new FrameLayout(this);
        wrap.setPadding(pad, Ui.dp(this, 8), pad, 0);
        wrap.addView(input);
        new android.app.AlertDialog.Builder(this)
                .setTitle("Estado de «" + p.name + "»")
                .setView(wrap)
                .setNegativeButton("Cancelar", null)
                .setNeutralButton("Pegar", null)
                .setPositiveButton("Guardar", (dlg, w) -> {
                    String text = input.getText().toString();
                    StateBlock.Result r = StateBlock.find(text, false);
                    String block = r.block != null ? r.block : text.trim();
                    if (block.isEmpty()) return;
                    if (Slots.saveCheckpoint(this, id, slot(), block, Data.Event.EDIT)) {
                        Ui.toast(this, "Estado guardado");
                        refresh();
                    }
                })
                .show()
                .getButton(android.app.AlertDialog.BUTTON_NEUTRAL)
                .setOnClickListener(v -> input.setText(Ui.paste(this)));
    }

    private void startTransfer() {
        Data d = Store.load(this);
        Data.Project p = activeProject(d);
        if (p == null) {
            askForProject(this::startTransfer);
            return;
        }
        final String id = p.id;
        // Grab the latest state shown in this conversation first, so nothing is lost.
        readPageBlock(result -> {
            if (result.block != null && !result.newestIsTemplate) {
                if (Slots.saveCheckpoint(this, id, slot(), result.block, Data.Event.CHECKPOINT)) {
                    Ui.toast(this, "Estado de la conversación guardado");
                }
            }
            Data fresh = Store.load(this);
            Data.Project pr = fresh.project(id);
            if (pr != null && result.newestIsTemplate) {
                Ui.toastLong(this, "Ojo: Claude aún no respondió al último «Pedir estado»; se pasará el estado guardado anterior.");
            }
            Dialogs.transfer(this, id, slot());
        });
    }

    // ------------------------------------------------------------------ WebView

    private void computeUserAgents() {
        String def = null;
        try {
            def = WebSettings.getDefaultUserAgent(this);
        } catch (Exception ignored) {
            // Fall back below.
        }
        if (def == null || !def.contains("Chrome/")) {
            def = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
        }
        // Drop the WebView markers so sign-in providers treat this like mobile Chrome.
        mobileUa = def.replace("; wv)", ")").replaceFirst("Version/\\d+(\\.\\d+)* ", "");
        Matcher m = Pattern.compile("Chrome/([\\d.]+)").matcher(def);
        String version = m.find() ? m.group(1) : "124.0.0.0";
        desktopUa = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"
                + version + " Safari/537.36";
    }

    private void applyUserAgent(WebSettings s, boolean desktop) {
        s.setUserAgentString(desktop ? desktopUa : mobileUa);
        desktopApplied = desktop;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configure(WebView w) {
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        applyUserAgent(s, account(Store.load(this)).desktopMode);
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(w, true);
        w.setBackgroundColor(Ui.color(this, R.color.bg));
    }

    private WebView createWebView() {
        WebView w = new WebView(this);
        configure(w);
        w.setWebViewClient(new MainClient());
        w.setWebChromeClient(new MainChrome());
        w.setDownloadListener(this::onDownload);
        w.addJavascriptInterface(new Bridge(), "RelevoBridge");
        return w;
    }

    private class MainClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleSpecialScheme(request.getUrl());
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            lastUrl = url == null ? "" : url;
            loadBar.setVisibility(View.VISIBLE);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            loadBar.setVisibility(View.GONE);
            CookieManager.getInstance().flush();
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            lastUrl = url == null ? "" : url;
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The renderer died (usually memory pressure with many windows): rebuild the view
            // instead of letting the whole process crash.
            if (view == popupWeb) {
                closePopup();
                return true;
            }
            if (view != web) {
                view.destroy();
                return true;
            }
            String url = lastUrl;
            webContainer.removeView(web);
            web.destroy();
            web = createWebView();
            webContainer.addView(web, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            web.loadUrl(TextUtils.isEmpty(url) ? startUrl : url);
            Ui.toast(SessionActivity.this, "La página se recargó (memoria insuficiente)");
            return true;
        }
    }

    private class MainChrome extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            loadBar.setProgress(newProgress);
            loadBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            if (params != null && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            try {
                startActivityForResult(Intent.createChooser(i, "Adjuntar archivo"), REQ_FILE);
                return true;
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
        }

        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                                      Message resultMsg) {
            return openPopup(resultMsg);
        }
    }

    /** Returns true when the URL was handled outside the WebView. */
    private boolean handleSpecialScheme(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        switch (scheme) {
            case "http":
            case "https":
            case "about":
            case "data":
            case "blob":
            case "javascript":
                return false;
            case "intent":
                try {
                    Intent intent = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME);
                    intent.addCategory(Intent.CATEGORY_BROWSABLE);
                    intent.setComponent(null);
                    intent.setSelector(null);
                    try {
                        startActivity(intent);
                    } catch (ActivityNotFoundException e) {
                        String fallback = intent.getStringExtra("browser_fallback_url");
                        if (fallback != null && web != null) web.loadUrl(fallback);
                    }
                } catch (Exception ignored) {
                    // Malformed intent URI.
                }
                return true;
            default:
                openExternal(uri);
                return true;
        }
    }

    private void openExternal(Uri uri) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, uri);
            i.addCategory(Intent.CATEGORY_BROWSABLE);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            Ui.toast(this, "No hay una app para abrir este enlace");
        }
    }

    static boolean isSignInHost(String host) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.ROOT);
        String[] domains = {"claude.ai", "claude.com", "anthropic.com", "google.com", "apple.com",
                "github.com", "stripe.com", "microsoftonline.com", "live.com", "okta.com", "auth0.com"};
        for (String d : domains) if (h.equals(d) || h.endsWith("." + d)) return true;
        return false;
    }

    /**
     * window.open / target=_blank: sign-in pop-ups (Google, Apple, SSO…) stay inside this
     * window so they share its cookies; any other link opens in the external browser.
     */
    private boolean openPopup(Message resultMsg) {
        closePopup();
        final WebView popup = new WebView(this);
        configure(popup);
        final boolean[] decided = {false};
        popup.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (handleSpecialScheme(request.getUrl())) return true;
                return decide(view, request.getUrl());
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                decide(view, Uri.parse(url));
            }

            private boolean decide(WebView view, Uri uri) {
                if (decided[0] || uri == null) return false;
                String scheme = uri.getScheme();
                if (scheme == null || "about".equals(scheme)) return false;
                decided[0] = true;
                if (isSignInHost(uri.getHost())) {
                    showPopup(view, uri.getHost());
                    return false;
                }
                openExternal(uri);
                main.post(() -> {
                    if (popupWeb == view) popupWeb = null;
                    view.stopLoading();
                    view.destroy();
                });
                return true;
            }
        });
        popup.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onCloseWindow(WebView window) {
                closePopup();
            }
        });
        popupWeb = popup;
        WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
        transport.setWebView(popup);
        resultMsg.sendToTarget();
        return true;
    }

    private void showPopup(WebView popup, String host) {
        if (popupDialog != null || popup != popupWeb) return;
        Dialog dialog = new Dialog(this, android.R.style.Theme_DeviceDefault_NoActionBar);
        LinearLayout box = Ui.vbox(this);
        box.setFitsSystemWindows(true);
        box.setBackgroundColor(Ui.color(this, R.color.surface));
        LinearLayout bar = Ui.hbox(this);
        bar.setPadding(Ui.dp(this, 12), Ui.dp(this, 4), Ui.dp(this, 4), Ui.dp(this, 4));
        TextView title = Ui.text(this, host == null ? "" : host, 14, R.color.text, true);
        bar.addView(title, Ui.weight(1));
        bar.addView(Ui.button(this, "Cerrar", Ui.Style.QUIET, v -> closePopup()));
        box.addView(bar, Ui.matchWrap());
        box.addView(popup, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        dialog.setContentView(box);
        dialog.setOnCancelListener(d -> closePopup());
        popupDialog = dialog;
        dialog.show();
    }

    private void closePopup() {
        Dialog d = popupDialog;
        WebView w = popupWeb;
        popupDialog = null;
        popupWeb = null;
        if (d != null) d.dismiss();
        if (w != null) {
            ViewGroup parent = (ViewGroup) w.getParent();
            if (parent != null) parent.removeView(w);
            w.destroy();
        }
    }

    // ------------------------------------------------------------------ session data

    private void clearSessionData(boolean close) {
        CookieManager cm = CookieManager.getInstance();
        cm.removeAllCookies(ok -> {
            cm.flush();
            WebStorage.getInstance().deleteAllData();
            WebViewDatabase.getInstance(this).clearHttpAuthUsernamePassword();
            if (close) {
                // A throwaway WebView clears the shared HTTP cache for this slot.
                WebView tmp = new WebView(this);
                tmp.clearCache(true);
                tmp.destroy();
                finishAndRemoveTask();
                return;
            }
            if (web != null) {
                web.clearCache(true);
                web.clearHistory();
                web.clearFormData();
                web.loadUrl(startUrl);
            }
            Ui.toast(this, "Sesión cerrada en esta ventana");
        });
    }

    // ------------------------------------------------------------------ downloads

    private void onDownload(String url, String userAgent, String contentDisposition,
                            String mimeType, long contentLength) {
        String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
        if (url.startsWith("blob:") || url.startsWith("data:")) {
            downloadRequestedAt = System.currentTimeMillis();
            web.evaluateJavascript(Js.fetchBlob(url, mimeType, name), null);
            return;
        }
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) req.addRequestHeader("Cookie", cookies);
            req.addRequestHeader("User-Agent", userAgent);
            req.setMimeType(mimeType);
            req.setTitle(name);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            dm.enqueue(req);
            Ui.toast(this, "Descargando " + name);
        } catch (Exception e) {
            openExternal(Uri.parse(url));
        }
    }

    /** Receives in-page (blob:) downloads; only honored right after the user started one. */
    private class Bridge {
        @JavascriptInterface
        public void saveDataUrl(String dataUrl, String mime, String fileName) {
            if (System.currentTimeMillis() - downloadRequestedAt > 60_000) return;
            downloadRequestedAt = 0;
            String result;
            try {
                int comma = dataUrl.indexOf(',');
                if (!dataUrl.startsWith("data:") || comma < 0) throw new IllegalArgumentException("formato");
                String meta = dataUrl.substring(5, comma);
                byte[] bytes = meta.endsWith(";base64")
                        ? Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT)
                        : Uri.decode(dataUrl.substring(comma + 1)).getBytes("UTF-8");
                String type = !TextUtils.isEmpty(mime) ? mime
                        : meta.replace(";base64", "").isEmpty() ? "application/octet-stream" : meta.replace(";base64", "");
                String name = safeName(fileName);
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                values.put(MediaStore.MediaColumns.MIME_TYPE, type);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Relevo");
                ContentResolver cr = getContentResolver();
                Uri target = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (target == null) throw new IllegalStateException("sin destino");
                try (OutputStream out = cr.openOutputStream(target)) {
                    if (out == null) throw new IllegalStateException("sin destino");
                    out.write(bytes);
                }
                result = "Guardado en Descargas/Relevo: " + name;
            } catch (Exception e) {
                result = "No se pudo guardar la descarga: " + e.getMessage();
            }
            final String msg = result;
            main.post(() -> Ui.toastLong(SessionActivity.this, msg));
        }

        @JavascriptInterface
        public void downloadFailed(String error) {
            main.post(() -> Ui.toastLong(SessionActivity.this, "No se pudo descargar: " + error));
        }
    }

    private static String safeName(String name) {
        String n = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").trim();
        if (n.isEmpty() || n.startsWith(".")) n = "descarga" + n;
        return n.length() > 120 ? n.substring(n.length() - 120) : n;
    }
}
