import { Capacitor } from "@capacitor/core";

export const GOOGLE_WEB_CLIENT_ID =
  "959849209352-vbi0vfimrqj904598felj8ieeb6to8s2.apps.googleusercontent.com";

const HUB_AUTH_URL = "https://direct.onmydisk.net:8765";
const MOBILE_BRIDGE_BASE_URL = "https://direct.onmydisk.net";

let socialLoginInitPromise = null;
let activeBridgeAbort = null;

export function isNativeMobilePlatform() {
  try {
    return Capacitor.isNativePlatform();
  } catch (_) {
    return false;
  }
}

export function isGoogleSignInCanceledError(err) {
  if (!err) return false;
  if (err.isUserCancel) return true;
  const msg = String(err.message || err.error || err.code || err).toLowerCase();
  return (
    msg.includes("cancel") ||
    msg.includes("user_canceled") ||
    msg.includes("getcredentialcancellationexception") ||
    msg.includes("activity_cancelled") ||
    msg === "16"
  );
}

function makeSessionId() {
  const bytes = new Uint8Array(24);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function openExternalAuthUrl(url, isSyncGesture = true) {
  try {
    const a = document.createElement("a");
    a.href = url;
    if (isSyncGesture) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try {
        document.body.removeChild(a);
      } catch (_) {}
    }, 300);
  } catch (_) {
    window.open(url, "_blank");
  }
}

async function ensureSocialLoginInitialized() {
  if (socialLoginInitPromise) return socialLoginInitPromise;
  socialLoginInitPromise = (async () => {
    const { SocialLogin } = await import("@capgo/capacitor-social-login");
    await SocialLogin.initialize({
      google: {
        webClientId: GOOGLE_WEB_CLIENT_ID,
      },
    });
    return SocialLogin;
  })().catch((err) => {
    socialLoginInitPromise = null;
    throw err;
  });
  return socialLoginInitPromise;
}

/**
 * Opens https://direct.onmydisk.net/?mobile_google_auth=<session> in the
 * system browser (Safari on iOS / Chrome on Android) and polls gun-hub for the
 * verified single-use Google ID token.
 *
 * Used automatically on untouched iOS 3.0 binaries (where SocialLogin is not
 * compiled in) and as a seamless fallback on Android if Play Services / GCP
 * SHA-1 credentials are unavailable.
 */
export function startBrowserGoogleOAuthBridge(isSyncGesture = true) {
  if (activeBridgeAbort) {
    try {
      activeBridgeAbort();
    } catch (_) {}
    activeBridgeAbort = null;
  }

  const session = makeSessionId();
  const lang = (typeof navigator !== "undefined" && navigator.language) ? navigator.language.slice(0, 5) : "en";
  const bridgeUrl = `${MOBILE_BRIDGE_BASE_URL}/?mobile_google_auth=${encodeURIComponent(session)}&lang=${encodeURIComponent(lang)}`;

  // Open synchronously before any await so iOS WKWebView never popup-blocks it
  openExternalAuthUrl(bridgeUrl, isSyncGesture);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let pollInFlight = false;
    const startedAt = Date.now();
    const timeoutMs = 3 * 60 * 1000;

    function cleanup() {
      settled = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onForeground);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onForeground);
      }
      if (activeBridgeAbort === abortFn) {
        activeBridgeAbort = null;
      }
    }

    function abortFn() {
      if (settled) return;
      cleanup();
      const cancelErr = new Error("Google sign-in canceled");
      cancelErr.isUserCancel = true;
      reject(cancelErr);
    }

    activeBridgeAbort = abortFn;

    async function pollOnce() {
      if (settled || pollInFlight) return;
      if (Date.now() - startedAt > timeoutMs) {
        cleanup();
        reject(new Error("Google sign-in timed out"));
        return;
      }
      pollInFlight = true;
      try {
        const resp = await fetch(
          `${HUB_AUTH_URL}/api/auth/mobile-oauth-poll?session=${encodeURIComponent(session)}&t=${Date.now()}`,
          { method: "GET", cache: "no-store" }
        );
        if (!resp.ok) return;
        const data = await resp.json();
        if (settled) return;
        if (data && data.pending === false && data.idToken) {
          cleanup();
          resolve(data.idToken);
        } else if (data && data.error) {
          cleanup();
          reject(new Error(data.error));
        }
      } catch (_) {
        // Network transition while switching between browser and app — keep polling
      } finally {
        pollInFlight = false;
      }
    }

    function onForeground() {
      if (!settled && (!document.hidden)) {
        pollOnce();
      }
    }

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onForeground);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onForeground);
    }

    timer = setInterval(pollOnce, 1200);
  });
}

