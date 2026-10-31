package bot.tab.sites.avermessage;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * window.Capacitor.Plugins.AvmNotify — the page's handle on "Instant notifications".
 *   refresh()            copy the login to native storage and (re)start the service if Instant is on -> state
 *   getState()           {instant, running, healthy, battery, notifications, autostart, maker}
 *   setInstant({on})     turn the always-on service on/off (stored on the phone)
 *   loggedOut()          forget the login, stop the service, clear notifications
 *   openSetup() / openBattery() / openAutostart()
 *   takePendingChat()    {chat} the chat a tapped notification asked to open (once)
 */
@CapacitorPlugin(name = "AvmNotify")
public class AvmNotifyPlugin extends Plugin {

    private JSObject state() {
        JSObject r = new JSObject();
        r.put("instant", AvmNotifier.instantEnabled(getContext()));
        r.put("running", InstantService.running);
        r.put("healthy", InstantService.healthy());
        r.put("battery", AvmPower.ignoringBattery(getContext()));
        r.put("notifications", AvmNotifier.canPost(getContext()));
        r.put("autostart", AvmPower.needsAutostart());
        r.put("maker", AvmPower.maker());
        return r;
    }

    @PluginMethod public void getState(PluginCall call) { call.resolve(state()); }

    @PluginMethod
    public void refresh(PluginCall call) {
        try {
            AvmNotifier.captureToken(getContext());
            InstantService.start(getContext());
        } catch (Throwable ignored) {}
        call.resolve(state());
    }

    @PluginMethod
    public void setInstant(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        try {
            AvmNotifier.prefs(getContext()).edit().putBoolean("instant", on).apply();
            if (on) { AvmNotifier.captureToken(getContext()); InstantService.start(getContext()); } else InstantService.stop(getContext());
        } catch (Throwable ignored) {}
        call.resolve(state());
    }

    @PluginMethod
    public void loggedOut(PluginCall call) {
        try {
            AvmNotifier.clearToken(getContext());
            InstantService.stop(getContext());
            AvmNotifier.cancelAll(getContext());
        } catch (Throwable ignored) {}
        call.resolve();
    }

    @PluginMethod
    public void openSetup(PluginCall call) {
        try { getActivity().startActivity(new Intent(getContext(), SetupActivity.class)); } catch (Throwable ignored) {}
        call.resolve();
    }

    @PluginMethod public void openBattery(PluginCall call) { JSObject r = new JSObject(); r.put("opened", AvmPower.openBattery(getContext())); call.resolve(r); }
    @PluginMethod public void openAutostart(PluginCall call) { JSObject r = new JSObject(); r.put("opened", AvmPower.openAutostart(getContext())); call.resolve(r); }

    @PluginMethod
    public void takePendingChat(PluginCall call) {
        JSObject r = new JSObject();
        String c = MainActivity.takePendingChat();
        if (c != null) r.put("chat", c);
        call.resolve(r);
    }
}
