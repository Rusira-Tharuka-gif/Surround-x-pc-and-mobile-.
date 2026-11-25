package com.surroundx.studio;

import android.os.Bundle;
import android.webkit.DownloadListener;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(BackgroundConversionPlugin.class);
        super.onCreate(savedInstanceState);

        if (this.bridge != null) {
            WebView webView = this.bridge.getWebView();
            if (webView != null) {
                webView.setDownloadListener(new DownloadListener() {
                    @Override
                    public void onDownloadStart(
                        String url,
                        String userAgent,
                        String contentDisposition,
                        String mimetype,
                        long contentLength
                    ) {
                        if (url != null && url.startsWith("blob:")) {
                            webView.post(() ->
                                webView.evaluateJavascript(
                                    "window.dispatchEvent(new CustomEvent('surroundx-webview-download'));",
                                    null
                                )
                            );
                        }
                    }
                });
            }
        }
    }
}
