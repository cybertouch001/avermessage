package bot.tab.sites.avermessage;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.webkit.CookieManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Shared by the always-on InstantService and the 15-minute NotifyWorker fallback: the stored login token,
 * notification channels, and posting one Android notification per chat (grouped, tap opens that chat).
 * Everything here is defensive: a notification problem must never crash the app.
 */
final class AvmNotifier {
    static final String PREFS = AvmSecurePlugin.PREFS;
    static final String CH_MSG = "averchat_messages";
    static final String CH_CALL = "averchat_calls";
    static final String CH_SERVICE = "averchat_service";
    static final String GROUP = "averchat_msgs";
    static final int SUMMARY_ID = 7001;
    static final int CALL_ID = 99001;
    static final String EXTRA_CHAT = "avm_chat";

    private static final LinkedHashSet<String> seenIds = new LinkedHashSet<>();
    private static final Map<String, List<String>> lines = new HashMap<>();
    private static final Map<String, String> titles = new HashMap<>();

    private AvmNotifier() {}

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    static String server(Context c) { return c.getString(R.string.averchat_server); }

    // ---- the login (the same session cookie the WebView uses) ----
    /** Copy the WebView's session cookie into private storage so the background service can use it. Returns the token or null. */
    static String captureToken(Context c) {
        try {
            CookieManager cm = CookieManager.getInstance();
            String all = cm.getCookie(server(c));
            String tok = null;
            if (all != null) for (String part : all.split(";")) { String p = part.trim(); if (p.startsWith("avm_s=")) { String v = p.substring(6).trim(); if (v.length() > 0) tok = v; } }
            SharedPreferences.Editor e = prefs(c).edit();
            if (tok != null) e.putString("token", tok); else e.remove("token");
            e.apply();
            try { cm.flush(); } catch (Throwable ignored) {}
            return tok;
        } catch (Throwable t) {
            return prefs(c).getString("token", null); // WebView not available right now: keep what we had
        }
    }

    static String token(Context c) {
        String t = prefs(c).getString("token", null);
        if (t != null && t.length() > 0) return t;
        try { return captureToken(c); } catch (Throwable e) { return null; }
    }

    static void clearToken(Context c) { prefs(c).edit().remove("token").apply(); }

    static boolean instantEnabled(Context c) { return prefs(c).getBoolean("instant", true); }

    static boolean canPost(Context c) {
        try {
            if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;
            return NotificationManagerCompat.from(c).areNotificationsEnabled();
        } catch (Throwable t) { return false; }
    }

    static void ensureChannels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (nm.getNotificationChannel(CH_MSG) == null) {
                NotificationChannel ch = new NotificationChannel(CH_MSG, "Messages", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("New AverChat messages");
                nm.createNotificationChannel(ch);
            }
            if (nm.getNotificationChannel(CH_CALL) == null) {
                NotificationChannel ch = new NotificationChannel(CH_CALL, "Calls", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("Incoming AverChat calls");
                nm.createNotificationChannel(ch);
            }
            if (nm.getNotificationChannel(CH_SERVICE) == null) {
                NotificationChannel ch = new NotificationChannel(CH_SERVICE, "Background connection", NotificationManager.IMPORTANCE_MIN);
                ch.setDescription("The quiet \"AverChat connected\" notification that keeps instant messages working. You can turn this one off; messages still come.");
                ch.setShowBadge(false);
                ch.setSound(null, null);
                ch.enableVibration(false);
                nm.createNotificationChannel(ch);
            }
        } catch (Throwable ignored) {}
    }

