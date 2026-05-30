import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  try {
    const { subscription, config } = req.body || {};

    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'subscription_missing' });
    }

    if (!config || !config.url || !config.email || !config.password) {
      return res.status(400).json({ error: 'config_missing' });
    }

    const activeDeviceIds = Array.isArray(config.activeDeviceIds)
      ? [...new Set(config.activeDeviceIds.map(value => String(value)).filter(Boolean))]
      : [];

    const data = {
      subscription,
      config: {
        url: String(config.url).replace(/\/$/, ''),
        email: String(config.email),
        password: String(config.password),
        threshold: Number(config.threshold || 200),
        leader: String(config.leader || ''),
        activeDeviceIds
      },
      lastAlertKey: '',
      lastAlertAt: 0,
      lastOkAt: Date.now(),
      updatedAt: Date.now()
    };

    await kv.set('radgruppe:main', data);

    return res.status(200).json({
      ok: true,
      activeDeviceIds
    });
  } catch (error) {
    console.error('Push subscribe fehlgeschlagen:', error);

    return res.status(500).json({
      error: error.message
    });
  }
}