/**
 * Signs in with Google on native Capacitor mobile platforms:
 * 1. Uses native @capgo/capacitor-social-login when compiled into the binary (Android 5336+).
 * 2. Falls back seamlessly to the system-browser bridge on https://direct.onmydisk.net
 *    when SocialLogin is absent (e.g. untouched iOS 3.0 release) or Play Services config fails.
 */
export async function signInWithGoogleMobile() {
  const hasNativeSocialPlugin =
    typeof Capacitor.isPluginAvailable === "function" &&
    Capacitor.isPluginAvailable("SocialLogin");

  if (!hasNativeSocialPlugin) {
    // Synchronous call preserves user gesture on iOS WKWebView
    return await startBrowserGoogleOAuthBridge(true);
  }

  try {
    const SocialLogin = await ensureSocialLoginInitialized();
    const res = await SocialLogin.login({
      provider: "google",
      options: {},
    });
    const idToken = res?.result?.idToken;
    if (idToken) {
      return idToken;
    }
    throw new Error("No idToken returned from native Google Sign-In");
  } catch (err) {
    if (isGoogleSignInCanceledError(err)) {
      throw err;
    }
    console.warn("[GoogleAuth] Native SocialLogin unavailable or unconfigured, falling back to browser OAuth bridge:", err?.message || err);
    return await startBrowserGoogleOAuthBridge(false);
  }
}

/**
 * Lightweight standalone Google OAuth bridge rendered when the system browser
 * opens https://direct.onmydisk.net/?mobile_google_auth=<session>.
 */
