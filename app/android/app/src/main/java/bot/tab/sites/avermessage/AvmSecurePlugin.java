package bot.tab.sites.avermessage;

import android.content.Context;
import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * AvmSecure: the admin's "screenshots allowed" switch. secure=true sets FLAG_SECURE on the window (no screenshots,
 * no screen recording, blank preview in recent apps). The choice is remembered so the next cold start applies it
 * before the page even loads.
 */
@CapacitorPlugin(name = "AvmSecure")
public class AvmSecurePlugin extends Plugin {
    static final String PREFS = "averchat";

    static void apply(android.app.Activity a, boolean secure) {
        if (a == null) return;
        if (secure) a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    static boolean saved(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("secure", false);
    }

    static void save(Context c, boolean secure) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("secure", secure).apply();
    }

    @PluginMethod
    public void set(PluginCall call) {
        final boolean secure = Boolean.TRUE.equals(call.getBoolean("secure", false));
        save(getContext(), secure);
        getActivity().runOnUiThread(() -> {
            apply(getActivity(), secure);
            JSObject r = new JSObject();
            r.put("secure", secure);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void get(PluginCall call) {
        JSObject r = new JSObject();
        r.put("secure", saved(getContext()));
        call.resolve(r);
    }
}