    static PendingIntent openApp(Context c, String chatId) {
        Intent i = new Intent(c, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (chatId != null) { i.putExtra(EXTRA_CHAT, chatId); i.setAction("avm.open." + chatId); }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getActivity(c, chatId == null ? 0 : (chatId.hashCode() & 0x3fffffff), i, flags);
    }

    static int chatNotifId(String chatId) { return 10000 + ((chatId == null ? 0 : chatId.hashCode()) & 0x0fffffff); }

    /** True when this message id was not handled yet (by the service or the worker). */
    static synchronized boolean firstTime(String id) {
        if (id == null) return false;
        if (seenIds.contains(id)) return false;
        seenIds.add(id);
        while (seenIds.size() > 800) { Iterator<String> it = seenIds.iterator(); it.next(); it.remove(); }
        return true;
    }

    /** The app came to the front: the chats are on screen now, forget the per-chat lines we were stacking. */
    static synchronized void resetStacks(Context c) {
        lines.clear(); titles.clear();
    }

    /** Post notifications for the messages in a /api/notify answer (newest first) that were not shown yet. Returns how many were posted. */
    static synchronized int postMessages(Context c, JSONObject r) {
        int posted = 0;
        try {
            JSONArray msgs = r.optJSONArray("messages");
            if (msgs == null || msgs.length() == 0) return 0;
            String app = r.optString("app_name", "AverChat");
            if (app == null || app.isEmpty()) app = "AverChat";
            ensureChannels(c);
            boolean allowed = canPost(c);
            NotificationManagerCompat nm = NotificationManagerCompat.from(c);
            List<String> touched = new ArrayList<>();
            for (int i = msgs.length() - 1; i >= 0; i--) { // oldest first, so stacked lines read in order
                JSONObject m = msgs.optJSONObject(i); if (m == null) continue;
                String id = m.optString("id", null);
                if (!firstTime(id)) continue;
                String chat = m.optString("chat_id", "");
                if (chat.isEmpty()) continue;
                if (MainActivity.isChatVisible(chat)) continue;
                String text = m.optString("text", "New message");
                String line = m.optBoolean("group") ? m.optString("sender", "") + ": " + text : text;
                List<String> l = lines.get(chat); if (l == null) { l = new ArrayList<>(); lines.put(chat, l); }
                l.add(line); while (l.size() > 7) l.remove(0);
                titles.put(chat, m.optString("title", app));
                if (!touched.contains(chat)) touched.add(chat);
                posted++;
            }
            if (!allowed) return posted;
            for (String chat : touched) {
                List<String> l = lines.get(chat);
                String title = titles.get(chat);
                NotificationCompat.InboxStyle st = new NotificationCompat.InboxStyle();
                for (String s : l) st.addLine(s);
                if (l.size() > 1) st.setSummaryText(l.size() + " new messages");
                NotificationCompat.Builder b = new NotificationCompat.Builder(c, CH_MSG)
                    .setSmallIcon(R.drawable.ic_stat_avermessage)
                    .setContentTitle(title)
                    .setContentText(l.get(l.size() - 1))
                    .setStyle(st)
                    .setNumber(l.size())
                    .setAutoCancel(true)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                    .setDefaults(NotificationCompat.DEFAULT_ALL)
                    .setGroup(GROUP)
                    .setOnlyAlertOnce(false)
                    .setContentIntent(openApp(c, chat));
                try { nm.notify(chatNotifId(chat), b.build()); } catch (SecurityException ignored) {}
            }
            if (!touched.isEmpty() && Build.VERSION.SDK_INT >= 24) {
                NotificationCompat.Builder s = new NotificationCompat.Builder(c, CH_MSG)
                    .setSmallIcon(R.drawable.ic_stat_avermessage)
                    .setContentTitle(app)
                    .setContentText("New messages")
                    .setGroup(GROUP)
                    .setGroupSummary(true)
                    .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                    .setAutoCancel(true)
                    .setContentIntent(openApp(c, null));
                try { nm.notify(SUMMARY_ID, s.build()); } catch (SecurityException ignored) {}
            }
        } catch (Throwable ignored) {}
        return posted;
    }

    static void postCalls(Context c, JSONObject r) {
        try {
            JSONArray calls = r.optJSONArray("calls");
            if (calls == null || calls.length() == 0 || !canPost(c)) return;
            JSONObject call = calls.getJSONObject(0);
            if (!firstTime("call:" + call.optString("id"))) return;
            ensureChannels(c);
            boolean video = "video".equals(call.optString("kind"));
            NotificationCompat.Builder b = new NotificationCompat.Builder(c, CH_CALL)
                .setSmallIcon(R.drawable.ic_stat_avermessage)
                .setContentTitle(video ? "Incoming video call" : "Incoming voice call")
                .setContentText(call.optString("caller", "AverChat"))
                .setAutoCancel(true)
                .setTimeoutAfter(45000)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setDefaults(NotificationCompat.DEFAULT_ALL)
                .setContentIntent(openApp(c, null));
            try { NotificationManagerCompat.from(c).notify(CALL_ID, b.build()); } catch (SecurityException ignored) {}
        } catch (Throwable ignored) {}
    }

    static void cancelAll(Context c) {
        try { NotificationManagerCompat.from(c).cancelAll(); } catch (Throwable ignored) {}
        resetStacks(c);
    }
}
