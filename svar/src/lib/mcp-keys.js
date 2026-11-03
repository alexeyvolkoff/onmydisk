import { writable } from "svelte/store";
import Gun from "gun/gun";
import "gun/sea";
import { omdKeyStore, getStoredOmdKey, deriveEncryptionKey } from "./omd-key.js";
import { isIosNative } from "./platform.js";

/**
 * MCP Application API Keys Vault.
 *
 * Stores API keys and tokens for external apps (e.g. Plane, Grade.app, custom MCP services)
 * E2EE in the user's DID graph:
 *   gun.user().get("keys").get("mcp_apps").get(appId) -> { ciphertext, iv, updatedAt } (AES via omd_key)
 *   Fallback/legacy: Gun.SEA.encrypt(payload, devicePair) -> { enc, updatedAt }
 *
 * LocalStorage mirror:
 *   "omd_mcp_keys:<mainPub>" -> instant availability on reload.
 */

const LS_PREFIX = "omd_mcp_keys";
const GRAPH_ROOT = "keys";
const GRAPH_NODE = "mcp_apps";
const MCP_SALT = "omd-mcp-keys-salt-v1";

const ALL_PRESET_MCP_APPS = [
  {
    id: "club_pass",
    name: "Club Pass",
    url: "https://whop.com/onmychat/on-my-chat-creative-studio",
    placeholder: "pass_... / key_...",
    description: "On My Chat Creative Studio & Dedicated GPU Pass",
    badgeColor: "#8B5CF6",
  },
  {
    id: "civitai",
    name: "CivitAI",
    url: "https://civitai.com/user/account",
    placeholder: "civitai_api_token...",
    description: "CivitAI Publishing & Models Token",
    badgeColor: "#2563EB",
  },
  {
    id: "plane",
    name: "Plane",
    url: "https://app.plane.so",
    placeholder: "plane_api_...",
    description: "Plane Project Management",
    badgeColor: "#3F76FF",
  },
];

export const PRESET_MCP_APPS = isIosNative()
  ? ALL_PRESET_MCP_APPS.filter((p) => p.id !== "club_pass")
  : ALL_PRESET_MCP_APPS;

let identityRef = null;
let boundPub = "";
let unsubGraph = null;
let unsubOmdKey = null;

/** appId -> { appId, name, url, key, updatedAt } */
const cache = new Map();

/** AES-GCM CryptoKey derived from omd_key */
let vaultCrypto = null;
let vaultKeySource = "";

export const mcpKeysStore = writable({ byApp: {}, ready: false });

function publish() {
  const byApp = {};
  for (const [appId, rec] of cache) {
    byApp[appId] = { ...rec };
  }
  mcpKeysStore.set({ byApp, ready: true });
}

function lsKey() {
  return LS_PREFIX + ":" + ((identityRef && identityRef.mainPub) || "anon");
}

function persistMirror() {
  if (typeof window === "undefined") return;
  const obj = {};
  for (const [appId, rec] of cache) obj[appId] = rec;
  const serialized = JSON.stringify(obj);
  const key = lsKey();
  try {
    window.localStorage.setItem(key, serialized);
    return;
  } catch (e) {
    // Evict disposable GunDB / prompt caches if localStorage hit the 5MB browser quota
    try {
      for (const k of Object.keys(window.localStorage)) {
        if (k === "gun/" || k.startsWith("gun/") || k.startsWith("radata") || k === "krea_file_prompts") {
          window.localStorage.removeItem(k);
        }
      }
      window.localStorage.setItem(key, serialized);
      return;
    } catch (e2) {
      try {
        window.sessionStorage.setItem(key, serialized);
      } catch (_) {}
      console.warn("[mcp-keys] local mirror write failed:", e2);
    }
  }
}

function loadLocalMirror() {
  if (typeof window === "undefined") return;
  try {
    const key = lsKey();
    const raw = window.localStorage.getItem(key) || window.sessionStorage.getItem(key);
    if (!raw) return;
    const obj = JSON.parse(raw) || {};
    for (const [appId, rec] of Object.entries(obj)) {
      if (rec && typeof rec === "object" && rec.key) {
        cache.set(appId, {
          appId: rec.appId || appId,
          name: rec.name || appId,
          url: rec.url || "",
          key: String(rec.key),
          updatedAt: rec.updatedAt || Date.now(),
        });
      }
    }
  } catch (e) {
    console.warn("[mcp-keys] local mirror read failed:", e);
  }
}

function uint8ToBase64(u8) {
  let binary = "";
  const len = u8.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(u8[i]);
  }
  return btoa(binary);
}

