package com.surroundx.studio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

public class BackgroundConversionService extends Service {

    public static final String ACTION_START = "com.surroundx.studio.action.START_CONVERSION";
    public static final String ACTION_UPDATE = "com.surroundx.studio.action.UPDATE_CONVERSION";
    public static final String ACTION_COMPLETE = "com.surroundx.studio.action.COMPLETE_CONVERSION";
    public static final String ACTION_FAIL = "com.surroundx.studio.action.FAIL_CONVERSION";
    public static final String ACTION_CANCEL = "com.surroundx.studio.action.CANCEL_CONVERSION";

    public static final String EXTRA_JOB_ID = "jobId";
    public static final String EXTRA_FILENAME = "filename";
    public static final String EXTRA_OUTPUT_FILENAME = "outputFilename";
    public static final String EXTRA_PROGRESS = "progress";
    public static final String EXTRA_PHASE_LABEL = "phaseLabel";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";
    public static final String EXTRA_SHOULD_ALERT = "shouldAlert";

    public static final String CHANNEL_PROGRESS_ID = "surroundx_conversion_progress_silent";
    public static final String CHANNEL_ALERTS_ID = "surroundx_conversion_alerts";

    public static final int PROGRESS_NOTIFICATION_ID = 4101;
    public static final int ALERT_NOTIFICATION_ID = 4102;

    private static final long WAKELOCK_TIMEOUT_MS = 45L * 60L * 1000L;

