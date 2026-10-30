package bot.tab.sites.avermessage;

import android.Manifest;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.view.WindowManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.List;

/**
 * window.Capacitor.Plugins.AvmCall — native help for the web app's calls.
 *   setSpeaker({on})     route call audio to the loudspeaker (on) or earpiece / headset (off)
 *   setInCall({on})      on: keep the screen on, communication audio mode, audio focus, volume keys = call volume
 *                        off: everything back to normal
 *   vibrate({ms})        vibrate once (or {pattern:[wait,buzz,wait,buzz...], repeat:bool}); stopVibrate()
 *   getState()           {inCall, speaker, sdk, bluetoothPermission}
 *   checkPermissions() / requestPermissions({permissions:['bluetooth']})  (BLUETOOTH_CONNECT, Android 12+)
 */
@CapacitorPlugin(
    name = "AvmCall",
    permissions = { @Permission(alias = AvmCallPlugin.BLUETOOTH, strings = { Manifest.permission.BLUETOOTH_CONNECT }) }
)
public class AvmCallPlugin extends Plugin {

    static final String BLUETOOTH = "bluetooth";

    private boolean inCall = false;
    private boolean speaker = false;
    private AudioFocusRequest focusRequest;

    private AudioManager audio() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    private boolean needsBluetoothAsk() {
        return Build.VERSION.SDK_INT >= 31 && getPermissionState(BLUETOOTH) != PermissionState.GRANTED;
    }

    // ---- speaker ---------------------------------------------------------------------------------------------------

    @PluginMethod
    public void setSpeaker(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        try {
            applySpeaker(on);
            JSObject r = new JSObject();
            r.put("on", speaker);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("setSpeaker failed: " + e.getMessage());
        }
    }

    @SuppressWarnings("deprecation")
    private void applySpeaker(boolean on) {
        AudioManager am = audio();
        am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        if (Build.VERSION.SDK_INT >= 31) {
            List<AudioDeviceInfo> devices = am.getAvailableCommunicationDevices();
            AudioDeviceInfo pick = null;
            if (on) {
                pick = find(devices, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
            } else {
                // a headset wins over the earpiece
                int[] order = {
                    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
                    AudioDeviceInfo.TYPE_BLE_HEADSET,
                    AudioDeviceInfo.TYPE_WIRED_HEADSET,
                    AudioDeviceInfo.TYPE_USB_HEADSET,
                    AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
                    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                };
                for (int t : order) {
                    pick = find(devices, t);
                    if (pick != null) break;
                }
            }
            if (pick != null) {
                am.setCommunicationDevice(pick);
            } else if (!on) {
                am.clearCommunicationDevice();
            }
        } else {
            am.setSpeakerphoneOn(on);
        }
        speaker = on;
    }

    private static AudioDeviceInfo find(List<AudioDeviceInfo> devices, int type) {
        if (devices == null) return null;
        for (AudioDeviceInfo d : devices) if (d.getType() == type) return d;
        return null;
    }

    // ---- in call ---------------------------------------------------------------------------------------------------

    @PluginMethod
    public void setInCall(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        if (on && needsBluetoothAsk() && !Boolean.FALSE.equals(call.getBoolean("askBluetooth", true))) {
            // ask once for headset access (Android 12+); the call goes ahead whatever the answer
            requestPermissionForAlias(BLUETOOTH, call, "afterBluetooth");
            return;
        }
        doSetInCall(call, on);
    }

    @PermissionCallback
    private void afterBluetooth(PluginCall call) {
        doSetInCall(call, Boolean.TRUE.equals(call.getBoolean("on", true)));
    }

    @SuppressWarnings("deprecation")
    private void doSetInCall(PluginCall call, boolean on) {
        try {
            AudioManager am = audio();
            if (on) {
                am.setMode(AudioManager.MODE_IN_COMMUNICATION);
                requestFocus(am);
            } else {
                if (Build.VERSION.SDK_INT >= 31) {
                    am.clearCommunicationDevice();
                } else {
                    am.setSpeakerphoneOn(false);
                }
                am.setMode(AudioManager.MODE_NORMAL);
                abandonFocus(am);
                speaker = false;
            }
            inCall = on;
            getActivity().runOnUiThread(() -> {
                if (on) {
                    getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    getActivity().setVolumeControlStream(AudioManager.STREAM_VOICE_CALL);
                } else {
                    getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    getActivity().setVolumeControlStream(AudioManager.USE_DEFAULT_STREAM_TYPE);
                }
            });
            call.resolve(state());
        } catch (Exception e) {
            call.reject("setInCall failed: " + e.getMessage());
        }
    }

    @SuppressWarnings("deprecation")
    private void requestFocus(AudioManager am) {
        if (Build.VERSION.SDK_INT >= 26) {
            if (focusRequest == null) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(
                        new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build()
                    )
                    .setOnAudioFocusChangeListener(change -> {})
                    .build();
            }
            am.requestAudioFocus(focusRequest);
        } else {
            am.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
        }
    }

    @SuppressWarnings("deprecation")
    private void abandonFocus(AudioManager am) {
        if (Build.VERSION.SDK_INT >= 26) {
            if (focusRequest != null) am.abandonAudioFocusRequest(focusRequest);
        } else {
            am.abandonAudioFocus(null);
        }
    }

    // ---- vibration -------------------------------------------------------------------------------------------------

    @SuppressWarnings("deprecation")
    private Vibrator vibrator() {
        if (Build.VERSION.SDK_INT >= 31) {
            VibratorManager vm = (VibratorManager) getContext().getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            return vm != null ? vm.getDefaultVibrator() : null;
        }
        return (Vibrator) getContext().getSystemService(Context.VIBRATOR_SERVICE);
    }

    @PluginMethod
    @SuppressWarnings("deprecation")
    public void vibrate(PluginCall call) {
        try {
            Vibrator v = vibrator();
            if (v == null || !v.hasVibrator()) {
                call.resolve();
                return;
            }
            JSArray pattern = call.getArray("pattern", null);
            if (pattern != null && pattern.length() > 0) {
                long[] p = new long[pattern.length()];
                for (int i = 0; i < p.length; i++) p[i] = Math.max(0, Math.min(10000, pattern.getLong(i)));
                int repeat = Boolean.TRUE.equals(call.getBoolean("repeat", false)) ? 0 : -1;
                if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createWaveform(p, repeat));
                else v.vibrate(p, repeat);
            } else {
                long ms = Math.max(1, Math.min(10000, call.getInt("ms", 300)));
                if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
                else v.vibrate(ms);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("vibrate failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopVibrate(PluginCall call) {
        Vibrator v = vibrator();
        if (v != null) v.cancel();
        call.resolve();
    }

    // ---- state -----------------------------------------------------------------------------------------------------

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(state());
    }

    private JSObject state() {
        JSObject r = new JSObject();
        r.put("inCall", inCall);
        r.put("speaker", speaker);
        r.put("sdk", Build.VERSION.SDK_INT);
        r.put("bluetoothPermission", Build.VERSION.SDK_INT >= 31 ? getPermissionState(BLUETOOTH).toString() : "granted");
        return r;
    }

    @Override
    protected void handleOnDestroy() {
        try {
            if (inCall) {
                AudioManager am = audio();
                am.setMode(AudioManager.MODE_NORMAL);
                abandonFocus(am);
            }
        } catch (Exception ignored) {}
    }
}
