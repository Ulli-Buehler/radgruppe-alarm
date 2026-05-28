import { kv } from '@vercel/kv';
import webpush from 'web-push';

const SIGNAL_TIMEOUT_SECONDS = 180;

function ageSeconds(value) {
  if (!value) return 999999;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 999999;
  return Math.round((Date.now() - time) / 1000);
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

export default async function handler(req, res) {
  try {
    const data = await kv.get('radgruppe:main');

    if (!data || !data.subscription || !data.config) {
      return res.status(200).json({
        ok: true,
        skipped: 'no_subscription'
      });
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
    const leader = devices.find(device => Number(device.id) === leaderId);
    const leaderPos = posMap[leaderId];

    const messages = [];

    if (!leaderId || !leader) {
      messages.push('Kein Leiter gewählt');
    } else if (!leaderPos) {
      messages.push('Leiter hat kein Signal');
    } else {
      const leaderAge = ageSeconds(
        leaderPos.serverTime || leaderPos.deviceTime || leaderPos.fixTime
      );

      if (leaderAge > SIGNAL_TIMEOUT_SECONDS) {
        messages.push('Leiter nicht live');
      }
    }

    if (leaderPos) {
      for (const device of devices) {
        if (Number(device.id) === leaderId) continue;

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

        if (age > SIGNAL_TIMEOUT_SECONDS) {
          messages.push(`${device.name}: nicht live`);
        } else if (distance > Number(config.threshold || 200)) {
          messages.push(`${device.name}: ${distance} m entfernt`);
        }
      }
    }

    const alertKey = messages.join('|');
    const previousAlertKey = data.lastAlertKey || '';

    if (alertKey && alertKey !== previousAlertKey) {
      await sendPush(subscription, messages);

      data.lastAlertKey = alertKey;
      data.lastAlertAt = Date.now();

      await kv.set('radgruppe:main', data);

      return res.status(200).json({
        ok: true,
        pushed: true,
        messages
      });
    }

    if (!alertKey && previousAlertKey) {
      data.lastAlertKey = '';
      data.lastOkAt = Date.now();

      await kv.set('radgruppe:main', data);
    }

    return res.status(200).json({
      ok: true,
      pushed: false,
      messages
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
