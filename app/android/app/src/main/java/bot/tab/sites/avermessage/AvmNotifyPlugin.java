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
 *   setE2EKey({uid, pkcs8, pub})  keep the encryption key (Keystore-protected) so notifications can show encrypted text
 *   saveFile({name, mime, data})  save a decrypted file (base64) into Downloads/AverChat -> {where}
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
            AvmE2E.clear(getContext());
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

    @PluginMethod
    public void setE2EKey(PluginCall call) {
        AvmE2E.setKey(getContext(), call.getString("uid"), call.getString("pkcs8"));
        call.resolve();
    }

    @PluginMethod
    public void saveFile(PluginCall call) {
        try {
            String name = call.getString("name", "file"); String mime = call.getString("mime", "application/octet-stream");
            name = name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_"); if (name.isEmpty()) name = "file";
            byte[] data = android.util.Base64.decode(call.getString("data", ""), android.util.Base64.NO_WRAP);
            String where;
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                android.content.ContentValues v = new android.content.ContentValues();
                v.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS + "/AverChat");
                android.net.Uri u = getContext().getContentResolver().insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (u == null) throw new Exception("no uri");
                try (java.io.OutputStream o = getContext().getContentResolver().openOutputStream(u)) { o.write(data); }
                where = "Downloads/AverChat";
            } else {
                java.io.File dir = new java.io.File(getContext().getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS), "AverChat");
                dir.mkdirs(); java.io.File f = new java.io.File(dir, name);
                try (java.io.FileOutputStream o = new java.io.FileOutputStream(f)) { o.write(data); }
                where = f.getParent();
            }
            JSObject r = new JSObject(); r.put("where", where); call.resolve(r);
        } catch (Throwable t) { call.reject("Could not save the file"); }
    }
}