function base64ToUint8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function refreshVaultCrypto() {
  const key = getStoredOmdKey();
  if (!key) {
    vaultCrypto = null;
    vaultKeySource = "";
    return;
  }
  if (vaultKeySource === key && vaultCrypto) return;
  try {
    const cryptoKey = await deriveEncryptionKey(key, MCP_SALT);
    vaultCrypto = cryptoKey;
    vaultKeySource = key;
  } catch (e) {
    console.warn("[mcp-keys] failed to derive vault crypto:", e);
    vaultCrypto = null;
    vaultKeySource = "";
  }
}

async function aesEncrypt(rec) {
  if (!vaultCrypto || typeof crypto === "undefined" || !crypto.subtle) return null;
  try {
    const encoder = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = encoder.encode(JSON.stringify(rec));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, vaultCrypto, data);
    return {
      ciphertext: uint8ToBase64(new Uint8Array(ciphertext)),
      iv: uint8ToBase64(iv),
      updatedAt: rec.updatedAt || Date.now(),
    };
  } catch (e) {
    console.warn("[mcp-keys] AES encrypt failed:", e);
    return null;
  }
}

async function aesDecrypt(payload) {
  if (!vaultCrypto || typeof crypto === "undefined" || !crypto.subtle) return null;
  try {
    const iv = base64ToUint8(payload.iv);
    const ciphertext = base64ToUint8(payload.ciphertext);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, vaultCrypto, ciphertext);
    const decoded = new TextDecoder().decode(decrypted);
    let parsed;
    try { parsed = JSON.parse(decoded); } catch (e) { parsed = decoded; }
    if (parsed && typeof parsed === "object" && parsed.key) {
      return parsed;
    }
    if (typeof parsed === "string") {
      return { key: parsed };
    }
  } catch (e) {
    console.warn("[mcp-keys] AES decrypt failed:", e);
  }
  return null;
}

async function decryptEntry(entry, appId) {
  if (!entry || typeof entry !== "object") return null;

  // 1. AES payload encrypted via derived omd_key
  if (entry.ciphertext && entry.iv) {
    await refreshVaultCrypto();
    const rec = await aesDecrypt(entry);
    if (rec) {
      return {
        appId: rec.appId || appId,
        name: rec.name || appId,
        url: rec.url || "",
        key: String(rec.key),
        updatedAt: entry.updatedAt || rec.updatedAt || Date.now(),
      };
    }
  }

  // 2. SEA-encrypted fallback with identity devicePair
  if (typeof entry.enc === "string" && identityRef && identityRef.devicePair) {
    try {
      const dec = await Gun.SEA.decrypt(entry.enc, identityRef.devicePair);
      let parsed = dec;
      if (typeof dec === "string") {
        try { parsed = JSON.parse(dec); } catch (e) { parsed = { key: dec }; }
      }
      if (parsed && (parsed.key || typeof parsed === "string")) {
        return {
          appId: parsed.appId || appId,
          name: parsed.name || appId,
          url: parsed.url || "",
          key: String(parsed.key || parsed),
          updatedAt: entry.updatedAt || parsed.updatedAt || Date.now(),
        };
      }
    } catch (e) {
      console.warn("[mcp-keys] SEA decrypt failed for", appId, e);
    }
  }

  return null;
}

async function syncToGraph() {
  if (!identityRef || !identityRef.gun) return;
  await refreshVaultCrypto();
  const userNode = identityRef.gun.user().get(GRAPH_ROOT).get(GRAPH_NODE);

  for (const [appId, rec] of cache) {
    let payload = await aesEncrypt(rec);
    if (!payload && identityRef.devicePair) {
      try {
        const enc = await Gun.SEA.encrypt(JSON.stringify(rec), identityRef.devicePair);
        if (enc) payload = { enc, updatedAt: rec.updatedAt || Date.now() };
      } catch (_) {}
    }
    if (payload) {
      try {
        userNode.get(String(appId)).put(payload);
      } catch (e) {
        console.warn("[mcp-keys] graph put failed for", appId, e);
      }
    }
  }
}

function subscribeGraph() {
  const gun = identityRef && identityRef.gun;
  if (!gun) return;

  try {
    const handle = gun.user().get(GRAPH_ROOT).get(GRAPH_NODE).map().on(async (entry, appId) => {
      if (!appId) return;
      if (!entry || (typeof entry === "object" && !entry.ciphertext && !entry.enc)) {
        if (cache.delete(String(appId))) {
          publish();
          persistMirror();
        }
        return;
      }
      const rec = await decryptEntry(entry, appId);
      if (rec && rec.key) {
        cache.set(String(appId), rec);
        publish();
        persistMirror();
      }
    });

    unsubGraph = () => {
      try { handle.off(); } catch (e) { /* ignore */ }
    };
  } catch (e) {
    console.warn("[mcp-keys] graph subscription failed:", e);
  }
}

