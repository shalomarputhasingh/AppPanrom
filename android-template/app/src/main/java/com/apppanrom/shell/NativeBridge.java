package com.apppanrom.shell;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The only JavaScript-to-native bridge, registered as "ApNative" and ONLY when the program uses a feature that needs it
 * (web requests, location, notifications): see res/values/features.xml, written by the project generator. Each method also
 * checks its own flag there, so an app that only makes web requests cannot read the location, and so on.
 *
 * Runtime permissions (location, notifications on Android 13+) are requested here, at the moment the program asks for the
 * feature; "no" is reported to the program as a normal answer. Nothing is requested at install or start-up.
 *
 * It implements the same rules as the Studio's proxy (backend/apppanrom/proxy.py): https only, no credentials in the URL,
 * every resolved address must be public, redirects are never followed, no cookies / custom headers, request body
 * <= 64 KB, response <= 256 KB of JSON or text, 15 s limit. One difference, stated honestly: the connection is made by
 * host name after the address check, so a DNS answer that changes in between is not pinned the way the Studio pins it.
 */
final class NativeBridge {
    private static final int MAX_URL = 2048;
    private static final int MAX_BODY = 64_000;
    private static final int MAX_RESPONSE = 256_000;

    private static final int REQ_LOCATION = 4101;
    private static final int REQ_NOTIFY = 4102;
    private static final long LOCATION_TIMEOUT_MS = 25_000;

    private final Activity activity;
    private final WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private String locationId;          // request waiting for a permission answer or a fix (main thread only)
    private boolean locationDone;
    private int locationSeq;           // tells a late timeout / fix of an old request apart from the current one
    private String notifyId, notifyTitle, notifyText;
    private int notifyCounter = 1;

    NativeBridge(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
    }

    private boolean enabled(int flag) {
        return activity.getResources().getBoolean(flag);
    }

    private static boolean validId(String id) {
        return id != null && id.matches("r[0-9]{1,15}");
    }

    void shutdown() {
        pool.shutdownNow();
    }

    @JavascriptInterface
    public void http(final String id, final String method, final String url, final String body) {
        if (!validId(id) || !enabled(R.bool.ap_net)) {
            return;
        }
        try {
            pool.execute(() -> reply(id, run(method, url, body)));
        } catch (RuntimeException e) {
            reply(id, result(0, "", "The request could not be started."));
        }
    }

    // ------------------------------------------------------------------ location_edu

    @JavascriptInterface
    public void location(final String id) {
        if (!validId(id) || !enabled(R.bool.ap_location)) {
            return;
        }
        main.post(() -> startLocation(id));
    }

    private boolean hasLocationPermission() {
        return activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || activity.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void startLocation(String id) {
        if (locationId != null) {
            reply(id, locationResult(0, 0, 0, false, "A location request is already running."));
            return;
        }
        locationId = id;
        locationDone = false;
        locationSeq++;
        if (hasLocationPermission()) {
            readLocation();
        } else {
            activity.requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
        }
    }

    private void finishLocation(JSONObject res) {
        if (locationId == null || locationDone) {
            return;
        }
        locationDone = true;
        String id = locationId;
        locationId = null;
        reply(id, res);
    }

    private static JSONObject locationResult(double lat, double lon, double accuracy, boolean denied, String error) {
        JSONObject o = new JSONObject();
        try {
            o.put("lat", lat);
            o.put("lon", lon);
            o.put("accuracy", accuracy);
            o.put("denied", denied);
            o.put("error", error);
        } catch (org.json.JSONException ignored) {
            // plain numbers and strings: cannot happen
        }
        return o;
    }

    private void locationFound(int seq, Location l) {
        if (seq != locationSeq) {
            return;
        }
        if (l == null) {
            finishLocation(locationResult(0, 0, 0, false, "The phone could not find its location."));
        } else {
            finishLocation(locationResult(l.getLatitude(), l.getLongitude(), l.hasAccuracy() ? l.getAccuracy() : 0, false, ""));
        }
    }

    @SuppressWarnings({"deprecation", "MissingPermission"})
    private void readLocation() {
        try {
            final LocationManager lm = (LocationManager) activity.getSystemService(Context.LOCATION_SERVICE);
            boolean fine = activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
            String provider = null;
            if (fine && lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                provider = LocationManager.GPS_PROVIDER;
            } else if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                provider = LocationManager.NETWORK_PROVIDER;
            }
            if (provider == null) {
                finishLocation(locationResult(0, 0, 0, false, "Location is switched off on this phone."));
                return;
            }
            final int seq = locationSeq;
            main.postDelayed(() -> {
                if (seq == locationSeq) {
                    finishLocation(locationResult(0, 0, 0, false, "The location request timed out."));
                }
            }, LOCATION_TIMEOUT_MS);
            if (Build.VERSION.SDK_INT >= 30) {
                lm.getCurrentLocation(provider, null, activity.getMainExecutor(), l -> locationFound(seq, l));
            } else {
                lm.requestSingleUpdate(provider, new LocationListener() {
                    @Override public void onLocationChanged(Location l) { locationFound(seq, l); }
                    @Override public void onStatusChanged(String p, int status, Bundle extras) { }
                    @Override public void onProviderEnabled(String p) { }
                    @Override public void onProviderDisabled(String p) { }
                }, Looper.getMainLooper());
            }
        } catch (SecurityException e) {
            finishLocation(locationResult(0, 0, 0, true, ""));
        } catch (RuntimeException e) {
            finishLocation(locationResult(0, 0, 0, false, "The location could not be read."));
        }
    }

