import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  try {
    const data = await kv.get('radgruppe:main');

    if (data) {
      data.subscription = null;
      data.lastAlertKey = '';
      data.lastAlertAt = 0;
      data.pushDisabledAt = Date.now();

      await kv.set('radgruppe:main', data);
    }

    return res.status(200).json({
      ok: true,
      pushEnabled: false
    });
  } catch (error) {
    console.error('Push unsubscribe fehlgeschlagen:', error);

    return res.status(500).json({
      error: error.message
    });
  }
}