function detach() {
  if (unsubGraph) {
    try { unsubGraph(); } catch (e) { /* ignore */ }
    unsubGraph = null;
  }
  if (unsubOmdKey) {
    try { unsubOmdKey(); } catch (e) { /* ignore */ }
    unsubOmdKey = null;
  }
}

export function setMcpKeysIdentity(identity) {
  if (!identity || identity.type !== "persistent" || !identity.devicePair) return;
  const pub = identity.devicePair.pub || "";
  if (identityRef === identity && pub === boundPub) return;

  detach();
  identityRef = identity;
  boundPub = pub;
  cache.clear();
  loadLocalMirror();
  publish();
  subscribeGraph();

  refreshVaultCrypto().then(() => syncToGraph());
  unsubOmdKey = omdKeyStore.subscribe(() => {
    refreshVaultCrypto().then(() => syncToGraph());
  });
}

export function clearMcpKeysIdentity() {
  detach();
  identityRef = null;
  boundPub = "";
  cache.clear();
  loadLocalMirror();
  publish();
}

/**
 * Save or update an MCP application key in DID graph + local mirror.
 */
export async function saveMcpAppKey(appId, meta = {}) {
  const cleanId = String(appId).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  if (!cleanId) throw new Error("Invalid application ID");

  const keyVal = String(meta.key || "").trim();
  if (!keyVal) throw new Error("API key cannot be empty");

  const rec = {
    appId: cleanId,
    name: meta.name ? String(meta.name).trim() : cleanId,
    url: meta.url ? String(meta.url).trim() : "",
    key: keyVal,
    updatedAt: Date.now(),
  };

  cache.set(cleanId, rec);
  publish();
  persistMirror();

  // Graph persistence
  if (identityRef && identityRef.gun) {
    await refreshVaultCrypto();
    let payload = await aesEncrypt(rec);
    if (!payload && identityRef.devicePair) {
      const enc = await Gun.SEA.encrypt(JSON.stringify(rec), identityRef.devicePair);
      if (enc) payload = { enc, updatedAt: rec.updatedAt };
    }
    if (payload) {
      try {
        identityRef.gun.user().get(GRAPH_ROOT).get(GRAPH_NODE).get(cleanId).put(payload);
      } catch (e) {
        console.warn("[mcp-keys] graph put failed:", e);
      }
    }
  }

  return rec;
}

/**
 * Remove an MCP application key from DID graph + local mirror.
 */
export async function removeMcpAppKey(appId) {
  const cleanId = String(appId).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  if (!cleanId) return;

  cache.delete(cleanId);
  publish();
  persistMirror();

  if (identityRef && identityRef.gun) {
    try {
      identityRef.gun.user().get(GRAPH_ROOT).get(GRAPH_NODE).get(cleanId).put(null);
    } catch (e) {
      console.warn("[mcp-keys] graph remove failed:", e);
    }
  }
}

/**
 * Retrieve decrypted key string for a given appId.
 */
export function getStoredMcpAppKey(appId) {
  if (!appId) return "";
  const cleanId = String(appId).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const rec = cache.get(cleanId);
  return rec ? rec.key : "";
}

/**
 * Retrieve complete app record { appId, name, url, key, updatedAt }.
 */
export function getStoredMcpApp(appId) {
  if (!appId) return null;
  const cleanId = String(appId).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  return cache.get(cleanId) ? { ...cache.get(cleanId) } : null;
}

/**
 * Retrieve all app records as an array.
 */
export function getAllStoredMcpApps() {
  return Array.from(cache.values()).map((r) => ({ ...r }));
}

/**
 * Retrieve map of keys and URLs for backend requests:
 * { "plane": "...", "plane_url": "...", "grade": "..." }
 */
export function getMcpPayload() {
  const res = {};
  for (const [id, rec] of cache) {
    if (rec.key) {
      res[id] = rec.key;
      if (rec.url) res[`${id}_url`] = rec.url;
      if (rec.name) res[`${id}_name`] = rec.name;
    }
  }
  return res;
}

// Global exposure for MCP tools and external helpers
if (typeof window !== "undefined") {
  loadLocalMirror();
  publish();

  window.__omdGetMcpKey = getStoredMcpAppKey;
  window.__omdGetMcpApp = getStoredMcpApp;
  window.__omdGetAllMcpKeys = () => {
    const res = {};
    for (const [id, rec] of cache) res[id] = rec.key;
    return res;
  };
  window.__omdGetMcpPayload = getMcpPayload;
}
