/**
 * Custom Rich Web Push Notifications helper for Svar PWA.
 * Subscribes the browser/mobile PWA to the connected AI Node's VAPID push service
 * over P2P HttpDrive (or local fetch fallback) without requiring a centralized server.
 */

export function isWebPushSupported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function getBrowserPushSubscription() {
  if (!isWebPushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch (_) {
    return null;
  }
}

export async function subscribeToNodeWebPush({
  fetchFn,
  omdKey = "",
  defaultStorage = "",
  deviceLabel = ""
}) {
  if (!isWebPushSupported()) {
    throw new Error("Браузер не поддерживает Web Push уведомления (на iOS добавьте приложение на экран «Домой»).");
  }
  const effectiveFetch = fetchFn || ((p, opts) => window.fetch(p, opts));

  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    throw new Error("Разрешение на показ уведомлений отклонено в настройках браузера.");
  }

  const keyRes = await effectiveFetch("/push/vapid-key");
  if (!keyRes || !keyRes.ok) {
    throw new Error("Не удалось получить VAPID-ключ с AI-узла (проверьте подключение к узлу).");
  }
  const keyData = await keyRes.json();
  const publicKey = keyData && keyData.publicKey;
  if (!publicKey) {
    throw new Error("AI-узел вернул пустой VAPID-ключ.");
  }

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const appServerKey = urlBase64ToUint8Array(publicKey);

  if (sub) {
    // Check if existing subscription uses a different applicationServerKey
    try {
      const existingKey = sub.options && sub.options.applicationServerKey;
      if (existingKey) {
        const existingArr = new Uint8Array(existingKey);
        const mismatch =
          existingArr.length !== appServerKey.length ||
          existingArr.some((b, idx) => b !== appServerKey[idx]);
        if (mismatch) {
          await sub.unsubscribe();
          sub = null;
        }
      }
    } catch (_) {}
  }

  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appServerKey
    });
  }

  const subJson = sub.toJSON();
  const autoLabel =
    deviceLabel ||
    (/Android/i.test(navigator.userAgent)
      ? "Android PWA"
      : /iPhone|iPad/i.test(navigator.userAgent)
      ? "iOS PWA"
      : "Desktop Browser");

  const saveRes = await effectiveFetch("/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subscription: subJson,
      omd_key: omdKey || "",
      default_storage: defaultStorage || "",
      device_label: autoLabel
    })
  });
  if (!saveRes || !saveRes.ok) {
    throw new Error("Не удалось зарегистрировать Push-подписку на AI-узле.");
  }
  const saveData = await saveRes.json();
  try {
    localStorage.setItem("omd_webpush_enabled", "1");
  } catch (_) {}
  return { subscription: subJson, ...saveData };
}

export async function syncExistingWebPushSubscription({
  fetchFn,
  omdKey = "",
  defaultStorage = ""
}) {
  if (!isWebPushSupported()) return false;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  if (typeof localStorage !== "undefined" && localStorage.getItem("omd_webpush_enabled") !== "1") return false;
  try {
    const sub = await getBrowserPushSubscription();
    if (!sub || !fetchFn) return false;
    await fetchFn("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: sub.toJSON(),
        omd_key: omdKey || "",
        default_storage: defaultStorage || ""
      })
    });
    return true;
  } catch (_) {
    return false;
  }
}

export async function unsubscribeFromNodeWebPush({ fetchFn, omdKey = "" }) {
  const effectiveFetch = fetchFn || ((p, opts) => window.fetch(p, opts));
  const sub = await getBrowserPushSubscription();
  if (sub) {
    const endpoint = sub.endpoint;
    try {
      await effectiveFetch("/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint, omd_key: omdKey || "" })
      });
    } catch (_) {}
    try {
      await sub.unsubscribe();
    } catch (_) {}
  }
  try {
    localStorage.removeItem("omd_webpush_enabled");
  } catch (_) {}
  return true;
}

export async function sendTestNodeWebPush({ fetchFn, omdKey = "", defaultStorage = "" }) {
  const effectiveFetch = fetchFn || ((p, opts) => window.fetch(p, opts));
  const sub = await getBrowserPushSubscription();
  const res = await effectiveFetch("/push/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: sub ? sub.endpoint : "",
      omd_key: omdKey || "",
      default_storage: defaultStorage || ""
    })
  });
  if (!res || !res.ok) {
    throw new Error("Не удалось отправить тестовый Push.");
  }
  return await res.json();
}

