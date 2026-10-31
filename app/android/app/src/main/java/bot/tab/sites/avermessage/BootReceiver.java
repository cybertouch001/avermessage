package bot.tab.sites.avermessage;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Phone restarted or the app was updated: bring the instant-notification service back (if it is on and someone is logged in). */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        try {
            String a = intent == null ? null : intent.getAction();
            if (a == null) return;
            if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)
                || "android.intent.action.QUICKBOOT_POWERON".equals(a) || "com.htc.intent.action.QUICKBOOT_POWERON".equals(a)) {
                AvmNotifier.ensureChannels(c);
                InstantService.start(c);
                NotifyWorker.schedule(c);
            }
        } catch (Throwable ignored) {}
    }
}
