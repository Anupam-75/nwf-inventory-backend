import express from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_DOWNLOAD_URL =
  "https://nwf-inventory-api.onrender.com/api/app-updates/download";

function readUpdateConfig() {
  return {
    versionCode: Number.parseInt(
      process.env.NWF_ANDROID_UPDATE_VERSION_CODE || "0",
      10
    ),
    versionName: String(process.env.NWF_ANDROID_UPDATE_VERSION_NAME || "").trim(),
    sha256: String(process.env.NWF_ANDROID_UPDATE_SHA256 || "").trim().toLowerCase(),
    releaseNotes: String(process.env.NWF_ANDROID_UPDATE_RELEASE_NOTES || "").trim(),
    forceUpdate:
      String(process.env.NWF_ANDROID_UPDATE_FORCE || "false").trim().toLowerCase() === "true",
    downloadUrl: String(
      process.env.NWF_ANDROID_UPDATE_DOWNLOAD_URL || DEFAULT_DOWNLOAD_URL
    ).trim(),
    githubOwner: String(process.env.NWF_ANDROID_UPDATE_GITHUB_OWNER || "").trim(),
    githubRepo: String(process.env.NWF_ANDROID_UPDATE_GITHUB_REPO || "").trim(),
    githubTag: String(process.env.NWF_ANDROID_UPDATE_GITHUB_TAG || "").trim(),
    githubAsset: String(process.env.NWF_ANDROID_UPDATE_GITHUB_ASSET || "").trim(),
    githubToken: String(process.env.NWF_ANDROID_UPDATE_GITHUB_TOKEN || "").trim()
  };
}

function hasGitHubConfig(config) {
  return Boolean(
    config.githubOwner &&
    config.githubRepo &&
    config.githubTag &&
    config.githubAsset &&
    config.githubToken
  );
}

function validGitHubSlug(value) {
  return /^[A-Za-z0-9_.-]+$/.test(value);
}

function validateDownloadConfig(config) {
  if (!hasGitHubConfig(config)) {
    throw new Error("The private GitHub release connection is not configured.");
  }
  if (!validGitHubSlug(config.githubOwner) || !validGitHubSlug(config.githubRepo)) {
    throw new Error("The private GitHub repository configuration is invalid.");
  }
}

function githubHeaders(token, accept) {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "NWF-Inventory-APK-Updater"
  };
}

async function findConfiguredReleaseAsset(config) {
  validateDownloadConfig(config);

  const releaseUrl = new URL(
    `https://api.github.com/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/releases/tags/${encodeURIComponent(config.githubTag)}`
  );
  const releaseResponse = await fetch(releaseUrl, {
    method: "GET",
    headers: githubHeaders(config.githubToken, "application/vnd.github+json"),
    signal: AbortSignal.timeout(20_000)
  });

  if (!releaseResponse.ok) {
    // Do not return GitHub's error body: it can contain repository details.
    throw new Error(`GitHub release lookup failed (HTTP ${releaseResponse.status}).`);
  }

  const release = await releaseResponse.json();
  if (release?.draft || release?.prerelease) {
    throw new Error("The configured GitHub release is not a published stable release.");
  }

  const asset = Array.isArray(release?.assets)
    ? release.assets.find(
        (item) =>
          item?.name === config.githubAsset &&
          item?.state === "uploaded" &&
          Number(item?.size) > 0 &&
          Number.isSafeInteger(Number(item?.id))
      )
    : null;

  if (!asset) {
    throw new Error("The APK asset was not found in the configured GitHub release.");
  }

  return asset;
}

/**
 * Public metadata endpoint. It never returns the private GitHub URL or token.
 * The APK download URL points back to this Render service.
 */
export function createAppUpdateRouter() {
  const router = express.Router();

  router.get("/latest", (req, res) => {
    res.set("Cache-Control", "no-store");
    const config = readUpdateConfig();

    if (
      !config.versionCode ||
      !config.versionName ||
      !config.sha256 ||
      !hasGitHubConfig(config)
    ) {
      return res.status(200).json({ enabled: false });
    }

    let downloadUrl;
    try {
      downloadUrl = new URL(config.downloadUrl);
    } catch {
      return res.status(503).json({ error: "The app update download URL is invalid." });
    }

    if (
      !Number.isSafeInteger(config.versionCode) ||
      config.versionCode < 1 ||
      downloadUrl.protocol !== "https:" ||
      !downloadUrl.pathname.endsWith("/api/app-updates/download") ||
      !/^[a-f0-9]{64}$/.test(config.sha256) ||
      !validGitHubSlug(config.githubOwner) ||
      !validGitHubSlug(config.githubRepo)
    ) {
      return res.status(503).json({
        error: "The app update release metadata is incomplete or invalid."
      });
    }

    return res.status(200).json({
      enabled: true,
      versionCode: config.versionCode,
      versionName: config.versionName,
      apkUrl: downloadUrl.toString(),
      sha256: config.sha256,
      releaseNotes: config.releaseNotes.slice(0, 4000),
      forceUpdate: config.forceUpdate
    });
  });

  /**
   * APK proxy for a private GitHub release. The GitHub token remains only on
   * Render. Android DownloadManager receives APK bytes from this HTTPS route.
   */
  router.get("/download", async (_req, res) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });

    const config = readUpdateConfig();

    try {
      const asset = await findConfiguredReleaseAsset(config);
      const assetUrl = new URL(
        `https://api.github.com/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/releases/assets/${encodeURIComponent(String(asset.id))}`
      );
      const assetResponse = await fetch(assetUrl, {
        method: "GET",
        headers: githubHeaders(config.githubToken, "application/octet-stream"),
        redirect: "follow",
        signal: AbortSignal.timeout(5 * 60_000)
      });

      if (!assetResponse.ok || !assetResponse.body) {
        throw new Error(`GitHub APK download failed (HTTP ${assetResponse.status}).`);
      }

      const upstreamType = String(assetResponse.headers.get("content-type") || "").toLowerCase();
      if (upstreamType.includes("application/json") || upstreamType.includes("text/html")) {
        throw new Error("GitHub returned a non-binary response for the APK.");
      }

      res.status(200);
      res.setHeader("Content-Type", "application/vnd.android.package-archive");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${config.githubAsset.replace(/[\r\n"\\]/g, "_")}"`
      );
      const contentLength = assetResponse.headers.get("content-length");
      if (contentLength && /^\d+$/.test(contentLength)) {
        res.setHeader("Content-Length", contentLength);
      }

      await pipeline(Readable.fromWeb(assetResponse.body), res);
    } catch (error) {
      console.error("[app-updates] Private APK proxy failed:", error?.message || "unknown error");
      if (!res.headersSent) {
        res.status(502).json({
          error: "The app update could not be downloaded. Please try again later."
        });
      } else {
        res.destroy(error);
      }
    }
  });

  return router;
}
