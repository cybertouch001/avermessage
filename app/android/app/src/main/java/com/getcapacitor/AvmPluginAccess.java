package com.getcapacitor;

/**
 * Lives in Capacitor's package so the app can ask whether the web page registered a listener on a plugin
 * (Plugin.hasListeners / notifyListeners are protected). Used by MainActivity's back-button handling.
 */
public final class AvmPluginAccess {
    private AvmPluginAccess() {}

    public static boolean hasListeners(Plugin plugin, String eventName) {
        return plugin != null && plugin.hasListeners(eventName);
    }

    public static void notifyListeners(Plugin plugin, String eventName, JSObject data, boolean retainUntilConsumed) {
        if (plugin != null) plugin.notifyListeners(eventName, data, retainUntilConsumed);
    }
}
