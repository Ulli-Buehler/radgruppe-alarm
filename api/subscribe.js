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

    const data = {
      subscription,
      config: {
        url: String(config.url).replace(/\/$/, ''),
        email: String(config.email),
        password: String(config.password),
        threshold: Number(config.threshold || 200),
        leader: String(config.leader || '')
      },
      lastAlertKey: '',
      lastAlertAt: 0,
      lastOkAt: Date.now(),
      updatedAt: Date.now()
    };

    await kv.set('radgruppe:main', data);

    return res.status(200).json({
      ok: true
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}