export function mountMobileGoogleBridgeIfRequested(targetEl) {
  if (typeof window === "undefined" || isNativeMobilePlatform()) return false;
  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch (_) {
    return false;
  }
  const session = (params.get("mobile_google_auth") || "").trim();
  if (!session || !/^[a-zA-Z0-9_-]{16,128}$/.test(session)) {
    return false;
  }

  const splash = document.getElementById("omd-app-splash");
  if (splash) splash.style.display = "none";

  const rawLang = (params.get("lang") || navigator.language || "en").toLowerCase();
  const isRu = rawLang.startsWith("ru") || rawLang.startsWith("uk") || rawLang.startsWith("be");
  const isSl = rawLang.startsWith("sl");

  const copy = isRu
    ? {
        title: "Вход в On My Disk",
        desc: "Выберите аккаунт Google, чтобы продолжить вход в мобильном приложении.",
        verifying: "Подтверждаем вход...",
        doneTitle: "Вход выполнен!",
        doneDesc: "Теперь просто вернитесь в приложение On My Disk — аккаунт подключится автоматически.",
        errPrefix: "Ошибка авторизации: ",
      }
    : isSl
    ? {
        title: "Prijava v On My Disk",
        desc: "Izberite račun Google za nadaljevanje prijave v mobilni aplikaciji.",
        verifying: "Preverjanje prijave...",
        doneTitle: "Prijava uspešna!",
        doneDesc: "Zdaj se vrnite v aplikacijo On My Disk — račun se bo povezal samodejno.",
        errPrefix: "Napaka pri prijavi: ",
      }
    : {
        title: "Sign in to On My Disk",
        desc: "Choose your Google account to complete sign-in in the mobile app.",
        verifying: "Verifying sign-in...",
        doneTitle: "Signed in!",
        doneDesc: "You can now switch back to the On My Disk app — your account will connect automatically.",
        errPrefix: "Sign-in error: ",
      };

  const prefersDark =
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;

  targetEl.innerHTML = `
    <div style="min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;font-family:'Inter',system-ui,-apple-system,sans-serif;background:${prefersDark ? "#101C22" : "#F6F8F9"};color:${prefersDark ? "#F1F5F9" : "#0F172A"};">
      <div style="width:100%;max-width:380px;background:${prefersDark ? "#182630" : "#FFFFFF"};border:1px solid ${prefersDark ? "rgba(255,255,255,0.1)" : "rgba(15,23,42,0.1)"};border-radius:18px;padding:32px 24px;box-shadow:0 16px 40px rgba(0,0,0,0.22);text-align:center;">
        <img src="/customtheme/onmydisk.svg" alt="On My Disk" style="width:52px;height:52px;margin:0 auto 16px;display:block;" />
        <h1 id="omd-bridge-title" style="font-size:20px;font-weight:700;margin:0 0 8px;">${copy.title}</h1>
        <p id="omd-bridge-desc" style="font-size:14px;line-height:1.5;margin:0 0 24px;color:${prefersDark ? "#94A3B8" : "#475569"};">${copy.desc}</p>
        <div id="omd-bridge-btn" style="display:flex;justify-content:center;min-height:44px;"></div>
        <p id="omd-bridge-status" style="font-size:13px;margin:16px 0 0;min-height:20px;color:${prefersDark ? "#38BDF8" : "#0284C7"};"></p>
      </div>
    </div>
  `;

  const btnHost = document.getElementById("omd-bridge-btn");
  const titleEl = document.getElementById("omd-bridge-title");
  const descEl = document.getElementById("omd-bridge-desc");
  const statusEl = document.getElementById("omd-bridge-status");

  async function onGoogleCred(resp) {
    if (!resp?.credential) return;
    if (btnHost) btnHost.style.display = "none";
    if (statusEl) statusEl.textContent = copy.verifying;
    try {
      const r = await fetch(`${HUB_AUTH_URL}/api/auth/mobile-oauth-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session, idToken: resp.credential }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      if (titleEl) {
        titleEl.textContent = "✓ " + copy.doneTitle;
        titleEl.style.color = prefersDark ? "#34D399" : "#059669";
      }
      if (descEl) descEl.textContent = copy.doneDesc;
      if (statusEl) statusEl.textContent = data.email || "";
      setTimeout(() => {
        try {
          window.close();
        } catch (_) {}
      }, 900);
    } catch (err) {
      if (btnHost) btnHost.style.display = "flex";
      if (statusEl) {
        statusEl.style.color = "#EF4444";
        statusEl.textContent = copy.errPrefix + (err?.message || String(err));
      }
    }
  }

  function initGsi() {
    if (!window.google?.accounts?.id) return false;
    window.google.accounts.id.initialize({
      client_id: GOOGLE_WEB_CLIENT_ID,
      callback: onGoogleCred,
      auto_select: false,
    });
    if (btnHost) {
      window.google.accounts.id.renderButton(btnHost, {
        type: "standard",
        theme: prefersDark ? "filled_black" : "outline",
        size: "large",
        width: 300,
        shape: "rectangular",
      });
    }
    try {
      window.google.accounts.id.prompt();
    } catch (_) {}
    return true;
  }

  if (!initGsi()) {
    let attempts = 0;
    const iv = setInterval(() => {
      attempts++;
      if (initGsi() || attempts > 50) {
        clearInterval(iv);
      }
    }, 120);
  }

  return true;
}

