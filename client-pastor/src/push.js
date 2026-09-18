import api from './api';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

/** Current permission state, or 'unsupported' if the browser can't do push at all. */
export function getPushSupportState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

/**
 * The active service worker registration, or a clear error.
 *
 * `navigator.serviceWorker.ready` never resolves when nothing has registered a
 * worker, which would leave the enable button spinning forever with no
 * explanation. Racing it against a timeout turns that silent hang into a message
 * the pastor can act on (reload the app).
 */
async function readyRegistration(timeoutMs = 10000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('The app is still installing its service worker. Reload the app and try again.')),
      timeoutMs
    );
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Re-registers this device's existing push subscription with the API: without
 * ever prompting.
 *
 * Called on every signed-in start, because a subscription can go stale without
 * the pastor doing anything: a shared device may hold a subscription tied to the
 * previous account, and the server prunes a subscription its push service has
 * dropped (410/404): after which there is nothing left to send to. Re-posting
 * the existing subscription is idempotent (the API upserts on endpoint), so the
 * alert path repairs itself on the next app open instead of needing a manual
 * toggle. Returns true when a live subscription is registered.
 */
export async function syncPushSubscription() {
  if (getPushSupportState() !== 'granted') return false;
  try {
    const registration = await readyRegistration();
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const { data } = await api.get('/push/vapid-public-key');
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(data.publicKey),
      });
    }
    await api.post('/push/subscribe', subscription.toJSON());
    return true;
  } catch (err) {
    // Never fatal: this runs on app start, and the in-app feed works without it.
    console.warn('push subscription sync skipped:', err.message);
    return false;
  }
}

/**
 * Asks the browser for notification permission (if needed), subscribes this
 * device to Web Push using the server's VAPID public key, and registers the
 * subscription with the backend so it can target this device.
 */
export async function enablePushNotifications() {
  if (getPushSupportState() === 'unsupported') {
    throw new Error('Push notifications are not supported in this browser.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted.');
  }

  const registration = await readyRegistration();
  const { data } = await api.get('/push/vapid-public-key');

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(data.publicKey),
    });
  }

  await api.post('/push/subscribe', subscription.toJSON());
  return subscription;
}

export async function disablePushNotifications() {
  if (!('serviceWorker' in navigator)) return;
  const registration = await readyRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await api.post('/push/unsubscribe', { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
  }
}
