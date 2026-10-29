package br.com.chatmarks.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.net.http.SslError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.util.Collections;

/** Thin TLS-only companion for the opt-in authenticated desktop mobile panel. */
public final class MainActivity extends Activity {
    private WebView web;
    private TextView status;
    private String origin;
    private static String validate(String raw) {
        try {
            URI uri = new URI(raw.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                    || uri.getRawUserInfo() != null || uri.getRawQuery() != null
                    || uri.getRawFragment() != null || uri.getPort() == 0 || uri.getPort() > 65535
                    || !(uri.getRawPath() == null || uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath()))) return null;
            if ("127.0.0.1".equals(uri.getHost()) || "localhost".equalsIgnoreCase(uri.getHost()) || "::1".equals(uri.getHost())) return null;
            return new URI("https", null, uri.getHost(), uri.getPort(), null, null, null).toASCIIString();
        } catch (Exception e) { return null; }
    }
    private boolean allowed(String address) {
        try {
            if (origin == null) return false;
            URI a = new URI(origin), b = new URI(address);
            return "https".equalsIgnoreCase(b.getScheme()) && a.getHost().equalsIgnoreCase(b.getHost())
                && (a.getPort() < 0 ? 443 : a.getPort()) == (b.getPort() < 0 ? 443 : b.getPort())
                && b.getRawUserInfo() == null && b.getRawFragment() == null;
        } catch (Exception e) { return false; }
    }
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        status = new TextView(this);
        status.setText("Chat Marks · painel seguro do computador");
        status.setPadding(20, 15, 20, 15);
        Button connect = new Button(this);
        connect.setText("Conectar ao computador");
        connect.setOnClickListener(v -> configure());
        Button disconnect = new Button(this);
        disconnect.setText("Desconectar");
        disconnect.setOnClickListener(v -> disconnect());
        web = new WebView(this);
        web.setVisibility(WebView.GONE);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        WebView.setWebContentsDebuggingEnabled(false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !allowed(request.getUrl().toString());
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (!allowed(request.getUrl().toString())) {
                    return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
                }
                return super.shouldInterceptRequest(view, request);
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                status.setText("Certificado TLS inválido. Configure uma CA confiável no Android.");
            }
        });
        layout.addView(status);
        layout.addView(connect);
        layout.addView(disconnect);
        layout.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(layout);
    }
    private void configure() {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint("https://IP-DO-PC:17893/");
        input.setText(getPreferences(MODE_PRIVATE).getString("origin", ""));
        new AlertDialog.Builder(this).setTitle("Chat Marks · conexão HTTPS")
            .setMessage("Configure o painel TLS no computador; o token é informado somente na página e não fica salvo no aplicativo.")
            .setView(input).setNegativeButton("Cancelar", (dialog, button) -> {})
            .setPositiveButton("Conectar", (dialog, button) -> {
                String checked = validate(input.getText().toString());
                if (checked == null) { status.setText("Endereço HTTPS inválido."); return; }
                disconnect();
                origin = checked;
                getPreferences(MODE_PRIVATE).edit().putString("origin", checked).apply();
                web.setVisibility(WebView.VISIBLE);
                status.setText("Conectado a " + checked + " · autenticação no painel");
                web.loadUrl(checked + "/");
            }).show();
    }
    private void disconnect() {
        origin = null;
        web.loadUrl("about:blank");
        web.clearHistory();
        web.clearCache(true);
        web.setVisibility(WebView.GONE);
        CookieManager.getInstance().removeAllCookies(null);
        status.setText("Desconectado. Digite novamente o token em cada sessão.");
    }
    @Override protected void onDestroy() {
        disconnect();
        web.destroy();
        super.onDestroy();
    }
}
