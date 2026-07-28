import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const errors = [];

if (manifest.manifest_version !== 3) errors.push("manifest_version must be 3");
if (!manifest.background?.service_worker) errors.push("background.service_worker is required");
if (manifest.background?.type !== "module") errors.push("background.type must be module");
if (!manifest.side_panel?.default_path) errors.push("side_panel.default_path is required");
const allowedHosts = ["https://studio.youtube.com/*", "http://localhost:9540/*"];
if (!Array.isArray(manifest.host_permissions)
  || manifest.host_permissions.length !== allowedHosts.length
  || allowedHosts.some((host) => !manifest.host_permissions.includes(host))) {
  errors.push(`host_permissions must contain only ${allowedHosts.join(" and ")}`);
}
if ((manifest.host_permissions || []).includes("<all_urls>")) errors.push("<all_urls> is forbidden");
if ((manifest.permissions || []).includes("tabs")) errors.push("tabs permission is not required and should not be requested");
if (!(manifest.permissions || []).includes("power")) errors.push("power permission is required for job-scoped display keep-awake");
if (!(manifest.permissions || []).includes("scripting")) errors.push("scripting permission is required for the Studio reconnect fallback");
if (manifest.content_security_policy?.extension_pages?.includes("unsafe-eval")) errors.push("unsafe-eval is forbidden");

if (errors.length) {
  for (const error of errors) console.error(`Manifest error: ${error}`);
  process.exitCode = 1;
} else {
  console.log("Manifest JSON and permission policy are valid.");
}
