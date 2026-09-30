package io.github.lancaster2995.relevo;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

/**
 * Everything the app persists: accounts (one per isolated browser slot), projects with their
 * handoff state and history, and a few settings. Serialized as a single JSON document by
 * {@link Store}, which every process (dashboard and each session window) reads and writes.
 */
public final class Data {

    public static final int MAX_SLOTS = 8;
    public static final int MAX_HISTORY = 120;

    public static final String URL_CHAT = "https://claude.ai/new";
    public static final String URL_CODE = "https://claude.ai/code";

    public final List<Account> accounts = new ArrayList<>();
    public final List<Project> projects = new ArrayList<>();

    /** Insert prompts straight into the chat box (true) or only copy them (false). */
    public boolean autoInsert = true;
    /** Session toolbar shows only the top row. */
    public boolean toolbarCollapsed = false;
    public boolean askedNotifications = false;

    // ---------------------------------------------------------------- accounts

    public static final class Account {
        public int slot;
        public String name = "";
        public String note = "";
        public String color = "#D97757";
        public String startUrl = URL_CHAT;
        public boolean desktopMode = false;
        public long pausedUntil;
        public long lastActive;
        public String activeProjectId = "";

        public boolean isPaused(long now) {
            return pausedUntil > now;
        }

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject();
            o.put("slot", slot);
            o.put("name", name);
            o.put("note", note);
            o.put("color", color);
            o.put("startUrl", startUrl);
            o.put("desktopMode", desktopMode);
            o.put("pausedUntil", pausedUntil);
            o.put("lastActive", lastActive);
            o.put("activeProjectId", activeProjectId);
            return o;
        }

