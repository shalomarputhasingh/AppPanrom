package com.apppanrom.shell;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

/**
 * Hosts the AppPanrom runtime in a WebView. App files are served from the APK's assets over a
 * virtual https origin (file:// access is disabled). A JavaScript-to-native bridge exists only for programs that use web
 * requests, location or notifications (see NativeBridge); other apps expose none.
 */
public class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private WebView web;
    private NativeBridge bridge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !request.getUrl().toString().startsWith(ORIGIN + "/assets/");
            }
        });
        if (getResources().getBoolean(R.bool.ap_net) || getResources().getBoolean(R.bool.ap_location) || getResources().getBoolean(R.bool.ap_notify)) {
            bridge = new NativeBridge(this, web);
            web.addJavascriptInterface(bridge, "ApNative");
        }
        web.loadUrl(ORIGIN + "/assets/www/index.html");
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (bridge != null) {
            bridge.onPermissionResult(requestCode, grantResults);
        }
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) {
            bridge.shutdown();
        }
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("window.__apBack ? window.__apBack() : false", value -> {
            if (!"true".equals(value)) {
                finish();
            }
        });
    }
}
