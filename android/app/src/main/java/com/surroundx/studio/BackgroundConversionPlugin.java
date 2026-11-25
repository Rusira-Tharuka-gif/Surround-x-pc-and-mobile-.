package com.surroundx.studio;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

@CapacitorPlugin(
    name = "BackgroundConversion",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class BackgroundConversionPlugin extends Plugin {

    private static final class ActiveTransfer {
        final File tempFile;
        final OutputStream stream;
        long bytesWritten = 0L;

        ActiveTransfer(File tempFile, OutputStream stream) {
            this.tempFile = tempFile;
            this.stream = stream;
        }
    }

    private final Map<String, ActiveTransfer> activeTransfers = new ConcurrentHashMap<>();

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

    @PluginMethod
    public void beginSaveOutput(PluginCall call) {
        Context context = getContext();
        if (context == null) {
            call.reject("Android application context is unavailable.");
            return;
        }

        try {
            File exportsDir = new File(context.getCacheDir(), "exports");
            if (!exportsDir.exists() && !exportsDir.mkdirs()) {
                call.reject("Unable to create export cache directory.");
                return;
            }
            pruneStaleCacheFiles(exportsDir);

            String transferId = UUID.randomUUID().toString();
            File tempFile = new File(exportsDir, "tx_" + transferId + ".tmp");
            OutputStream stream = new BufferedOutputStream(new FileOutputStream(tempFile), 65536);
            activeTransfers.put(transferId, new ActiveTransfer(tempFile, stream));

            JSObject res = new JSObject();
            res.put("transferId", transferId);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("Failed to initialize Android file export: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void appendSaveChunk(PluginCall call) {
        String transferId = call.getString("transferId", "");
        String base64Chunk = call.getString("base64Chunk", "");
        ActiveTransfer transfer = activeTransfers.get(transferId);
        if (transfer == null) {
            call.reject("Unknown or expired file transfer ID.");
            return;
        }
        if (base64Chunk == null || base64Chunk.isEmpty()) {
            JSObject res = new JSObject();
            res.put("bytesWritten", transfer.bytesWritten);
            call.resolve(res);
            return;
        }

        try {
            byte[] decoded = Base64.decode(base64Chunk, Base64.DEFAULT);
            transfer.stream.write(decoded);
            transfer.bytesWritten += decoded.length;
            JSObject res = new JSObject();
            res.put("bytesWritten", transfer.bytesWritten);
            call.resolve(res);
        } catch (Exception e) {
            cleanupTransfer(transferId);
            call.reject("Failed writing export chunk: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void finishSaveOutput(PluginCall call) {
        Context context = getContext();
        if (context == null) {
            call.reject("Android application context is unavailable.");
            return;
        }

        String transferId = call.getString("transferId", "");
        String rawFilename = call.getString("filename", "Surround_X_Output.ac3");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        ActiveTransfer transfer = activeTransfers.remove(transferId);
        if (transfer == null) {
            call.reject("Unknown or expired file transfer ID.");
            return;
        }

        String filename = sanitizeFilename(rawFilename);
        try {
            transfer.stream.flush();
            transfer.stream.close();

            if (!transfer.tempFile.exists() || transfer.tempFile.length() <= 0) {
                transfer.tempFile.delete();
                call.reject("Converted file is empty (0 bytes).");
                return;
            }

            File exportsDir = new File(context.getCacheDir(), "exports");
            File cachedFile = new File(exportsDir, filename);
            if (cachedFile.exists()) {
                cachedFile.delete();
            }
            if (!transfer.tempFile.renameTo(cachedFile)) {
                copyFile(transfer.tempFile, cachedFile);
                transfer.tempFile.delete();
            }

            Uri shareUri = FileProvider.getUriForFile(
                context,
                context.getPackageName() + ".fileprovider",
                cachedFile
            );

            Uri publicUri = null;
            String locationLabel = "App Cache";
            String savedPath = cachedFile.getAbsolutePath();

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                publicUri = saveToMediaStoreDownloads(context, cachedFile, filename, mimeType);
                if (publicUri != null) {
                    locationLabel = "Downloads/Surround X";
                    savedPath = "Downloads/Surround X/" + filename;
                }
            } else {
                File publicDownloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                File targetDir = new File(publicDownloads, "Surround X");
                if (targetDir.exists() || targetDir.mkdirs()) {
                    File destFile = ensureUniqueFile(targetDir, filename);
                    try {
                        copyFile(cachedFile, destFile);
                        MediaScannerConnection.scanFile(
                            context,
                            new String[] { destFile.getAbsolutePath() },
                            new String[] { mimeType },
                            null
                        );
                        publicUri = Uri.fromFile(destFile);
                        locationLabel = "Downloads/Surround X";
                        savedPath = destFile.getAbsolutePath();
                    } catch (Exception ignored) {
                        // Fall back cleanly to app-scoped external Downloads folder below
                    }
                }
            }

            if (publicUri == null) {
                File appDownloads = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (appDownloads != null && (appDownloads.exists() || appDownloads.mkdirs())) {
                    File appDest = ensureUniqueFile(appDownloads, filename);
                    copyFile(cachedFile, appDest);
                    publicUri = FileProvider.getUriForFile(
                        context,
                        context.getPackageName() + ".fileprovider",
                        appDest
                    );
                    locationLabel = "App Downloads folder";
                    savedPath = appDest.getAbsolutePath();
                }
            }

            String primaryUri = publicUri != null ? publicUri.toString() : shareUri.toString();
            JSObject res = new JSObject();
            res.put("savedPath", savedPath);
            res.put("contentUri", primaryUri);
            res.put("shareUri", shareUri.toString());
            res.put("locationLabel", locationLabel);
            res.put("sizeBytes", cachedFile.length());
            call.resolve(res);
        } catch (Exception e) {
            if (transfer.tempFile.exists()) {
                transfer.tempFile.delete();
            }
            call.reject("Unable to finalize Android output file: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void abortSaveOutput(PluginCall call) {
        String transferId = call.getString("transferId", "");
        cleanupTransfer(transferId);
        call.resolve();
    }

    @PluginMethod
    public void shareOutputFile(PluginCall call) {
        Context context = getContext();
        if (context == null) {
            call.reject("Android application context is unavailable.");
            return;
        }
        String uriStr = call.getString("contentUri", "");
        String filename = call.getString("filename", "Surround_X_Output.ac3");
        String mimeType = call.getString("mimeType", "audio/*");
        if (uriStr == null || uriStr.isEmpty()) {
            call.reject("No saved output URI is available to share.");
            return;
        }

        try {
            Uri uri = Uri.parse(uriStr);
            Intent sendIntent = new Intent(Intent.ACTION_SEND);
            sendIntent.setType(mimeType);
            sendIntent.putExtra(Intent.EXTRA_STREAM, uri);
            sendIntent.putExtra(Intent.EXTRA_SUBJECT, filename);
            sendIntent.putExtra(Intent.EXTRA_TITLE, filename);
            sendIntent.setClipData(ClipData.newRawUri(filename, uri));
            sendIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            Intent chooser = Intent.createChooser(sendIntent, "Save or Share " + filename);
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject("Unable to open Android Share sheet: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void openOutputFile(PluginCall call) {
        Context context = getContext();
        if (context == null) {
            call.reject("Android application context is unavailable.");
            return;
        }
        String uriStr = call.getString("contentUri", "");
        String filename = call.getString("filename", "Surround_X_Output.ac3");
        String mimeType = call.getString("mimeType", "audio/*");
        if (uriStr == null || uriStr.isEmpty()) {
            call.reject("No saved output URI is available to open.");
            return;
        }

        try {
            Uri uri = Uri.parse(uriStr);
            Intent viewIntent = new Intent(Intent.ACTION_VIEW);
            viewIntent.setDataAndType(uri, mimeType);
            viewIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);

            Intent chooser = Intent.createChooser(viewIntent, "Open " + filename);
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(chooser);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No media player app registered for " + mimeType + ". Use Share / Save instead.");
        } catch (Exception e) {
            call.reject("Unable to open audio file: " + e.getMessage(), e);
        }
    }

    private void cleanupTransfer(String transferId) {
        ActiveTransfer transfer = activeTransfers.remove(transferId);
        if (transfer != null) {
            try {
                transfer.stream.close();
            } catch (IOException ignored) {
                // Ignore close error
            }
            if (transfer.tempFile.exists()) {
                transfer.tempFile.delete();
            }
        }
    }

    private static Uri saveToMediaStoreDownloads(
        Context context,
        File sourceFile,
        String filename,
        String mimeType
    ) throws IOException {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return null;
        }
        ContentResolver resolver = context.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
        values.put(
            MediaStore.MediaColumns.RELATIVE_PATH,
            Environment.DIRECTORY_DOWNLOADS + File.separator + "Surround X"
        );
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);

        Uri itemUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (itemUri == null) {
            return null;
        }

        try (
            InputStream in = new FileInputStream(sourceFile);
            OutputStream out = resolver.openOutputStream(itemUri)
        ) {
            if (out == null) {
                resolver.delete(itemUri, null, null);
                return null;
            }
            byte[] buffer = new byte[65536];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            out.flush();
        } catch (IOException e) {
            resolver.delete(itemUri, null, null);
            throw e;
        }

        ContentValues publish = new ContentValues();
        publish.put(MediaStore.MediaColumns.IS_PENDING, 0);
        resolver.update(itemUri, publish, null, null);
        return itemUri;
    }

    private static void copyFile(File src, File dst) throws IOException {
        try (InputStream in = new FileInputStream(src); OutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[65536];
            int len;
            while ((len = in.read(buf)) != -1) {
                out.write(buf, 0, len);
            }
            out.flush();
        }
    }

    private static File ensureUniqueFile(File dir, String filename) {
        File candidate = new File(dir, filename);
        if (!candidate.exists()) return candidate;
        int dot = filename.lastIndexOf('.');
        String stem = dot > 0 ? filename.substring(0, dot) : filename;
        String ext = dot > 0 ? filename.substring(dot) : "";
        for (int i = 1; i <= 99; i++) {
            File next = new File(dir, stem + "_" + i + ext);
            if (!next.exists()) return next;
        }
        return candidate;
    }

    private static void pruneStaleCacheFiles(File dir) {
        File[] files = dir.listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - (30L * 60L * 1000L);
        for (File f : files) {
            if (f.lastModified() < cutoff) {
                f.delete();
            }
        }
    }

    private static String sanitizeFilename(String raw) {
        if (raw == null || raw.trim().isEmpty()) {
            return "Surround_X_Output.ac3";
        }
        String leaf = new File(raw).getName();
        String cleaned = leaf.replaceAll("[^a-zA-Z0-9._-]", "_").replaceAll("^\\.+", "");
        return cleaned.isEmpty() ? "Surround_X_Output.ac3" : cleaned;
    }
}
