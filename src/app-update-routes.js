import express from "express";

/** Public, read-only release metadata for the direct Android APK updater. */
export function createAppUpdateRouter() {
  const router = express.Router();

  router.get("/latest", (_req, res) => {
    res.set("Cache-Control", "no-store");

    const versionCode = Number.parseInt(
      process.env.NWF_ANDROID_UPDATE_VERSION_CODE || "0",
      10
    );
    const versionName = String(
      process.env.NWF_ANDROID_UPDATE_VERSION_NAME || ""
    ).trim();
    const apkUrl = String(
      process.env.NWF_ANDROID_UPDATE_APK_URL || ""
    ).trim();
    const sha256 = String(
      process.env.NWF_ANDROID_UPDATE_SHA256 || ""
    ).trim().toLowerCase();
    const releaseNotes = String(
      process.env.NWF_ANDROID_UPDATE_RELEASE_NOTES || ""
    ).trim();
    const forceUpdate = String(
      process.env.NWF_ANDROID_UPDATE_FORCE || "false"
    ).trim().toLowerCase() === "true";

    // The endpoint remains harmless until a release has been published and
    // all metadata has been configured in Render.
    if (!versionCode || !versionName || !apkUrl || !sha256) {
      return res.status(200).json({ enabled: false });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(apkUrl);
    } catch {
      return res.status(503).json({ error: "The app update URL is invalid." });
    }

    if (
      !Number.isSafeInteger(versionCode) ||
      versionCode < 1 ||
      parsedUrl.protocol !== "https:" ||
      !/^[a-f0-9]{64}$/.test(sha256)
    ) {
      return res.status(503).json({
        error: "The app update release metadata is incomplete or invalid."
      });
    }

    return res.status(200).json({
      enabled: true,
      versionCode,
      versionName,
      apkUrl: parsedUrl.toString(),
      sha256,
      releaseNotes: releaseNotes.slice(0, 4000),
      forceUpdate
    });
  });

  return router;
}