        static Account fromJson(JSONObject o) {
            Account a = new Account();
            a.slot = o.optInt("slot");
            a.name = o.optString("name", "");
            a.note = o.optString("note", "");
            a.color = o.optString("color", "#D97757");
            a.startUrl = o.optString("startUrl", URL_CHAT);
            a.desktopMode = o.optBoolean("desktopMode", false);
            a.pausedUntil = o.optLong("pausedUntil");
            a.lastActive = o.optLong("lastActive");
            a.activeProjectId = o.optString("activeProjectId", "");
            return a;
        }
    }

    // ---------------------------------------------------------------- projects

    public static final class Event {
        public static final String CREATE = "create";
        public static final String CHECKPOINT = "checkpoint";
        public static final String TRANSFER = "transfer";
        public static final String EDIT = "edit";
        public static final String RESTORE = "restore";

        public long time;
        public String type = CHECKPOINT;
        public int slot;
        public int toSlot;
        public int progress = -1;
        public String accountName = "";
        public String toAccountName = "";
        public String text = "";

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject();
            o.put("time", time);
            o.put("type", type);
            o.put("slot", slot);
            o.put("toSlot", toSlot);
            o.put("progress", progress);
            o.put("accountName", accountName);
            o.put("toAccountName", toAccountName);
            o.put("text", text);
            return o;
        }

        static Event fromJson(JSONObject o) {
            Event e = new Event();
            e.time = o.optLong("time");
            e.type = o.optString("type", CHECKPOINT);
            e.slot = o.optInt("slot");
            e.toSlot = o.optInt("toSlot");
            e.progress = o.optInt("progress", -1);
            e.accountName = o.optString("accountName", "");
            e.toAccountName = o.optString("toAccountName", "");
            e.text = o.optString("text", "");
            return e;
        }
    }

    public static final class Project {
        public String id = UUID.randomUUID().toString();
        public String name = "";
        public String goal = "";
        public String repo = "";
        public String branch = "";
        public String notes = "";
        /** Latest state block (<<<ESTADO ... ESTADO>>>), empty until the first checkpoint. */
        public String state = "";
        public int progress;
        public int currentSlot;
        /** Slot whose window should offer the handoff prompt next; 0 when none is pending. */
        public int pendingSlot;
        public long stateTime;
        public long created;
        public long updated;
        public final List<Event> history = new ArrayList<>();

        public void addEvent(Event e) {
            history.add(e);
            while (history.size() > MAX_HISTORY) history.remove(0);
        }

        public boolean hasState() {
            return state != null && state.trim().length() > 0;
        }

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("name", name);
            o.put("goal", goal);
            o.put("repo", repo);
            o.put("branch", branch);
            o.put("notes", notes);
            o.put("state", state);
            o.put("progress", progress);
            o.put("currentSlot", currentSlot);
            o.put("pendingSlot", pendingSlot);
            o.put("stateTime", stateTime);
            o.put("created", created);
            o.put("updated", updated);
            JSONArray h = new JSONArray();
            for (Event e : history) h.put(e.toJson());
            o.put("history", h);
            return o;
        }

        static Project fromJson(JSONObject o) {
            Project p = new Project();
            p.id = o.optString("id", p.id);
            p.name = o.optString("name", "");
            p.goal = o.optString("goal", "");
            p.repo = o.optString("repo", "");
            p.branch = o.optString("branch", "");
            p.notes = o.optString("notes", "");
            p.state = o.optString("state", "");
            p.progress = o.optInt("progress");
            p.currentSlot = o.optInt("currentSlot");
            p.pendingSlot = o.optInt("pendingSlot");
            p.stateTime = o.optLong("stateTime");
            p.created = o.optLong("created");
            p.updated = o.optLong("updated");
            JSONArray h = o.optJSONArray("history");
            if (h != null) {
                for (int i = 0; i < h.length(); i++) {
                    JSONObject e = h.optJSONObject(i);
                    if (e != null) p.history.add(Event.fromJson(e));
                }
            }
            return p;
        }
    }

    // ---------------------------------------------------------------- lookups

    public Account account(int slot) {
        for (Account a : accounts) if (a.slot == slot) return a;
        return null;
    }

    public Project project(String id) {
        if (id == null || id.length() == 0) return null;
        for (Project p : projects) if (p.id.equals(id)) return p;
        return null;
    }

    public String accountName(int slot) {
        Account a = account(slot);
        return a != null ? a.name : (slot > 0 ? "Cuenta " + slot : "—");
    }

    /** Lowest slot number not used by any account, or 0 when all are taken. */
    public int freeSlot() {
        for (int s = 1; s <= MAX_SLOTS; s++) if (account(s) == null) return s;
        return 0;
    }

    public List<Account> sortedAccounts() {
        List<Account> list = new ArrayList<>(accounts);
        Collections.sort(list, (a, b) -> Integer.compare(a.slot, b.slot));
        return list;
    }

    public List<Project> sortedProjects() {
        List<Project> list = new ArrayList<>(projects);
        Collections.sort(list, (a, b) -> Long.compare(b.updated, a.updated));
        return list;
    }

    // ---------------------------------------------------------------- JSON

    public JSONObject toJson() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("version", 1);
        JSONArray acc = new JSONArray();
        for (Account a : accounts) acc.put(a.toJson());
        o.put("accounts", acc);
        JSONArray prj = new JSONArray();
        for (Project p : projects) prj.put(p.toJson());
        o.put("projects", prj);
        o.put("autoInsert", autoInsert);
        o.put("toolbarCollapsed", toolbarCollapsed);
        o.put("askedNotifications", askedNotifications);
        return o;
    }

    public static Data fromJson(JSONObject o) {
        Data d = new Data();
        if (o == null) return d;
        JSONArray acc = o.optJSONArray("accounts");
        if (acc != null) {
            for (int i = 0; i < acc.length(); i++) {
                JSONObject a = acc.optJSONObject(i);
                if (a == null) continue;
                Account account = Account.fromJson(a);
                if (account.slot >= 1 && account.slot <= MAX_SLOTS && d.account(account.slot) == null) {
                    d.accounts.add(account);
                }
            }
        }
        JSONArray prj = o.optJSONArray("projects");
        if (prj != null) {
            for (int i = 0; i < prj.length(); i++) {
                JSONObject p = prj.optJSONObject(i);
                if (p != null) d.projects.add(Project.fromJson(p));
            }
        }
        d.autoInsert = o.optBoolean("autoInsert", true);
        d.toolbarCollapsed = o.optBoolean("toolbarCollapsed", false);
        d.askedNotifications = o.optBoolean("askedNotifications", false);
        return d;
    }

    /** Default accent colors offered for new accounts. */
    public static final String[] COLORS = {
            "#D97757", "#4F7DF3", "#2DA44E", "#A259FF",
            "#E5A50A", "#E5484D", "#12A4B5", "#8B6E4E"
    };
}
