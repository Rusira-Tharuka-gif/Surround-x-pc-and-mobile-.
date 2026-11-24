package com.surroundx.studio;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "BackgroundConversion",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class BackgroundConversionPlugin extends Plugin {

    @PluginMethod
    public void ensureNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            JSObject res = new JSObject();
            res.put("granted", true);
            call.resolve(res);
            return;
        }

        if (getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject res = new JSObject();
            res.put("granted", true);
            call.resolve(res);
            return;
        }

        requestPermissionForAlias("notifications", call, "notificationsPermsCallback");
    }

    @PermissionCallback
    private void notificationsPermsCallback(PluginCall call) {
        if (call == null) return;
        boolean granted = getPermissionState("notifications") == PermissionState.GRANTED;
        JSObject res = new JSObject();
        res.put("granted", granted);
        call.resolve(res);
    }

    @PluginMethod
    public void startConversion(PluginCall call) {
        Context context = getContext();
        if (context == null) {
            call.resolve();
            return;
        }

        Intent intent = new Intent(context, BackgroundConversionService.class);
        intent.setAction(BackgroundConversionService.ACTION_START);
        intent.putExtra(BackgroundConversionService.EXTRA_JOB_ID, call.getString("jobId", ""));
        intent.putExtra(BackgroundConversionService.EXTRA_FILENAME, call.getString("filename", "Audio Track"));
        intent.putExtra(
            BackgroundConversionService.EXTRA_PHASE_LABEL,
            call.getString("phaseLabel", "Converting in background...")
        );
        intent.putExtra(BackgroundConversionService.EXTRA_PROGRESS, call.getInt("progress", 0));

        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (Exception ignored) {
            // Keep JS conversion running cleanly even if OEM restricts background service start
        }
        call.resolve();
    }

    @PluginMethod
    public void updateProgress(PluginCall call) {
        Context context = getContext();
        if (context == null) {
            call.resolve();
            return;
        }

        Intent intent = new Intent(context, BackgroundConversionService.class);
        intent.setAction(BackgroundConversionService.ACTION_UPDATE);
        intent.putExtra(BackgroundConversionService.EXTRA_JOB_ID, call.getString("jobId", ""));
        intent.putExtra(BackgroundConversionService.EXTRA_FILENAME, call.getString("filename", "Audio Track"));
        intent.putExtra(
            BackgroundConversionService.EXTRA_PHASE_LABEL,
            call.getString("phaseLabel", "Converting in background...")
        );
        intent.putExtra(BackgroundConversionService.EXTRA_PROGRESS, call.getInt("progress", 0));

        try {
            context.startService(intent);
        } catch (Exception ignored) {
            // Ignore background restriction if service is already stopped
        }
        call.resolve();
    }

    @PluginMethod
    public void completeConversion(PluginCall call) {
        Context context = getContext();
        if (context == null) {
            call.resolve();
            return;
        }

        Intent intent = new Intent(context, BackgroundConversionService.class);
        intent.setAction(BackgroundConversionService.ACTION_COMPLETE);
        intent.putExtra(BackgroundConversionService.EXTRA_JOB_ID, call.getString("jobId", ""));
        intent.putExtra(
            BackgroundConversionService.EXTRA_TITLE,
            call.getString("title", "Surround X — Conversion Complete")
        );
        intent.putExtra(
            BackgroundConversionService.EXTRA_BODY,
            call.getString("body", "Your converted file is ready to access and play.")
        );
        intent.putExtra(BackgroundConversionService.EXTRA_SHOULD_ALERT, true);

        try {
            context.startService(intent);
        } catch (Exception ignored) {
            // Ignore if OS already cleaned up service
        }
        call.resolve();
    }

    @PluginMethod
    public void failConversion(PluginCall call) {
        Context context = getContext();
        if (context == null) {
            call.resolve();
            return;
        }

        boolean cancelled = Boolean.TRUE.equals(call.getBoolean("cancelled", false));
        Intent intent = new Intent(context, BackgroundConversionService.class);
        intent.setAction(
            cancelled ? BackgroundConversionService.ACTION_CANCEL : BackgroundConversionService.ACTION_FAIL
        );
        intent.putExtra(BackgroundConversionService.EXTRA_JOB_ID, call.getString("jobId", ""));
        intent.putExtra(
            BackgroundConversionService.EXTRA_TITLE,
            call.getString("title", "Surround X — Conversion Failed")
        );
        intent.putExtra(
            BackgroundConversionService.EXTRA_BODY,
            call.getString("body", "Audio conversion encountered an error.")
        );
        intent.putExtra(BackgroundConversionService.EXTRA_SHOULD_ALERT, !cancelled);

        try {
            context.startService(intent);
        } catch (Exception ignored) {
            // Ignore if OS already cleaned up service
        }
        call.resolve();
    }
}
