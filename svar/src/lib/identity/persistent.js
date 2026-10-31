import Gun from "gun/gun";
import "gun/sea";
import { readLegacyStorage, generateOmdKey } from "../omd-key";
import { translate } from "../i18n/index.js";

const RELAY_URL = "wss://direct.onmydisk.net:8765/gun";
const HUB_URL = "https://direct.onmydisk.net:8765";
const AUTH_URL = "https://direct.onmydisk.net:8765";
const STORAGE_PREFIX = "omd_did_";

function accountDeletedError() {
  return new Error(translate("account_deleted_login", {}, "This account has been deleted."));
}

/**
 * Persistent identity — did:gun:<pub> backed by GunDB SEA.
 *
 * Flow:
 *   1. Google OAuth → server verifies → returns { certificate, mainPub, did }
 *   2. Device generates local keypair (SEA.pair)
 *   3. Stores devicePair + certificate in localStorage
 *   4. Connects to GunDB with device key (no master key on device)
 *   5. Reads ~{mainPub}/devices/ to show all user's devices
 *   6. Publishes own linkId into the same list
 */
export class PersistentIdentity {
  constructor() {
    /** @type {"persistent"} */
    this.type = "persistent";
    /** @type {import("gun/gun").GunChain} */
    this.gun = null;
    /** @type {string|null} master public key */
    this.mainPub = null;
    /** @type {string|null} did:gun:<pub> */
    this.did = null;
    /** @type {object|null} Gun.SEA keypair for this device */
    this.devicePair = null;
    /** @type {string|null} certificate from server */
    this.certificate = null;
    /** @type {string|null} hub-issued token authorising account deletion (provider logins) */
    this.deleteToken = null;
    /** @type {{name: string, user: string, email: string, image: string, omd_key: string}} user profile */
    this.profile = { name: "", user: "", email: "", image: "", omd_key: "", defaultStorage: "", locale: "" };
    /** @type {Map<string,object>} devicePub → device info */
    this.devices = new Map();
    /** @type {Set<Function>} listeners for device list changes */
    this.listeners = new Set();
    /** @type {Set<Function>} listeners for profile updates */
    this.profileListeners = new Set();
    this._unsubscribes = [];
  }

  // ── Restore from localStorage ────────────────────────────────

  /** Gun SEA pubkey of this device (bound to the DID at first node pairing). */
  get devicePub() {
    return (this.devicePair && this.devicePair.pub) ? this.devicePair.pub : "";
  }

  /**
   * Signs a DID pairing proof. Uses the DID master key when it is in memory
   * (right after a username/password login), otherwise falls back to the
   * device key certified by the DID.
   * @param {string} msg — message to sign
   * @returns {Promise<string|null>} the SEA signed string or null
   */
  async signProof(msg) {
    try {
      const u = this.gun && this.gun.user && this.gun.user();
      const master = u && u._ && u._.sea;
      if (master && master.priv) {
        return await Gun.SEA.sign(msg, master);
      }
    } catch (e) { console.warn("[identity] master sign fallback:", e); }
    try {
      if (this.devicePair && this.devicePair.priv) {
        return await Gun.SEA.sign(msg, this.devicePair);
      }
    } catch (e) { console.warn("[identity] device sign failed:", e); }
    return null;
  }