    private PowerManager.WakeLock wakeLock;
    private boolean isConversionActive = false;
    private String activeJobId = "";
    private String lastAlertedJobId = "";
    private Bitmap largeIconBitmap = null;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();
        try {
            largeIconBitmap = BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher);
        } catch (Exception ignored) {
            largeIconBitmap = null;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || intent.getAction() == null) {
            stopForegroundAndCancelProgress();
            stopSelf();
            return START_NOT_STICKY;
        }

        createNotificationChannels();
        String action = intent.getAction();
        String jobId = nonEmpty(intent.getStringExtra(EXTRA_JOB_ID), activeJobId);

        if (ACTION_START.equals(action)) {
            isConversionActive = true;
            activeJobId = jobId;
            acquireWakeLock();

            String filename = nonEmpty(intent.getStringExtra(EXTRA_FILENAME), "Audio Track");
            String phaseLabel = nonEmpty(intent.getStringExtra(EXTRA_PHASE_LABEL), "Converting in background...");
            int progress = clampProgress(intent.getIntExtra(EXTRA_PROGRESS, 0));

            Notification notification = buildSilentProgressNotification(filename, phaseLabel, progress);
            int serviceType = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                : 0;
            ServiceCompat.startForeground(this, PROGRESS_NOTIFICATION_ID, notification, serviceType);
            return START_NOT_STICKY;
        }

        if (ACTION_UPDATE.equals(action)) {
            if (!isConversionActive) {
                return START_NOT_STICKY;
            }
            if (!jobId.isEmpty() && !activeJobId.isEmpty() && !jobId.equals(activeJobId)) {
                return START_NOT_STICKY;
            }

            String filename = nonEmpty(intent.getStringExtra(EXTRA_FILENAME), "Audio Track");
            String phaseLabel = nonEmpty(intent.getStringExtra(EXTRA_PHASE_LABEL), "Converting in background...");
            int progress = clampProgress(intent.getIntExtra(EXTRA_PROGRESS, 0));

            NotificationManager manager = getNotificationManager();
            if (manager != null) {
                manager.notify(
                    PROGRESS_NOTIFICATION_ID,
                    buildSilentProgressNotification(filename, phaseLabel, progress)
                );
            }
            return START_NOT_STICKY;
        }

        if (ACTION_COMPLETE.equals(action) || ACTION_FAIL.equals(action)) {
            isConversionActive = false;
            releaseWakeLock();
            stopForegroundAndCancelProgress();

            boolean shouldAlert = intent.getBooleanExtra(EXTRA_SHOULD_ALERT, true);
            String dedupKey = !jobId.isEmpty() ? jobId : String.valueOf(startId);
            if (shouldAlert && !dedupKey.equals(lastAlertedJobId)) {
                lastAlertedJobId = dedupKey;
                String fallbackTitle = ACTION_COMPLETE.equals(action)
                    ? "Surround X — Conversion Complete"
                    : "Surround X — Conversion Failed";
                String title = nonEmpty(intent.getStringExtra(EXTRA_TITLE), fallbackTitle);
                String body = nonEmpty(
                    intent.getStringExtra(EXTRA_BODY),
                    ACTION_COMPLETE.equals(action)
                        ? "Your converted audio file is ready to access and play."
                        : "Audio conversion stopped due to an error."
                );
                postSingleAlertNotification(title, body);
            }

            stopSelf();
            return START_NOT_STICKY;
        }

        if (ACTION_CANCEL.equals(action)) {
            isConversionActive = false;
            activeJobId = "";
            releaseWakeLock();
            stopForegroundAndCancelProgress();
            stopSelf();
            return START_NOT_STICKY;
        }

        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        isConversionActive = false;
        releaseWakeLock();
        stopForegroundAndCancelProgress();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = getNotificationManager();
        if (manager == null) {
            return;
        }

        // Silent low-importance channel for ongoing progress updates (never plays sound or vibrates)
        if (manager.getNotificationChannel(CHANNEL_PROGRESS_ID) == null) {
            NotificationChannel progressChannel = new NotificationChannel(
                CHANNEL_PROGRESS_ID,
                "Background Audio Conversion",
                NotificationManager.IMPORTANCE_LOW
            );
            progressChannel.setDescription("Silent progress indicator while Surround X processes audio in the background.");
            progressChannel.setSound(null, null);
            progressChannel.enableVibration(false);
            progressChannel.enableLights(false);
            progressChannel.setShowBadge(false);
            manager.createNotificationChannel(progressChannel);
        }

        // High-importance channel for single-shot completion or error pop-up alerts
        if (manager.getNotificationChannel(CHANNEL_ALERTS_ID) == null) {
            NotificationChannel alertChannel = new NotificationChannel(
                CHANNEL_ALERTS_ID,
                "Conversion Complete Alerts",
                NotificationManager.IMPORTANCE_HIGH
            );
            alertChannel.setDescription("Pop-up alert when audio conversion completes or fails.");
            alertChannel.enableVibration(true);
            alertChannel.enableLights(true);
            alertChannel.setShowBadge(true);
            manager.createNotificationChannel(alertChannel);
        }
    }

    private Notification buildSilentProgressNotification(String filename, String phaseLabel, int progress) {
        PendingIntent launchIntent = createOpenAppPendingIntent(1001);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_PROGRESS_ID)
            .setSmallIcon(R.drawable.ic_stat_surroundx)
            .setContentTitle("Converting · " + filename)
            .setContentText(phaseLabel + " (" + progress + "%)")
            .setSubText("Running in background")
            .setProgress(100, progress, progress <= 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setSound(null)
            .setVibrate(null)
            .setDefaults(0)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(launchIntent);

        if (largeIconBitmap != null) {
            builder.setLargeIcon(largeIconBitmap);
        }
        return builder.build();
    }

    private void postSingleAlertNotification(String title, String body) {
        NotificationManager manager = getNotificationManager();
        if (manager == null) {
            return;
        }
        PendingIntent launchIntent = createOpenAppPendingIntent(1002);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ALERTS_ID)
            .setSmallIcon(R.drawable.ic_stat_surroundx)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setContentIntent(launchIntent);

        if (largeIconBitmap != null) {
            builder.setLargeIcon(largeIconBitmap);
        }
        manager.notify(ALERT_NOTIFICATION_ID, builder.build());
    }

    private PendingIntent createOpenAppPendingIntent(int requestCode) {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(this, requestCode, openIntent, flags);
    }

    private void stopForegroundAndCancelProgress() {
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        } catch (Exception ignored) {
            // Ignore if service was not started in foreground
        }
        NotificationManager manager = getNotificationManager();
        if (manager != null) {
            manager.cancel(PROGRESS_NOTIFICATION_ID);
        }
    }

    private void acquireWakeLock() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SurroundX::ConversionWakeLock");
                    wakeLock.setReferenceCounted(false);
                }
            }
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire(WAKELOCK_TIMEOUT_MS);
            }
        } catch (Exception ignored) {
            // Do not crash conversion if WakeLock is unavailable on restricted ROMs
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception ignored) {
            // Ignore already-released WakeLock
        }
    }

    @Nullable
    private NotificationManager getNotificationManager() {
        return (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    }

    private static int clampProgress(int value) {
        return Math.max(0, Math.min(100, value));
    }

    private static String nonEmpty(@Nullable String value, String fallback) {
        if (value == null || value.trim().isEmpty()) {
            return fallback;
        }
        return value.trim();
    }
}
