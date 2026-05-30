import { kv } from '@vercel/kv';
import webpush from 'web-push';
import http from 'http';

const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 10000);
const SIGNAL_TIMEOUT_SECONDS = Number(process.env.SIGNAL_TIMEOUT_SECONDS || 180);
const PAUSE_TIMEOUT_SECONDS = Number(process.env.PAUSE_TIMEOUT_SECONDS || 7200);
const GUIDE_MOVING_SPEED_KMH = Number(process.env.GUIDE_MOVING_SPEED_KMH || 4);
const PORT = Number(process.env.PORT || 3000);

let isChecking = false;
let lastRunAt = 0;
let lastResult = {
  ok: true,
  message: 'Worker gestartet',
  pushed: false,
  messages: []
};

function ageSeconds(value) {
  if (!value) return 999999;

  const time = new Date(value).getTime();

  if (!Number.isFinite(time)) return 999999;

  return Math.round((Date.now() - time) / 1000);
}


function speedKmh(position) {
  if (!position || position.speed == null) return 0;

  const value = Number(position.speed);

  if (!Number.isFinite(value)) return 0;

  return value * 1.852;
}

function isMoving(position) {
  return speedKmh(position) > GUIDE_MOVING_SPEED_KMH;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function authHeader(email, password) {
  return 'Basic ' + Buffer.from(`${email}:${password}`).toString('base64');
}

async function traccarFetch(url, email, password, path) {
  const response = await fetch(url + path, {
    headers: {
      Authorization: authHeader(email, password),
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Traccar HTTP ${response.status}`);
  }

  return response.json();
}

async function sendPush(subscription, messages) {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:radgruppe@example.com';

  if (!publicKey || !privateKey) {
    throw new Error('VAPID keys missing');
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);

  await webpush.sendNotification(
    subscription,
    JSON.stringify({
      title: '🚴 Radgruppe Warnung',
      body: messages.slice(0, 3).join(' · '),
      tag: 'radgruppe-alert',
      url: '/'
    })
  );
}

function getActiveIdSet(config) {
  if (!Array.isArray(config.activeDeviceIds) || config.activeDeviceIds.length === 0) {
    return null;
  }

  return new Set(config.activeDeviceIds.map(value => String(value)).filter(Boolean));
}

function shouldMonitorDevice(device, leaderId, activeIdSet) {
  const idText = String(device.id);

  if (Number(device.id) === leaderId) {
    return true;
  }

  if (!activeIdSet) {
    return true;
  }

  return activeIdSet.has(idText);
}

async function checkAlerts() {
  if (isChecking) return;

  isChecking = true;
  lastRunAt = Date.now();

  try {
    const data = await kv.get('radgruppe:main');

    if (!data || !data.subscription || !data.config) {
      lastResult = {
        ok: true,
        pushed: false,
        skipped: 'no_subscription',
        messages: []
      };

      return;
    }

    const { subscription, config } = data;

    const devices = await traccarFetch(
      config.url,
      config.email,
      config.password,
      '/api/devices'
    );

    const positions = await traccarFetch(
      config.url,
      config.email,
      config.password,
      '/api/positions'
    );

    const posMap = {};

    for (const position of positions) {
      posMap[position.deviceId] = position;
    }

    const leaderId = Number(config.leader);
    const activeIdSet = getActiveIdSet(config);
    const leader = devices.find(device => Number(device.id) === leaderId);
    const leaderPos = posMap[leaderId];

    const messages = [];
    let guideIsPaused = false;
    let guideAge = 999999;

    if (!leaderId || !leader) {
      messages.push('Kein Tourguide gewählt');
    } else if (!leaderPos) {
      messages.push('Tourguide hat kein Signal');
    } else {
      guideAge = ageSeconds(leaderPos.serverTime || leaderPos.deviceTime || leaderPos.fixTime);
      guideIsPaused = !isMoving(leaderPos);

      if (guideAge > PAUSE_TIMEOUT_SECONDS) {
        messages.push('Tourguide nicht live');
      } else if (guideAge > SIGNAL_TIMEOUT_SECONDS && !guideIsPaused) {
        messages.push('Tourguide nicht live');
      }
    }

    if (leaderPos) {
      for (const device of devices) {
        if (Number(device.id) === leaderId) continue;
        if (!shouldMonitorDevice(device, leaderId, activeIdSet)) continue;

        const pos = posMap[device.id];

        if (!pos) {
          messages.push(`${device.name}: kein Signal`);
          continue;
        }

        const age = ageSeconds(pos.serverTime || pos.deviceTime || pos.fixTime);

        const distance = Math.round(
          haversine(
            leaderPos.latitude,
            leaderPos.longitude,
            pos.latitude,
            pos.longitude
          )
        );

        const riderIsPaused = !isMoving(pos);
        const lastKnownNear = distance <= Number(config.threshold || 200);

        if (age <= SIGNAL_TIMEOUT_SECONDS) {
          if (distance > Number(config.threshold || 200)) {
            messages.push(`${device.name}: ${distance} m entfernt`);
          }

          continue;
        }

        if (
          age <= PAUSE_TIMEOUT_SECONDS &&
          lastKnownNear &&
          (guideIsPaused || riderIsPaused)
        ) {
          continue;
        }

        if (age > PAUSE_TIMEOUT_SECONDS) {
          messages.push(`${device.name}: nicht live`);
          continue;
        }

        messages.push(`${device.name}: nicht live`);
      }
    }

    const alertKey = messages.join('|');
    const previousAlertKey = data.lastAlertKey || '';

    if (alertKey && alertKey !== previousAlertKey) {
      await sendPush(subscription, messages);

      data.lastAlertKey = alertKey;
      data.lastAlertAt = Date.now();

      await kv.set('radgruppe:main', data);

      lastResult = {
        ok: true,
        pushed: true,
        messages,
        activeDeviceIds: config.activeDeviceIds || [],
        guideIsPaused,
        guideAge
      };

      console.log('[PUSH]', messages.join(' | '));

      return;
    }

    if (!alertKey && previousAlertKey) {
      data.lastAlertKey = '';
      data.lastOkAt = Date.now();

      await kv.set('radgruppe:main', data);
    }

    lastResult = {
      ok: true,
      pushed: false,
      messages,
      activeDeviceIds: config.activeDeviceIds || [],
      guideIsPaused,
      guideAge
    };
  } catch (error) {
    lastResult = {
      ok: false,
      error: error.message,
      pushed: false,
      messages: []
    };

    console.error('[ERROR]', error.message);
  } finally {
    isChecking = false;
  }
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');

    if (req.url === '/health' || req.url === '/') {
      res.end(JSON.stringify({
        ok: true,
        worker: 'radgruppe-alarm',
        checkIntervalMs: CHECK_INTERVAL_MS,
        signalTimeoutSeconds: SIGNAL_TIMEOUT_SECONDS,
        pauseTimeoutSeconds: PAUSE_TIMEOUT_SECONDS,
        guideMovingSpeedKmh: GUIDE_MOVING_SPEED_KMH,
        lastRunAt,
        lastResult
      }));

      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({
      ok: false,
      error: 'not_found'
    }));
  });

  server.listen(PORT, () => {
    console.log(`Health server läuft auf Port ${PORT}`);
  });
}

console.log('Radgruppe Alarm Worker gestartet');
console.log(`Prüfintervall: ${CHECK_INTERVAL_MS} ms`);
console.log(`Signal-Timeout: ${SIGNAL_TIMEOUT_SECONDS} s`);
console.log(`Pause-Timeout: ${PAUSE_TIMEOUT_SECONDS} s`);
console.log(`Tourguide bewegt ab: ${GUIDE_MOVING_SPEED_KMH} km/h`);

startHealthServer();
checkAlerts();
setInterval(checkAlerts, CHECK_INTERVAL_MS);
