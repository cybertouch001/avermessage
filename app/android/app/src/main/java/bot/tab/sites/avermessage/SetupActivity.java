package bot.tab.sites.avermessage;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

/**
 * One-time (and re-openable from Settings > Notifications) screen in simple Hinglish: notification permission,
 * unrestricted battery, and autostart on Vivo / Xiaomi / Oppo-type phones. Built in code with plain widgets and no icons
 * (nothing here can fail to load), every action wrapped so a missing settings screen can never crash the app.
 */
public class SetupActivity extends Activity {
    static final String DONE_KEY = "setup_v3_done";
    private TextView notifState, batteryState, autoState;
    private Button notifBtn;
    private LinearLayout notifCard;
    private boolean autostartTapped = false;

    private int dp(int v) { return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()); }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try { AvmNotifier.prefs(this).edit().putBoolean(DONE_KEY, true).apply(); } catch (Throwable ignored) {}
        try { setContentView(build()); }
        catch (Throwable t) { finish(); } // never block the app because of this screen
    }

    private TextView text(String s, int sp, boolean bold, int color) {
        TextView t = new TextView(this);
        t.setText(s); t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp); t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setLineSpacing(0, 1.15f);
        return t;
    }

    private Button button(String s, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(s); b.setAllCaps(false); b.setTextColor(Color.WHITE); b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        GradientDrawable bg = new GradientDrawable(); bg.setColor(Color.parseColor("#1E88E5")); bg.setCornerRadius(dp(24));
        b.setBackground(bg);
        b.setPadding(dp(16), dp(10), dp(16), dp(10));
        b.setOnClickListener(v -> { try { l.onClick(v); } catch (Throwable t) { toast("Ye screen is phone pe nahi khuli. Settings > Apps > AverChat mein dekho."); } });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48));
        lp.topMargin = dp(10); b.setLayoutParams(lp);
        return b;
    }

    private LinearLayout card(LinearLayout parent) {
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        c.setPadding(dp(16), dp(14), dp(16), dp(14));
        GradientDrawable bg = new GradientDrawable(); bg.setColor(Color.parseColor("#F1F5FA")); bg.setCornerRadius(dp(16));
        c.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(14); c.setLayoutParams(lp);
        parent.addView(c);
        return c;
    }

    private View build() {
        int dark = Color.parseColor("#14202E"), grey = Color.parseColor("#4A5868"), ok = Color.parseColor("#2E7D32");
        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(Color.WHITE);
        sv.setFillViewport(true);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(22), dp(36), dp(22), dp(28));
        sv.addView(root);

        root.addView(text("Turant notification chalu karein", 24, true, dark));
        TextView sub = text("Message aate hi notification aaye, chahe AverChat band ho. Iske liye bas ye kaam ek baar karne hain:", 16, false, grey);
        sub.setPadding(0, dp(8), 0, 0);
        root.addView(sub);

        int n = 1;
        notifCard = card(root);
        notifCard.addView(text(n + ". Notification ki permission do", 18, true, dark));
        notifCard.addView(text("Bina iske koi notification nahi dikhega.", 15, false, grey));
        notifState = text("", 15, true, ok); notifCard.addView(notifState);
        notifBtn = button("Allow karo", v -> askNotif());
        notifCard.addView(notifBtn);
        if (Build.VERSION.SDK_INT < 33) notifCard.setVisibility(View.GONE); else n++;

        LinearLayout bc = card(root);
        bc.addView(text(n + ". Battery: \"Unrestricted\" / \"Allow\" chuno", 18, true, dark));
        bc.addView(text("Vivo, Moto jaise phone battery bachane ke liye apps ko band kar dete hain. Allow karne se messages turant aayenge.", 15, false, grey));
        batteryState = text("", 15, true, ok); bc.addView(batteryState);
        bc.addView(button("Battery allow karo", v -> { if (!AvmPower.openBattery(this)) toast("Settings > Apps > AverChat > Battery mein \"Unrestricted\" chuno."); }));
        n++;

        if (AvmPower.needsAutostart() || getIntent().getBooleanExtra("avm_show_autostart", false)) {
            LinearLayout ac = card(root);
            ac.addView(text(n + ". Autostart ON karo", 18, true, dark));
            ac.addView(text("Jo screen khulegi usme AverChat ke aage switch ON kar do. Agar wo screen na khule: App info > Battery > \"Allow background activity\" ON karo.", 15, false, grey));
            autoState = text("", 15, true, ok); ac.addView(autoState);
            ac.addView(button("Autostart kholo", v -> { autostartTapped = true; if (!AvmPower.openAutostart(this)) toast("Settings > Apps > AverChat mein Autostart / Background ON karo."); }));
        }

        LinearLayout sc = card(root);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL); row.setGravity(Gravity.CENTER_VERTICAL);
        TextView lab = text("Instant notifications", 18, true, dark);
        row.addView(lab, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Switch sw = new Switch(this);
        sw.setChecked(AvmNotifier.instantEnabled(this));
        sw.setOnCheckedChangeListener((CompoundButton b, boolean on) -> {
            try {
                AvmNotifier.prefs(this).edit().putBoolean("instant", on).apply();
                if (on) InstantService.start(this); else InstantService.stop(this);
            } catch (Throwable ignored) {}
        });
        row.addView(sw);
        sc.addView(row);
        sc.addView(text("Upar ek chhota \"AverChat connected\" notification rahega. Use phone settings se chhupa sakte ho, messages phir bhi aayenge. Ise band karoge to notification 15 min tak late aa sakte hain.", 14, false, grey));

        Button done = button("Ho gaya", v -> finish());
        ((LinearLayout.LayoutParams) done.getLayoutParams()).topMargin = dp(22);
        root.addView(done);
        TextView later = text("Baad mein: Me > Notifications > Battery settings", 13, false, grey);
        later.setGravity(Gravity.CENTER); later.setPadding(0, dp(12), 0, 0);
        root.addView(later);
        refresh();
        return sv;
    }

    private void askNotif() {
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 41);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        try {
            refresh();
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                toast("Notification band hai. Settings > Apps > AverChat > Notifications ON karo.");
        } catch (Throwable ignored) {}
    }

    @Override
    protected void onResume() {
        super.onResume();
        try { refresh(); InstantService.start(this); } catch (Throwable ignored) {}
    }

    private void refresh() {
        try {
            if (notifState != null) {
                boolean g = AvmNotifier.canPost(this);
                notifState.setText(g ? "✅ Ho gaya" : "");
                notifState.setVisibility(g ? View.VISIBLE : View.GONE);
                if (notifBtn != null) notifBtn.setVisibility(g ? View.GONE : View.VISIBLE);
            }
            if (batteryState != null) {
                boolean g = AvmPower.ignoringBattery(this);
                batteryState.setText(g ? "✅ Ho gaya" : "");
                batteryState.setVisibility(g ? View.VISIBLE : View.GONE);
            }
            if (autoState != null) {
                autoState.setText(autostartTapped ? "Switch ON kiya? Tab theek hai 👍" : "");
                autoState.setVisibility(autostartTapped ? View.VISIBLE : View.GONE);
            }
        } catch (Throwable ignored) {}
    }

    private void toast(String s) { try { Toast.makeText(this, s, Toast.LENGTH_LONG).show(); } catch (Throwable ignored) {} }
}
