package bot.tab.sites.avermessage;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

/** Battery-saver helpers. Every intent is checked and wrapped: on phones where a screen does not exist we fall back, never crash. */
final class AvmPower {
    private AvmPower() {}

    static String maker() { return Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase(java.util.Locale.ROOT); }

    static boolean ignoringBattery(Context c) {
        try {
            if (Build.VERSION.SDK_INT < 23) return true;
            PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName());
        } catch (Throwable t) { return false; }
    }

    /** Phones known to need an extra "Autostart" switch. */
    static boolean needsAutostart() {
        String m = maker();
        return m.contains("vivo") || m.contains("iqoo") || m.contains("xiaomi") || m.contains("redmi") || m.contains("poco")
            || m.contains("oppo") || m.contains("realme") || m.contains("oneplus") || m.contains("huawei") || m.contains("honor")
            || m.contains("letv") || m.contains("asus");
    }

    private static boolean tryStart(Context c, Intent i) {
        try {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i); // throws ActivityNotFoundException / SecurityException where the screen doesn't exist -> caught
            return true;
        } catch (Throwable t) { return false; }
    }

    /** Ask "Allow AverChat to run in background / unrestricted battery". Returns true if some settings screen opened. */
    static boolean openBattery(Context c) {
        if (Build.VERSION.SDK_INT >= 23) {
            if (!ignoringBattery(c) && tryStart(c, new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + c.getPackageName())))) return true;
            if (tryStart(c, new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))) return true;
        }
        return openAppDetails(c);
    }

    static boolean openAppDetails(Context c) {
        if (tryStart(c, new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + c.getPackageName())))) return true;
        return tryStart(c, new Intent(Settings.ACTION_SETTINGS));
    }

    private static Intent comp(String pkg, String cls) { return new Intent().setComponent(new ComponentName(pkg, cls)); }

    /** Try the maker's autostart / background-app screens; fall back to the app's own settings page. */
    static boolean openAutostart(Context c) {
        Intent[] tries = new Intent[] {
            // Vivo / iQOO (Funtouch / OriginOS)
            comp("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
            comp("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
            comp("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"),
            comp("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.PurviewTabActivity"),
            // Xiaomi / Redmi / POCO
            comp("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
            // Oppo / Realme / OnePlus (ColorOS)
            comp("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
            comp("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
            comp("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
            comp("com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity"),
            comp("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"),
            // Huawei / Honor
            comp("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
            comp("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"),
            // Asus, LeEco
            comp("com.asus.mobilemanager", "com.asus.mobilemanager.MainActivity"),
            comp("com.letv.android.letvsafe", "com.letv.android.letvsafe.AutobootManageActivity"),
        };
        for (Intent i : tries) {
            if (i.getComponent() == null) continue;
            if (tryStart(c, i)) return true;
        }
        return openAppDetails(c);
    }

    private static boolean installed(Context c, String pkg) {
        try { c.getPackageManager().getPackageInfo(pkg, 0); return true; } catch (PackageManager.NameNotFoundException e) { return false; } catch (Throwable t) { return false; }
    }
}
