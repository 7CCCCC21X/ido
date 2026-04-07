// Vercel Serverless Function: auto-commit snapshot.json to GitHub
// Env vars needed: GITHUB_TOKEN, GITHUB_REPO (e.g. "7CCCCC21X/ido")
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';

  if (!token || !repo) {
    return res.status(500).json({ error: 'Missing GITHUB_TOKEN or GITHUB_REPO env' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  if (!body || !Number.isFinite(body.dep)) {
    return res.status(400).json({ error: 'Invalid snapshot: dep must be a number' });
  }

  const snapshot = {
    dep: Math.round(body.dep * 10000) / 10000,
    updatedAt: body.updatedAt || new Date().toISOString()
  };

  const filePath = 'snapshot.json';
  const apiBase = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json'
  };

  try {
    // 1. Get current file SHA (required for update)
    const getRes = await fetch(`${apiBase}?ref=${branch}`, { headers });
    let sha;
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
    }

    // 2. Commit updated snapshot.json
    const content = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n').toString('base64');
    const putRes = await fetch(apiBase, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `chore: auto-save snapshot at ${snapshot.updatedAt}`,
        content,
        sha,
        branch
      })
    });

    if (!putRes.ok) {
      const err = await putRes.text();
      console.error('GitHub API error:', err);
      return res.status(502).json({ error: 'GitHub commit failed', detail: err });
    }

    return res.status(200).json({ ok: true, snapshot });
  } catch (e) {
    console.error('save-snapshot error:', e);
    return res.status(500).json({ error: e.message });
  }
}