  async init() {
    const saved = this._loadLocal();
    if (!saved) {
      console.log("[identity] no persistent session found");
      return null;
    }

    this.mainPub = saved.mainPub;
    this.did = saved.did || (saved.mainPub ? `did:gun:${saved.mainPub}` : null);
    this.devicePair = saved.devicePair;
    this.certificate = saved.certificate;
    this.deleteToken = saved.deleteToken || null;

    // Auto-heal typo DID migration (Zo05 -> ZoO5)
    if (this.mainPub === "Zo05-TlMwhs1avayTCM1a6iWxKPyylc1fzwbk2tlRWg.BebwN_5KtFhI4_SPImD1g4f6ElF4tHvZV0VpJxKWGSI") {
      console.log("[identity] Migrating typo canonical DID to correct canonical DID");
      this.mainPub = "ZoO5-TlMwhs1avayTCm1a6iWxKPyylc1fzWbk2tlRWg.BebwN_5KtFhI4_SPImD1g4f6ElF4tHvZV0VpJxKWGSI";
      this.did = `did:gun:${this.mainPub}`;
      if (typeof localStorage !== "undefined") {
        const oldKey = "omd_devices_Zo05-TlMwhs1avayTCM1a6iWxKPyylc1fzwbk2tlRWg.BebwN_5KtFhI4_SPImD1g4f6ElF4tHvZV0VpJxKWGSI";
        const oldDevs = localStorage.getItem(oldKey);
        if (oldDevs && !localStorage.getItem(`omd_devices_${this.mainPub}`)) {
          localStorage.setItem(`omd_devices_${this.mainPub}`, oldDevs);
        }
        localStorage.removeItem(oldKey);
      }
      this._saveLocal();
    }
    if (saved.profile) {
      this.profile = { ...this.profile, ...saved.profile };
    }
    const cachedDefaultStorage = typeof localStorage !== "undefined" ? localStorage.getItem("omd_default_storage") : "";
    if (cachedDefaultStorage && !this.profile.defaultStorage) {
      this.profile.defaultStorage = cachedDefaultStorage;
    }

    if (!this.mainPub && !this.devicePair) {
      console.warn("[identity] saved session invalid (missing mainPub and devicePair)");
      return null;
    }

    // Ensure we have a valid devicePair for Gun auth
    if (!this.devicePair || !this.devicePair.pub || !this.devicePair.priv) {
      console.warn("[identity] saved session missing valid devicePair, generating new pair for mainPub:", this.mainPub);
      this.devicePair = await Gun.SEA.pair();
      this._saveLocal();
    }

    // Ensure DID always has an omd_key
    if (!this.profile.omd_key) {
      const legacyKey = readLegacyStorage();
      this.profile.omd_key = legacyKey || generateOmdKey();
      this._saveLocal();
    }

    this.gun = Gun({ peers: [RELAY_URL], localStorage: false, radisk: false });

    // Auth with device pair (NOT the master key)
    const pair = this.devicePair;
    if (pair && pair.pub && pair.priv) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve();
        }, 3000);
        this.gun.user().auth(pair, (ack) => {
          clearTimeout(timer);
          if (ack && ack.err) console.warn("[identity] gun auth warn:", ack.err);
          resolve(ack);
        });
      });
    }

    // Reject restored sessions whose DID was deleted from another device.
    // If the hub is unreachable, keep the cached session for offline use.
    let checkTimer = null;
    try {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      if (controller) checkTimer = setTimeout(() => controller.abort(), 4000);
      const check = await fetch(AUTH_URL + "/api/auth/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mainPub: this.mainPub, devicePub: this.devicePub }),
        signal: controller ? controller.signal : undefined,
      });
      if (check.status === 410) {
        try { this.gun.user().leave(); } catch (_) {}
        this._clearLocal();
        this.mainPub = null;
        this.did = null;
        this.devicePair = null;
        this.certificate = null;
        this.deleteToken = null;
        return null;
      }
      if (check.ok) {
        const data = await check.json();
        if (data && data.certificate) {
          this.certificate = data.certificate;
          this._saveLocal();
        }
      }
    } catch (e) {
      console.warn("[identity] session check failed (offline?):", e && e.message ? e.message : e);
    } finally {
      if (checkTimer) clearTimeout(checkTimer);
    }

    await this._listenDevices();
    this._listenProfile();
    console.log("[identity] persistent session restored, did:", this.did, "profile:", this.profile);
    return this;
  }

  // ── Google OAuth login ───────────────────────────────────────

  /**
   * @param {string} idToken — Google id_token from GIS popup
   * @returns {Promise<PersistentIdentity>}
   */
  async googleLogin(idToken) {
    const devicePair = await Gun.SEA.pair();

    const resp = await fetch(AUTH_URL + "/api/auth/google-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idToken,
        mainPub: this.mainPub,        // null for first-time
        devicePub: devicePair.pub,
      }),
    });

    if (resp.status === 410) throw accountDeletedError();
    if (!resp.ok) throw new Error(`Auth failed: ${resp.status}`);
    const data = await resp.json();
    const { certificate, mainPub, did, profile, googleUser } = data;

    const omdKey = (profile && profile.omd_key) || data.token || data.omd_key || readLegacyStorage() || generateOmdKey();

    this.mainPub = mainPub;
    this.did = did;
    this.devicePair = devicePair;
    this.certificate = certificate;
    this.deleteToken = data.deleteToken || null;
    this.profile = {
      name: (profile && profile.name) || (googleUser?.name) || "",
      user: (profile && profile.user) || (googleUser?.email?.split('@')[0]) || "",
      email: (profile && profile.email) || (googleUser?.email) || "",
      image: (profile && profile.image) || (googleUser?.picture) || "",
      omd_key: omdKey,
      locale: (profile && profile.locale) || "",
    };

    this._saveLocal();

    this.gun = Gun({ peers: [RELAY_URL], localStorage: false, radisk: false });
    await new Promise((resolve) => {
      this.gun.user().auth(devicePair, (ack) => {
        if (ack.err) console.warn("[identity] gun auth warn:", ack.err);
        resolve(ack);
      });
    });

    this._listenDevices();
    this._listenProfile();
    console.log("[identity] google login complete, did:", did, "profile:", this.profile);
    return this;
  }

  // ── Apple Sign-In login ──────────────────────────────────────

  /**
   * @param {string} idToken — Apple identityToken (JWT)
   * @param {object} [user] — Optional Apple user object ({ name: { givenName, familyName }, email })
   * @returns {Promise<PersistentIdentity>}
   */
  async appleLogin(idToken, user = null) {
    const devicePair = await Gun.SEA.pair();

    const resp = await fetch(AUTH_URL + "/api/auth/apple-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idToken,
        mainPub: this.mainPub,        // null for first-time
        devicePub: devicePair.pub,
        user,
      }),
    });

    if (resp.status === 410) throw accountDeletedError();
    if (!resp.ok) {
      let errDetail = "";
      try {
        const errJson = await resp.json();
        errDetail = errJson.error || "";
      } catch (_) {}
      throw new Error(errDetail || `Apple auth failed: ${resp.status}`);
    }
    const data = await resp.json();
    const { certificate, mainPub, did, profile, appleUser } = data;

    const omdKey = (profile && profile.omd_key) || data.token || data.omd_key || readLegacyStorage() || generateOmdKey();

    this.mainPub = mainPub;
    this.did = did;
    this.devicePair = devicePair;
    this.certificate = certificate;
    this.deleteToken = data.deleteToken || null;
    this.profile = {
      name: (profile && profile.name) || (appleUser?.name) || "",
      user: (profile && profile.user) || (appleUser?.email?.split('@')[0]) || ("apple_" + (appleUser?.sub || "").slice(-8)),
      email: (profile && profile.email) || (appleUser?.email) || "",
      image: (profile && profile.image) || "",
      omd_key: omdKey,
      locale: (profile && profile.locale) || "",
    };

    this._saveLocal();

    this.gun = Gun({ peers: [RELAY_URL], localStorage: false, radisk: false });
    await new Promise((resolve) => {
      this.gun.user().auth(devicePair, (ack) => {
        if (ack.err) console.warn("[identity] gun auth warn:", ack.err);
        resolve(ack);
      });
    });

    this._listenDevices();
    this._listenProfile();
    console.log("[identity] apple login complete, did:", did, "profile:", this.profile);
    return this;
  }

  // ── Legacy account login ─────────────────────────────────────

  /**
   * @param {string} omdKey — legacy omd_key token
   * @returns {Promise<PersistentIdentity>}
   */
  async legacyLogin(omdKey) {
    const devicePair = await Gun.SEA.pair();

    const resp = await fetch(AUTH_URL + "/api/auth/legacy-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        omdKey,
        devicePub: devicePair.pub,
      }),
    });

    if (resp.status === 410) throw accountDeletedError();
    if (!resp.ok) throw new Error(`Legacy auth failed: ${resp.status}`);
    const data = await resp.json();
    const { certificate, mainPub, did, profile } = data;

    this.mainPub = mainPub;
    this.did = did;
    this.devicePair = devicePair;
    this.certificate = certificate;
    this.profile = {
      name: (profile && profile.name) || "",
      user: (profile && profile.user) || "",
      email: (profile && profile.email) || "",
      image: (profile && profile.image) || "",
      omd_key: omdKey,
      locale: (profile && profile.locale) || "",
    };

    this._saveLocal();

    this.gun = Gun({ peers: [RELAY_URL], localStorage: false, radisk: false });
    await new Promise((resolve) => {
      this.gun.user().auth(devicePair, (ack) => {
        if (ack.err) console.warn("[identity] gun auth warn:", ack.err);
        resolve(ack);
      });
    });

    this._listenDevices();
    this._listenProfile();
    console.log("[identity] legacy login complete, did:", did, "profile:", this.profile);
    return this;
  }

  /**
   * Register a new account with alias + password + email + optional avatar.
   *
   * Flow:
   *   1. gun.user().create(alias, password) — generates master keypair
   *   2. Generate device keypair
   *   3. POST /api/auth/register { mainPub, devicePub, email }
   *   4. Return DID + recovery key (master public key)
   *
   * @param {string} alias — username
   * @param {string} password — password (min 8 chars for SEA)
   * @param {string|null} email — email for recovery (optional but recommended)
   * @param {string} [image] — base64 avatar image (optional)
   * @param {string} [locale] — preferred interface language code
   * @returns {Promise<{did: string, recoveryKey: string, mainPub: string, certificate: string, devicePair: object, profile: object}>}
   */
  async register(alias, password, email, image = "", locale = "") {
    if (!this.gun) {
      this.gun = Gun({ peers: [RELAY_URL], localStorage: false, radisk: false });
    }

    const cleanAlias = (alias || "").trim();
    const normalizedAlias = cleanAlias.toLowerCase();
    const cleanPassword = password || "";

    // Create new GunDB user (generates master keypair)
    const pair = await new Promise((resolve, reject) => {
      this.gun.user().create(normalizedAlias, cleanPassword, (ack) => {
        if (ack.err) return reject(new Error(ack.err));
        resolve(this.gun.user()._.sea || ack.sea || { pub: ack.pub });
      });
      setTimeout(() => reject(new Error('Create timeout')), 6000);
    });

    if (!pair || !pair.pub) throw new Error('Failed to create account');

    // Authenticate with the newly created master user
    await new Promise((resolve, reject) => {
      this.gun.user().auth(normalizedAlias, cleanPassword, (ack) => {
        if (ack.err) return reject(new Error(ack.err));
        resolve(this.gun.user()._.sea || ack.sea);
      });
      setTimeout(() => reject(new Error('Auth timeout')), 5000);
    });

    const mainPub = pair.pub;

    // Generate local device keypair for this browser session
    const devicePair = await Gun.SEA.pair();

    // Auto-generate omd_key for the new DID so it is NEVER empty
    const generatedKey = generateOmdKey();

    // Register with server (email mapping + certificate for devicePub)
    const resp = await fetch(AUTH_URL + "/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mainPub,
        devicePub: devicePair.pub,
        email: email || null,
        omdKey: generatedKey,
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Registration failed: ${resp.status}`);
    }
    const respData = await resp.json();
    const { certificate, did } = respData;
    const finalOmdKey = respData.omd_key || generatedKey;

    this.mainPub = mainPub;
    this.did = did;
    this.devicePair = devicePair;
    this.certificate = certificate;
    const activeLocale = locale || (typeof localStorage !== "undefined" ? localStorage.getItem("omd_locale") : "") || "en";
    this.profile = {
      name: cleanAlias,
      user: normalizedAlias,
      email: email || "",
      image: image || "",
      omd_key: finalOmdKey,
      locale: activeLocale,
    };

    this._saveLocal();

    if (this.gun.user() && this.gun.user().is) {
      this.gun.user().get("profile").put({
        name: this.profile.name,
        user: this.profile.user,
        email: this.profile.email,
        image: this.profile.image,
        omd_key: this.profile.omd_key,
        locale: this.profile.locale,
        updatedAt: Date.now(),
      });
    }

    this._listenDevices();
    this._listenProfile();

    // Generate recovery key (public key as hex groups)
    const recoveryKey = pair.pub.match(/.{1,4}/g).join(' ');

    console.log("[identity] registered:", cleanAlias, did, "profile:", this.profile);
    return { did, recoveryKey, mainPub: pair.pub, certificate, devicePair: pair, profile: this.profile };
  }

  // ── Password login / registration ─────────────────────────────

  /**
   * Login with alias + password.
   *
   * Flow:
   *   1. Try native GunDB SEA auth first (existing GunDB user - same DID every time!)
   *   2. Fallback to legacy gateway check & auto-create permanent Gun user
   *
   * @param {string} alias — username
   * @param {string} password — password (min 8 chars for SEA)
   * @returns {Promise<PersistentIdentity>}
   */
  async passwordLogin(alias, password) {
    const cleanAlias = (alias || "").trim();
    const normalizedAlias = cleanAlias.toLowerCase();
    const cleanPassword = password || "";

    if (!this.gun) {
      this.gun = Gun({ peers: [RELAY_URL], localStorage: false, radisk: false });
    }

    let pair = null;
    let mainPub = null;
    let profileData = null;
    let certificate = null;
    let did = null;

    // Helper to attempt Gun auth with direct SEA resolution and timeout
    const tryGunAuth = (user, pass, timeoutMs = 6000) => {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error('GunDB auth timeout'));
          }
        }, timeoutMs);

        const done = (err, res) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(err instanceof Error ? err : new Error(err));
          else resolve(res);
        };

        try {
          if (this.gun && this.gun.user && this.gun.user().is) {
            this.gun.user().leave();
          }
        } catch (_) {}

        if (!this.gun) {
          this.gun = Gun({ peers: [RELAY_URL], localStorage: false, radisk: false });
        }

        // Direct SEA resolution avoids Gun's bug where nodes with sub-properties
        // (devices, keys, profile) omit `pub` from the wire chunk and cause recursive hangs.
        const cleanUser = (user || "").trim();
        let directPub = null;
        const stripped = cleanUser.startsWith("~") ? cleanUser.slice(1) : cleanUser;
        if (stripped.includes(".") && stripped.length > 50) {
          directPub = stripped;
        }

        const resolveWithPubs = (pubs) => {
          if (!pubs || pubs.length === 0) {
            this.gun.user().auth(user, pass, (ack) => {
              if (settled) return;
              if (ack.err) return done(new Error(ack.err));
              done(null, this.gun.user()._.sea || ack.sea || (ack.put && ack.put.sea));
            });
            return;
          }

          let checked = 0;
          let wrongCount = 0;

          for (const pub of pubs) {
            const userNode = this.gun.get("~" + pub);
            userNode.get("auth").once(async (auth) => {
              if (settled) return;
              if (!auth) {
                checked++;
                if (checked >= pubs.length && wrongCount === 0) {
                  this.gun.user().auth(user, pass, (ack) => {
                    if (settled) return;
                    if (ack.err) return done(new Error(ack.err));
                    done(null, this.gun.user()._.sea || ack.sea || (ack.put && ack.put.sea));
                  });
                }
                return;
              }

              const authObj = typeof auth === "string" ? (JSON.parse(auth) || {}) : auth;
              if (!authObj.s || !authObj.ek) {
                checked++;
                return;
              }

              try {
                const proof = await Gun.SEA.work(pass, authObj.s);
                const dec = await Gun.SEA.decrypt(authObj.ek, proof);
                if (dec && dec.priv) {
                  // Password matches! Fetch epub and authenticate locally with full pair
                  let epubDone = false;
                  const epubTimer = setTimeout(() => {
                    if (epubDone || settled) return;
                    epubDone = true;
                    const pair = {
                      pub,
                      priv: dec.priv,
                      epriv: dec.epriv,
                      epub: dec.epub,
                    };
                    this.gun.user().auth(pair, (ack) => {
                      if (settled) return;
                      if (ack.err) return done(new Error(ack.err));
                      done(null, pair);
                    });
                  }, 1500);

                  userNode.get("epub").once((epub) => {
                    if (epubDone || settled) return;
                    epubDone = true;
                    clearTimeout(epubTimer);
                    const pair = {
                      pub,
                      priv: dec.priv,
                      epriv: dec.epriv,
                      epub: epub || dec.epub,
                    };
                    this.gun.user().auth(pair, (ack) => {
                      if (settled) return;
                      if (ack.err) return done(new Error(ack.err));
                      done(null, pair);
                    });
                  });
                } else {
                  checked++;
                  wrongCount++;
                  if (checked >= pubs.length) {
                    done(new Error("Wrong user or password."));
                  }
                }
              } catch (e) {
                checked++;
                wrongCount++;
                if (checked >= pubs.length) {
                  done(new Error("Wrong user or password."));
                }
              }
            });
          }
        };

        if (directPub) {
          resolveWithPubs([directPub]);
        } else {
          this.gun.get("~@" + cleanUser).once((data) => {
            if (settled) return;
            if (!data) {
              return resolveWithPubs([]);
            }
            const pubs = [];
            for (const k of Object.keys(data)) {
              if (k === "_" || !k) continue;
              let p = k;
              if (p.startsWith("~")) p = p.slice(1);
              if (data[k] && typeof data[k] === "object" && data[k]["#"]) {
                let ref = data[k]["#"];
                if (ref.startsWith("~")) ref = ref.slice(1);
                if (ref) p = ref;
              }
              if (p && !pubs.includes(p)) pubs.push(p);
            }
            resolveWithPubs(pubs);
          });
        }
      });
    };

    const devicePair = await Gun.SEA.pair();

    // 1. Gateway is the SINGLE source of truth for "username+password → DID".
    //    The same legacy credentials must ALWAYS resolve to the same DID —
    //    never mint a new DID on login.
    let gatewayOk = false;
    let gatewayRejected = false;
    let gatewayDeleted = false;
    try {
      const resp = await fetch(AUTH_URL + "/api/auth/gateway-signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: cleanAlias, password: cleanPassword, devicePub: devicePair.pub }),
      });

      if (resp.status === 401) {
        gatewayRejected = true;
      }
      if (resp.status === 410) {
        gatewayDeleted = true;
      }

      if (resp.ok) {
        const gatewayData = await resp.json();
        if (gatewayData && (gatewayData.valid || gatewayData.mainPub || gatewayData.certificate)) {
          gatewayOk = true;
          profileData = gatewayData.profile || {};
          const keyToken = gatewayData.token || profileData.omd_key || (gatewayData.profile && gatewayData.profile.omd_key);
          if (keyToken) profileData.omd_key = keyToken;

          if (gatewayData.mainPub) mainPub = gatewayData.mainPub;
          if (gatewayData.certificate) certificate = gatewayData.certificate;
          if (gatewayData.did) did = gatewayData.did;
        }
      } else {
        console.log("[identity] gateway does not recognize user, checking native GunDB:", cleanAlias, resp.status);
      }
    } catch (gwErr) {
      console.warn("[identity] gateway-signin unreachable:", gwErr.message);
    }

    // 2. Native GunDB auth — for gun-native DIDs (created from scratch) or when
    //    the gateway could not resolve. It is authoritative ONLY if the gateway
    //    did not provide a DID; otherwise the gateway DID wins.
    let gunTimeoutError = false;
    try {
      pair = await tryGunAuth(normalizedAlias, cleanPassword);
      if (pair && pair.pub) {
        if (!mainPub) {
          mainPub = pair.pub;
          console.log("[identity] resolved GunDB DID via native auth:", mainPub);
        } else {
          console.log("[identity] gateway DID wins over native gun pair:", mainPub);
        }
      }
    } catch (e1) {
      if (cleanAlias !== normalizedAlias) {
        try {
          pair = await tryGunAuth(cleanAlias, cleanPassword, 3000);
          if (pair && pair.pub && !mainPub) {
            mainPub = pair.pub;
          }
        } catch (_) {}
      }
      if (!mainPub) {
        console.log("[identity] native GunDB auth not found:", e1.message);
      }
      
      // Store the specific GunDB error to show a better message
      if (!mainPub && e1.message === "GunDB auth timeout") {
        gunTimeoutError = true;
      }
    }

    if (!mainPub) {
      if (gatewayDeleted) {
        throw accountDeletedError();
      }
      if (gunTimeoutError) {
        throw new Error(
          gatewayRejected 
            ? "DID account not found on network (timeout), and gateway password incorrect." 
            : "DID account not found on network (timeout). It may have been lost or not fully synced."
        );
      }
      throw new Error(
        gatewayRejected
          ? "Invalid username or password"
          : (gatewayOk ? "Authentication failed" : "Unknown user. Please create a new DID.")
      );
    }

    // 3. Device identity & certificate.
    //    - Gateway path: the device pair is the one the cert was issued for.
    //    - Gun-native path: fall back to the master pair and link it.
    if (!certificate) {
      const linkResp = await fetch(AUTH_URL + "/api/auth/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mainPub, devicePub: (pair && pair.pub) || devicePair.pub }),
      });
      if (linkResp.status === 410) throw accountDeletedError();
      if (!linkResp.ok) throw new Error(`Link failed: ${linkResp.status}`);
      const { certificate: linkCert, did: linkDid } = await linkResp.json();
      certificate = linkCert;
      if (linkDid) did = linkDid;
    }

    const resolvedKey = (profileData && profileData.omd_key) || readLegacyStorage() || generateOmdKey();
    this.mainPub = mainPub;
    this.did = did || ('did:gun:' + mainPub);
    this.devicePair = gatewayOk ? devicePair : (pair || devicePair);
    this.certificate = certificate;
    this.profile = {
      name: (profileData && (profileData.name || profileData.displayname)) || cleanAlias,
      user: (profileData && profileData.user) || normalizedAlias,
      email: (profileData && profileData.email) || "",
      image: (profileData && (profileData.image || profileData.profileimage || profileData.avatar)) || "",
      omd_key: resolvedKey,
      locale: (profileData && profileData.locale) || "",
    };

    this._saveLocal();

    if (!this.gun) {
      this.gun = Gun({ peers: [RELAY_URL], localStorage: false, radisk: false });
    }
    await new Promise((resolve) => {
      this.gun.user().auth(this.devicePair, (ack) => {
        if (ack.err) console.warn("[identity] gun auth warn:", ack.err);
        resolve(ack);
      });
    });

    await this._listenDevices();
    this._listenProfile();
    console.log("[identity] login complete, permanent did:", this.did, "profile:", this.profile);
    return this;
  }

  /**
   * Re-issues the device certificate from the hub (no re-login required).
   * Needed when the hub's certificate path allowlist grows (e.g. new
   * `sharedToMe` namespace) or the previous certificate has expired.
   *
   * @returns {Promise<string|null>} fresh certificate
   */
  async refreshCertificate() {
    if (!this.mainPub || !this.devicePair || !this.devicePair.pub) {
      throw new Error("Identity not linked (missing mainPub/devicePair)");
    }
    // The hub is a single central service on the gateway: device registry,
    // GunDB relay and all device graph writes go through it regardless of
    // the page origin (vite/localhost, node-served PWA, native app webview).
    const hubUrl = HUB_URL;

    const resp = await fetch(`${hubUrl}/api/auth/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mainPub: this.mainPub, devicePub: this.devicePair.pub }),
    });
    if (!resp.ok) throw new Error(`Certificate refresh failed: ${resp.status}`);
    const { certificate } = await resp.json();
    if (!certificate) throw new Error("Certificate refresh returned no certificate");
    this.certificate = certificate;
    this._saveLocal();
    console.info("[identity] device certificate refreshed");
    return certificate;
  }

  /**
   * Restore identity using a master public key / recovery key.
   */
  async restoreFromRecoveryKey(recoveryKey, alias = "") {
    const cleanKey = recoveryKey.replace(/\s+/g, "").trim();
    if (!cleanKey || cleanKey.length < 10) {
      throw new Error("Invalid recovery key");
    }

    const mainPub = cleanKey.startsWith("did:gun:") ? cleanKey.replace("did:gun:", "") : cleanKey;
    const devicePair = await Gun.SEA.pair();

    const resp = await fetch(AUTH_URL + "/api/auth/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mainPub, devicePub: devicePair.pub }),
    });
    if (!resp.ok) throw new Error(`Recovery link failed: ${resp.status}`);
    const { certificate, did } = await resp.json();

    this.mainPub = mainPub;
    this.did = did;
    this.devicePair = devicePair;
    this.certificate = certificate;
    this.profile = {
      name: alias || "Restored User",
      user: alias || "user",
      email: "",
      image: "",
      omd_key: readLegacyStorage() || generateOmdKey(),
      locale: "",
    };

    this._saveLocal();

    this.gun = Gun({ peers: [RELAY_URL], localStorage: false, radisk: false });
    await new Promise((resolve) => {
      this.gun.user().auth(devicePair, (ack) => {
        if (ack.err) console.warn("[identity] gun auth warn:", ack.err);
        resolve(ack);
      });
    });

    this._listenDevices();
    this._listenProfile();
    console.log("[identity] restored from recovery key, did:", did);
    return this;
  }

  // ── Profile management ───────────────────────────────────────

  /**
   * Subscribe to profile changes.
   * @param {Function} callback — called with profile object { name, user, email, image }
   * @returns {Function} unsubscribe
   */
  subscribeProfile(callback) {
    this.profileListeners.add(callback);
    if (this.profile) {
      callback({ ...this.profile });
    }
    return () => this.profileListeners.delete(callback);
  }

  /**
   * Update profile fields and sync to GunDB graph ~mainPub/profile.
   * @param {Partial<{name: string, user: string, email: string, image: string}>} updates
   */
  async updateProfile(updates) {
    this.profile = {
      ...this.profile,
      ...updates,
      updatedAt: Date.now(),
    };

    if (updates.defaultStorage && typeof localStorage !== "undefined") {
      try {
        localStorage.setItem("omd_default_storage", updates.defaultStorage);
      } catch (_) {}
    }

    this._saveLocal();
    this._notifyProfile();

    if (this.gun) {
      const data = {
        name: this.profile.name,
        user: this.profile.user,
        email: this.profile.email,
        image: this.profile.image,
        omd_key: this.profile.omd_key,
        defaultStorage: this.profile.defaultStorage || "",
        locale: this.profile.locale || "",
        updatedAt: this.profile.updatedAt || Date.now(),
      };

      if (this.gun.user() && this.gun.user().is) {
        this.gun.user().get("profile").put(data);
      }
      if (this.mainPub) {
        const putOptions = this.certificate ? { opt: { cert: this.certificate } } : {};
        this.gun
          .get("~" + this.mainPub)
          .get("profile")
          .put(data, null, putOptions);
      }
    }

    return this.profile;
  }

  /**
   * Request primary email change with verification link.
   * @param {string} newEmail
   */
  async requestEmailChange(newEmail) {
    if (!newEmail || !newEmail.includes("@")) {
      throw new Error("Please enter a valid email address");
    }

    const resp = await fetch(AUTH_URL + "/api/auth/request-email-change", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mainPub: this.mainPub,
        newEmail,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Email change request failed: ${resp.status}`);
    }

    const data = await resp.json();
    return data;
  }

  // ── Device list ──────────────────────────────────────────────

  /**
   * Subscribe to ~{mainPub}/devices/ changes.
   * @param {Function} callback — called with array of device objects
   * @returns {Function} unsubscribe
   */
  subscribeDeviceList(callback) {
    this.listeners.add(callback);
    // Emit current state immediately
    if (this.devices.size > 0) {
      callback(this._deviceArray());
    }
    return () => this.listeners.delete(callback);
  }

  /** Publish this device's linkId into the user's GunDB devices list. */
  async publishDevice(linkId, name, type = "node", capabilities = ["files", "terminal"]) {
    if (!linkId) return;

    const deviceEntry = {
      linkId,
      name: name || linkId,
      type,
      devicePub: (this.devicePair && this.devicePair.pub) || linkId,
      online: true,
      lastSeen: Date.now(),
      capabilities,
    };

    // 1. Update memory & localStorage immediately
    this.devices.set(linkId, deviceEntry);
    this._saveLocalDevices();
    this._notify();

    // 2. Publish to GunDB graph via REST endpoint for guaranteed server-side persistence & relay broadcast
    // The hub is a single central service on the gateway: device registry,
    // GunDB relay and all device graph writes go through it regardless of
    // the page origin (vite/localhost, node-served PWA, native app webview).
    const hubUrl = HUB_URL;

    if (this.mainPub) {
      try {
        fetch(`${hubUrl}/api/publish-device`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mainPub: this.mainPub, device: deviceEntry })
        }).catch(e => console.warn("[identity] hub /api/publish-device error:", e));
      } catch (e) {}
    }


    // 3. Publish to GunDB graph locally
    if (this.gun) {
      const data = {
        linkId,
        name: name || linkId,
        type,
        devicePub: (this.devicePair && this.devicePair.pub) || linkId,
        online: true,
        last_seen: Date.now(),
        capabilities: Array.isArray(capabilities) ? capabilities.join(",") : (capabilities || ""),
      };

      const putOptions = this.certificate ? { opt: { cert: this.certificate } } : {};

      if (this.gun.user() && this.gun.user().is) {
        this.gun.user().get("devices").get(linkId).put(data);
      }
      if (this.mainPub) {
        this.gun.get("~" + this.mainPub).get("devices").get(linkId).put(data, null, putOptions);
        this.gun.get("devices:" + this.mainPub).get(linkId).put(data);
      }
    }
  }

  /** Remove / forget a device from the user's GunDB graph and local cache. */
  async removeDevice(linkId) {
    if (!linkId) return;

    this.devices.delete(linkId);
    this._saveLocalDevices();
    this._notify();

    // The hub is a single central service on the gateway: device registry,
    // GunDB relay and all device graph writes go through it regardless of
    // the page origin (vite/localhost, node-served PWA, native app webview).
    const hubUrl = HUB_URL;

    if (this.mainPub) {
      try {
        fetch(`${hubUrl}/api/remove-device`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mainPub: this.mainPub, linkId })
        }).catch(e => console.warn("[identity] hub /api/remove-device error:", e));
      } catch (e) {}
    }


    if (this.gun) {
      const putOptions = this.certificate ? { opt: { cert: this.certificate } } : {};
      if (this.gun.user() && this.gun.user().is) {
        this.gun.user().get("devices").get(linkId).put(null);
      }
      if (this.mainPub) {
        this.gun.get("~" + this.mainPub).get("devices").get(linkId).put(null, null, putOptions);
        this.gun.get("devices:" + this.mainPub).get(linkId).put(null);
      }
    }
  }

  // ── Logout / destroy ─────────────────────────────────────────

  /**
   * Best-effort removal of signed profile/device nodes using this device's
   * certificate. Runs after the hub has tombstoned the account.
   */
  async _purgeGraphAfterDeletion() {
    if (!this.gun || !this.mainPub) return;
    const mainPub = this.mainPub;
    const putOptions = this.certificate ? { opt: { cert: this.certificate } } : {};

    const write = (chain, opts) => new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      setTimeout(finish, 1500);
      try { chain.put(null, () => finish(), opts); } catch (_) { finish(); }
    });

    const pending = [];
    for (const key of ["profile", "did", "settings", "prompts", "sharing", "sharedToMe"]) {
      pending.push(write(this.gun.get("~" + mainPub).get(key), putOptions));
    }

    // Registration mappings are public nodes; remove them here as a fallback
    // in case the hub's cleanup could not reach the relay.
    const alias = ((this.profile && this.profile.user) || "").toLowerCase().trim();
    if (alias) pending.push(write(this.gun.get("~@" + alias).get("~" + mainPub)));
    const email = ((this.profile && this.profile.email) || "").toLowerCase().trim();
    if (email && email.includes("@")) pending.push(write(this.gun.get("~@email:" + email)));
    const omdKey = (this.profile && this.profile.omd_key) || "";
    if (omdKey) pending.push(write(this.gun.get("~@legacy:" + omdKey)));

    const linkIds = new Set();
    if (this.devicePair && this.devicePair.pub) linkIds.add(this.devicePair.pub);
    for (const linkId of this.devices.keys()) linkIds.add(linkId);
    for (const linkId of linkIds) {
      pending.push(write(this.gun.get("~" + mainPub).get("devices").get(linkId), putOptions));
      pending.push(write(this.gun.get("devices:" + mainPub).get(linkId)));
    }

    await Promise.all(pending);
  }

  /**
   * Permanently delete this account on the hub (tombstone + credential and
   * registration-record purge). For provider (Google/Apple) accounts the
   * hub-issued delete token proves ownership; password accounts must pass
   * their password.
   *
   * The local session is cleared only after the hub confirms deletion.
   * @param {{password?: string}} [options]
   * @returns {Promise<boolean>}
   */
  async deleteAccount({ password = "" } = {}) {
    if (!this.mainPub) throw new Error("No account is signed in");

    const resp = await fetch(AUTH_URL + "/api/auth/delete-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mainPub: this.mainPub,
        username: (this.profile && this.profile.user) || "",
        password: password || "",
        deleteToken: this.deleteToken || "",
      }),
    });

    if (!resp.ok) {
      let message = `Account deletion failed: ${resp.status}`;
      try {
        const err = await resp.json();
        if (err && err.error) message = err.error;
      } catch (_) {}
      throw new Error(message);
    }

    // The hub has already tombstoned the DID and removed registration
    // records. Best-effort remove the signed profile/device nodes while this
    // device still holds a certificate for them. Authentication is already
    // blocked server-side, so failure here is not fatal.
    try { await this._purgeGraphAfterDeletion(); } catch (_) {}

    // For password accounts, authenticate as the master user and remove the
    // Gun alias mapping plus credentials. This is what allows the same
    // username to be registered again after deletion.
    const alias = ((this.profile && this.profile.user) || "").toLowerCase().trim();
    const mainPub = this.mainPub;
    if (password && alias && mainPub && this.gun) {
      try { this.gun.user().leave(); } catch (_) {}
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        const timer = setTimeout(finish, 6000);
        try {
          this.gun.user().auth(alias, password, (ack) => {
            clearTimeout(timer);
            try { this.gun.get("~@" + alias).get("~" + mainPub).put(null, () => {}); } catch (_) {}
            try { this.gun.user().get("auth").put(null, () => {}); } catch (_) {}
            try { this.gun.user().get("epub").put(null, () => {}); } catch (_) {}
            try { this.gun.user().get("profile").put(null, () => {}); } catch (_) {}
            finish();
          });
        } catch (_) {
          clearTimeout(timer);
          finish();
        }
      });
      try { this.gun.user().leave(); } catch (_) {}
    }

    // Leave the Gun session without writing anything back to the graph.
    try { if (this.gun && this.gun.user) this.gun.user().leave(); } catch (_) {}
    try { localStorage.removeItem(`omd_devices_${this.mainPub}`); } catch (_) {}
    this._clearLocal();

    this.mainPub = null;
    this.did = null;
    this.devicePair = null;
    this.certificate = null;
    this.deleteToken = null;
    this.profile = { name: "", user: "", email: "", image: "", omd_key: "", defaultStorage: "", locale: "" };
    this.devices.clear();
    this._notify();
    this._notifyProfile();
    return true;
  }

  async logout() {
    if (this.gun) {
      // Mark this device offline before leaving
      if (this.mainPub && this.devicePair) {
        try {
          if (this.gun.user() && this.gun.user().is) {
            this.gun.user().get("devices").get(this.devicePair.pub).get("online").put(false);
          }
        } catch (_) {}
      }
      try { this.gun.user().leave(); } catch (_) {}
    }
    this._clearLocal();
    this.mainPub = null;
    this.did = null;
    this.devicePair = null;
    this.certificate = null;
    this.deleteToken = null;
    this.profile = { name: "", user: "", email: "", image: "" };
    this.devices.clear();
    this._notify();
    this._notifyProfile();
  }

  destroy() {
    for (const unsub of this._unsubscribes) {
      if (typeof unsub === "function") {
        try { unsub(); } catch (_) {}
      } else if (unsub && typeof unsub.off === "function") {
        try { unsub.off(); } catch (_) {}
      }
    }
    this._unsubscribes = [];
    if (this.gun) {
      try { this.gun.user().leave(); } catch (_) {}
      this.gun = null;
    }
  }

  // ── Private helpers ──────────────────────────────────────────

  _loadLocalDevices() {
    if (!this.mainPub) return;
    try {
      const raw = localStorage.getItem(`omd_devices_${this.mainPub}`);
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const dev of list) {
            if (dev && dev.linkId) {
              this.devices.set(dev.linkId, dev);
            }
          }
        }
      }
    } catch (_) {}
  }

  _saveLocalDevices() {
    if (!this.mainPub) return;
    try {
      const arr = this._deviceArray();
      localStorage.setItem(`omd_devices_${this.mainPub}`, JSON.stringify(arr));
    } catch (_) {}
  }

  async _listenDevices() {
    if (!this.mainPub) return;

    // Load instantly from localStorage first
    this._loadLocalDevices();
    if (this.devices.size > 0) {
      this._notify();
    }

    // Also fetch via REST from Hub for instant sync in new browsers / after reload
    // The hub is a single central service on the gateway: device registry,
    // GunDB relay and all device graph writes go through it regardless of
    // the page origin (vite/localhost, node-served PWA, native app webview).
    const hubUrl = HUB_URL;

    try {
      const fetchPromise = fetch(`${hubUrl}/api/devices?mainPub=${encodeURIComponent(this.mainPub)}`)
        .then(r => r.ok ? r.json() : null);
      const toPromise = new Promise(r => setTimeout(() => r(null), 1200));
      const json = await Promise.race([fetchPromise, toPromise]);
      if (json && Array.isArray(json.devices)) {
        let updated = false;
        for (const dev of json.devices) {
          if (dev && dev.linkId) {
            this.devices.set(dev.linkId, {
              devicePub: dev.devicePub || dev.linkId,
              linkId: dev.linkId,
              name: dev.name || dev.linkId,
              type: dev.type || "node",
              online: dev.online !== false,
              lastSeen: dev.lastSeen || dev.last_seen || Date.now(),
              capabilities: Array.isArray(dev.capabilities) ? dev.capabilities : (typeof dev.capabilities === "string" ? dev.capabilities.split(",") : ["files"]),
            });
            updated = true;
          }
        }
        if (updated) {
          this._saveLocalDevices();
          this._notify();
        }
      }
    } catch (e) {
      console.warn("[identity] hub fetch devices error:", e);
    }

    if (!this.gun) return;

    const handleDeviceData = (data, key) => {
      if (key === "_") return;
      if (!data || data === null || (typeof data === "object" && Object.keys(data).length <= 1 && data._)) {
        if (key && this.devices.has(key)) {
          this.devices.delete(key);
          this._saveLocalDevices();
          this._notify();
        }
        return;
      }
      if (!data.linkId) {
        if (key && this.devices.has(key)) {
          this.devices.delete(key);
          this._saveLocalDevices();
          this._notify();
        }
        return;
      }
      this.devices.set(data.linkId, {
        devicePub: data.devicePub || data.linkId,
        linkId: data.linkId,
        name: data.name || data.linkId,
        type: data.type || "node",
        online: data.online !== false,
        lastSeen: data.last_seen || data.lastSeen || Date.now(),
        capabilities: data.capabilities || ["files"],
      });
      this._saveLocalDevices();
      this._notify();
    };

    const sub1 = this.gun
      .get("~" + this.mainPub)
      .get("devices")
      .map()
      .on(handleDeviceData);

    const sub2 = this.gun
      .get("devices:" + this.mainPub)
      .map()
      .on(handleDeviceData);

    this._unsubscribes.push(sub1);
    this._unsubscribes.push(sub2);
  }

  _listenProfile() {
    if (!this.gun || !this.mainPub) return;

    const sub = this.gun
      .get("~" + this.mainPub)
      .get("profile")
      .on((data) => {
        if (!data) return;
        let changed = false;
        if (data.name && data.name !== this.profile.name) { this.profile.name = data.name; changed = true; }
        if (data.user && data.user !== this.profile.user) { this.profile.user = data.user; changed = true; }
        if (data.email && data.email !== this.profile.email) { this.profile.email = data.email; changed = true; }
        if (data.image && data.image !== this.profile.image) { this.profile.image = data.image; changed = true; }
        if (data.omd_key && data.omd_key !== this.profile.omd_key) { this.profile.omd_key = data.omd_key; changed = true; }
        if (data.locale && data.locale !== this.profile.locale) { this.profile.locale = data.locale; changed = true; }
        if (data.defaultStorage && data.defaultStorage !== this.profile.defaultStorage) {
          const localStored = typeof localStorage !== "undefined" ? localStorage.getItem("omd_default_storage") : "";
          const hasNewerLocal = localStored && (!data.updatedAt || (this.profile.updatedAt && this.profile.updatedAt > data.updatedAt));
          if (!hasNewerLocal) {
            this.profile.defaultStorage = data.defaultStorage;
            changed = true;
          }
        }
        if (changed) {
          this._saveLocal();
          this._notifyProfile();
        }
      });

    this._unsubscribes.push(sub);
  }

  _notifyProfile() {
    const p = { ...this.profile };
    for (const cb of this.profileListeners) {
      try { cb(p); } catch (e) { console.error("[identity] profile listener error:", e); }
    }
  }

  _notify() {
    const arr = this._deviceArray();
    for (const cb of this.listeners) {
      try { cb(arr); } catch (e) { console.error("[identity] listener error:", e); }
    }
  }

  _deviceArray() {
    return [...this.devices.values()];
  }

  // ── localStorage persistence ─────────────────────────────────

  _saveLocal() {
    const data = {
      mainPub: this.mainPub,
      did: this.did,
      devicePair: this.devicePair,
      certificate: this.certificate,
      deleteToken: this.deleteToken,
      profile: this.profile,
    };
    localStorage.setItem(STORAGE_PREFIX + "session", JSON.stringify(data));
  }

  _loadLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + "session");
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  _clearLocal() {
    localStorage.removeItem(STORAGE_PREFIX + "session");
  }
}
