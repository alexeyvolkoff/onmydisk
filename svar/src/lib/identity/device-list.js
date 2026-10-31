import { deviceRegistry } from "../device-registry.js";
import { getOrCreateLocalLinkId, getDefaultWebDeviceName } from "../local-client.js";

/**
 * Bridges PersistentIdentity's GunDB device list with App.svelte's
 * connectDevice() / filesData flow.
 *
 * Usage from App.svelte:
 *
 *   import { loadMyDevices } from "./lib/identity/device-list.js";
 *   // after identity init + connectDevice exist:
 *   const unsub = loadMyDevices(identity, connectDevice, () => filesData, (v) => filesData = v, () => fmApi);
 */
export function loadMyDevices(identity, registerDevicePlaceholder, getFilesData, setFilesData, getFmApi) {
  if (!identity || identity.type !== "persistent") return () => {};

  const seen = new Set(); // linkIds we already handed to registerDevicePlaceholder

  return identity.subscribeDeviceList((devices) => {
    const activeIds = new Set(devices.map(d => d.linkId).filter(Boolean));
    const localId = getOrCreateLocalLinkId();
    const localDev = deviceRegistry.get(localId) || deviceRegistry.list().find(d => d && d.local);
    const localName = (
      localDev?.name ||
      (typeof localStorage !== "undefined" ? localStorage.getItem("omd_local_devicename") : "") ||
      getDefaultWebDeviceName() ||
      ""
    ).toLowerCase();

    for (const id of seen) {
      if (!activeIds.has(id)) seen.delete(id);
    }

    for (const dev of devices) {
      if (!dev.linkId) continue;
      if (dev.linkId === localId) continue;
      const existing = deviceRegistry.get(dev.linkId);
      if (existing && existing.local) continue;

      // Skip stale browser-device entries from previous sessions/origins that share
      // our local web device's name (e.g. "Linux-desktop") and have no native node capabilities.
      const devNameLower = (dev.name || "").toLowerCase();
      const caps = Array.isArray(dev.capabilities) ? dev.capabilities : [];
      const isStaleSameWebDevice =
        localName &&
        devNameLower === localName &&
        (dev.type === "web" || (!caps.includes("chat") && !caps.includes("terminal")));
      if (isStaleSameWebDevice) {
        continue;
      }

      if (!seen.has(dev.linkId)) {
        seen.add(dev.linkId);
        console.log("[device-list] registering saved device placeholder:", dev.name, dev.linkId);
        registerDevicePlaceholder(dev.linkId, dev.name);
      }
    }
  });
}