    // ------------------------------------------------------------------ notification_kaattu

    @JavascriptInterface
    public void notification(final String id, final String title, final String text) {
        if (!validId(id) || !enabled(R.bool.ap_notify)) {
            return;
        }
        if (title == null || text == null || title.trim().isEmpty() || title.length() > 100 || text.length() > 500) {
            reply(id, result(0, "", "The notification title or text is not valid."));
            return;
        }
        main.post(() -> startNotification(id, title, text));
    }

    private void startNotification(String id, String title, String text) {
        if (Build.VERSION.SDK_INT >= 33
                && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            if (notifyId != null) {
                reply(id, result(0, "", "A notification permission question is already open."));
                return;
            }
            notifyId = id;
            notifyTitle = title;
            notifyText = text;
            activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
            return;
        }
        showNotification(id, title, text);
    }

    private void showNotification(String id, String title, String text) {
        try {
            NotificationManager nm = (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null || !nm.areNotificationsEnabled()) {
                reply(id, result(0, "", "Notifications are turned off for this app in the phone's settings."));
                return;
            }
            Notification.Builder b;
            if (Build.VERSION.SDK_INT >= 26) {
                nm.createNotificationChannel(new NotificationChannel("apppanrom_default", "App notifications", NotificationManager.IMPORTANCE_DEFAULT));
                b = new Notification.Builder(activity, "apppanrom_default");
            } else {
                b = new Notification.Builder(activity);
            }
            Intent open = new Intent(activity, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pi = PendingIntent.getActivity(activity, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            b.setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(title).setContentText(text).setContentIntent(pi).setAutoCancel(true);
            nm.notify(notifyCounter++ % 50, b.build());
            reply(id, result(200, "", ""));
        } catch (RuntimeException e) {
            reply(id, result(0, "", "The notification could not be shown."));
        }
    }

    /** Called by MainActivity with the user's answer to a permission question asked by this bridge. */
    void onPermissionResult(int requestCode, int[] grants) {
        boolean granted = grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED;
        if (requestCode == REQ_LOCATION) {
            if (hasLocationPermission()) {
                readLocation();
            } else {
                finishLocation(locationResult(0, 0, 0, true, ""));
            }
        } else if (requestCode == REQ_NOTIFY && notifyId != null) {
            String id = notifyId, title = notifyTitle, text = notifyText;
            notifyId = notifyTitle = notifyText = null;
            if (granted) {
                showNotification(id, title, text);
            } else {
                reply(id, result(0, "", "Notifications were not allowed."));
            }
        }
    }

    private void reply(String id, JSONObject res) {
        final String js = "window.__apNativeDone(" + JSONObject.quote(id) + "," + JSONObject.quote(res.toString()) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    private static JSONObject result(int status, String text, String error) {
        JSONObject o = new JSONObject();
        try {
            o.put("status", status);
            o.put("text", text);
            o.put("error", error);
        } catch (org.json.JSONException ignored) {
            // keys and values are plain strings/ints: cannot happen
        }
        return o;
    }

    private static JSONObject run(String method, String url, String body) {
        return fetch(method, url, body);
    }

    private static JSONObject fetch(String method, String url, String body) {
        try {
            if (method == null || !(method.equals("GET") || method.equals("POST") || method.equals("PUT") || method.equals("DELETE"))) {
                return result(0, "", "Unsupported request method.");
            }
            if ((method.equals("GET") || method.equals("DELETE")) && body != null) {
                return result(0, "", method + " requests cannot have a body.");
            }
            if (body != null && body.getBytes(StandardCharsets.UTF_8).length > MAX_BODY) {
                return result(0, "", "The request body is too large.");
            }
            String bad = checkUrl(url);
            if (bad != null) {
                return result(0, "", bad);
            }
            URL u = new URL(url);
            InetAddress[] addrs;
            try {
                addrs = InetAddress.getAllByName(u.getHost());
            } catch (IOException e) {
                return result(0, "", "The host name could not be found.");
            }
            for (InetAddress a : addrs) {
                if (!isPublic(a)) {
                    return result(0, "", "That address is not on the public internet, so the request was blocked.");
                }
            }
            HttpURLConnection c = (HttpURLConnection) u.openConnection();
            try {
                c.setInstanceFollowRedirects(false);
                c.setUseCaches(false);
                c.setConnectTimeout(8000);
                c.setReadTimeout(10000);
                c.setRequestMethod(method);
                c.setRequestProperty("User-Agent", "AppPanrom/1");
                c.setRequestProperty("Accept", "application/json, text/plain;q=0.9, */*;q=0.1");
                if (body != null) {
                    c.setRequestProperty("Content-Type", "application/json");
                    c.setDoOutput(true);
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    c.setFixedLengthStreamingMode(bytes.length);
                    c.getOutputStream().write(bytes);
                }
                int status = c.getResponseCode();
                String ctype = c.getContentType() == null ? "" : c.getContentType().split(";")[0].trim().toLowerCase(Locale.ROOT);
                InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                byte[] raw = in == null ? new byte[0] : readCapped(in);
                if (raw == null) {
                    return result(0, "", "The response is too large (more than 256 KB).");
                }
                boolean textual = ctype.isEmpty() || ctype.startsWith("text/") || ctype.endsWith("json") || ctype.equals("application/xml");
                if (raw.length > 0 && !textual) {
                    return result(0, "", "The response type is not supported; only JSON and text.");
                }
                return result(status, new String(raw, StandardCharsets.UTF_8), "");
            } finally {
                c.disconnect();
            }
        } catch (javax.net.ssl.SSLException e) {
            return result(0, "", "The server's certificate could not be verified.");
        } catch (java.net.SocketTimeoutException e) {
            return result(0, "", "The request timed out.");
        } catch (IOException | RuntimeException e) {
            return result(0, "", "The request failed (could not connect or the connection broke).");
        }
    }

    /** Returns null when the response is larger than the limit. */
    private static byte[] readCapped(InputStream in) throws IOException {
        try (InputStream src = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = src.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > MAX_RESPONSE) {
                    return null;
                }
            }
            return out.toByteArray();
        }
    }

    /** Returns an error message, or null when the URL is acceptable. */
    static String checkUrl(String url) {
        if (url == null || url.isEmpty() || url.length() > MAX_URL) {
            return "The URL is empty or too long.";
        }
        for (int i = 0; i < url.length(); i++) {
            char ch = url.charAt(i);
            if (ch <= ' ' || ch == 0x7f) {
                return "The URL contains spaces or control characters.";
            }
        }
        URI uri;
        try {
            uri = new URI(url);
        } catch (java.net.URISyntaxException e) {
            return "The URL is not valid.";
        }
        if (uri.getScheme() == null || !uri.getScheme().equalsIgnoreCase("https")) {
            return "Only https:// URLs are allowed.";
        }
        if (uri.getHost() == null || uri.getHost().isEmpty()) {
            return "The URL has no host name.";
        }
        if (uri.getRawUserInfo() != null) {
            return "User names and passwords in URLs are not allowed.";
        }
        if (uri.getRawFragment() != null) {
            return "The URL must not contain a #fragment.";
        }
        return null;
    }

    static boolean isPublic(InetAddress a) {
        if (a.isAnyLocalAddress() || a.isLoopbackAddress() || a.isLinkLocalAddress() || a.isSiteLocalAddress() || a.isMulticastAddress()) {
            return false;
        }
        byte[] b = a.getAddress();
        if (b.length == 4) {
            int b0 = b[0] & 255, b1 = b[1] & 255, b2 = b[2] & 255;
            if (b0 == 0 || b0 >= 240) return false;                                   // "this" network, reserved, broadcast
            if (b0 == 100 && (b1 & 0xC0) == 64) return false;                        // 100.64.0.0/10 carrier-grade NAT
            if (b0 == 192 && b1 == 0 && (b2 == 0 || b2 == 2)) return false;          // 192.0.0.0/24, documentation
            if (b0 == 198 && (b1 == 18 || b1 == 19)) return false;                   // benchmarking
            if (b0 == 198 && b1 == 51 && b2 == 100) return false;                    // documentation
            if (b0 == 203 && b1 == 0 && b2 == 113) return false;                     // documentation
        } else if (b.length == 16) {
            if ((b[0] & 0xFE) == 0xFC) return false;                                  // fc00::/7 unique local
            if (b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x0d && b[3] == (byte) 0xb8) return false; // documentation
        }
        return true;
    }
}
