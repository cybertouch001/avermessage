package bot.tab.sites.avermessage;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.interfaces.ECPrivateKey;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.KeyGenerator;
import javax.crypto.Mac;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * End-to-end encryption on the phone side (2.1.0): lets a notification show the real text of an encrypted message.
 * The page hands over the user's private key (setKey); it is kept in app-private storage, itself encrypted with an
 * AES key that lives in the Android Keystore. Same scheme as js/e2e.js: ECDH P-256 -> HKDF-SHA256 -> AES-256-GCM.
 * Anything that fails falls back to "New message" — a notification problem must never crash the app.
 */
final class AvmE2E {
    private static final String PREFS = "avm_e2e";
    private static final String ALIAS = "avm_e2e_wrap";
    private AvmE2E() {}

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    private static SecretKey wrapKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
        if (ks.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
        return kg.generateKey();
    }

    static void setKey(Context c, String uid, String pkcs8B64) {
        try {
            if (uid == null || pkcs8B64 == null) return;
            SharedPreferences.Editor e = prefs(c).edit().putString("uid", uid);
            if (Build.VERSION.SDK_INT >= 23) {
                Cipher ci = Cipher.getInstance("AES/GCM/NoPadding"); ci.init(Cipher.ENCRYPT_MODE, wrapKey());
                byte[] ct = ci.doFinal(pkcs8B64.getBytes(StandardCharsets.UTF_8));
                e.putString("iv", Base64.encodeToString(ci.getIV(), Base64.NO_WRAP)).putString("ct", Base64.encodeToString(ct, Base64.NO_WRAP)).remove("raw");
            } else {
                e.putString("raw", pkcs8B64); // Android 5 has no app Keystore AES; app-private storage only
            }
            e.apply();
            cached = null;
        } catch (Throwable ignored) {}
    }

    static void clear(Context c) { try { prefs(c).edit().clear().apply(); cached = null; } catch (Throwable ignored) {} }

    private static volatile Object[] cached; // {uid, PrivateKey}

    private static Object[] key(Context c) throws Exception {
        Object[] k = cached; if (k != null) return k;
        SharedPreferences p = prefs(c); String uid = p.getString("uid", null); if (uid == null) return null;
        String pk;
        if (p.contains("raw")) pk = p.getString("raw", null);
        else {
            String iv = p.getString("iv", null), ct = p.getString("ct", null); if (iv == null || ct == null) return null;
            Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
            ci.init(Cipher.DECRYPT_MODE, wrapKey(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            pk = new String(ci.doFinal(Base64.decode(ct, Base64.NO_WRAP)), StandardCharsets.UTF_8);
        }
        PrivateKey priv = KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(Base64.decode(pk, Base64.NO_WRAP)));
        k = new Object[] { uid, priv }; cached = k; return k;
    }

    private static byte[] hkdf(byte[] ikm, byte[] salt, byte[] info) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(salt, "HmacSHA256"));
        byte[] prk = mac.doFinal(ikm);
        mac.init(new SecretKeySpec(prk, "HmacSHA256")); mac.update(info); mac.update((byte) 1);
        return Arrays.copyOf(mac.doFinal(), 32);
    }

    private static byte[] gcm(byte[] key, byte[] iv, byte[] ct) throws Exception {
        Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
        ci.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        return ci.doFinal(ct);
    }

    /** Opens the payload sealed for this phone: e = {iv, ct, sk, k:[salt, wrapped], from}. Returns the payload JSON or null. */
    static JSONObject open(Context c, JSONObject e) {
        try {
            Object[] k = key(c); if (k == null || e == null) return null;
            String uid = (String) k[0]; ECPrivateKey priv = (ECPrivateKey) k[1];
            byte[] raw = Base64.decode(e.getString("sk"), Base64.NO_WRAP); if (raw.length != 65 || raw[0] != 4) return null;
            ECPoint pt = new ECPoint(new BigInteger(1, Arrays.copyOfRange(raw, 1, 33)), new BigInteger(1, Arrays.copyOfRange(raw, 33, 65)));
            PublicKey pub = KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(pt, priv.getParams()));
            KeyAgreement ka = KeyAgreement.getInstance("ECDH"); ka.init(priv); ka.doPhase(pub, true);
            byte[] shared = ka.generateSecret();
            JSONArray mine = e.getJSONArray("k");
            byte[] info = ("AverChat-E2E-v1|" + e.getString("from") + "|" + uid).getBytes(StandardCharsets.UTF_8);
            byte[] wk = hkdf(shared, Base64.decode(mine.getString(0), Base64.NO_WRAP), info);
            byte[] ck = gcm(wk, new byte[12], Base64.decode(mine.getString(1), Base64.NO_WRAP));
            byte[] pt2 = gcm(ck, Base64.decode(e.getString("iv"), Base64.NO_WRAP), Base64.decode(e.getString("ct"), Base64.NO_WRAP));
            return new JSONObject(new String(pt2, StandardCharsets.UTF_8));
        } catch (Throwable t) { return null; }
    }

    /** Notification line for one /api/notify message: the decrypted text when this phone can open it. */
    static String preview(Context c, JSONObject m, String fallback) {
        JSONObject e = m.optJSONObject("e2e"); if (e == null) return fallback;
        JSONObject p = open(c, e);
        if (p == null) return "\uD83D\uDD12 " + ("New message".equals(fallback) ? "New message" : fallback);
        String type = m.optString("type", "text"); String t = p.optString("t", "");
        if (t.length() > 160) t = t.substring(0, 160) + "…";
        if ("text".equals(type)) return t.isEmpty() ? fallback : t;
        JSONObject pm = p.optJSONObject("m");
        if ("location".equals(type) && pm != null && pm.optString("label", "").length() > 0) return "\uD83D\uDCCD " + pm.optString("label");
        if ("poll".equals(type) && pm != null && pm.optString("question", "").length() > 0) return "\uD83D\uDCCA " + pm.optString("question");
        if ("contact".equals(type) && pm != null && pm.optString("name", "").length() > 0) return "\uD83D\uDC64 " + pm.optString("name");
        if (("image".equals(type) || "video".equals(type)) && !t.isEmpty()) { String ic = "image".equals(type) ? "\uD83D\uDCF7 " : "\uD83C\uDFA5 "; return ic + t; }
        if ("file".equals(type)) { try { JSONArray f = p.getJSONObject("f").getJSONArray("main"); if (f.length() > 3) return "\uD83D\uDCC4 " + f.getString(3); } catch (Throwable ignored) {} }
        return fallback;
    }
}
