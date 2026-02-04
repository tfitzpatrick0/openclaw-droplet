require('dotenv').config()
const express = require('express')
const path = require('path')

const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

const DO_API = 'https://api.digitalocean.com/v2'
const DO_TOKEN = process.env.DO_API_TOKEN
const SSH_KEY_IDS = process.env.DO_SSH_KEY_IDS ? process.env.DO_SSH_KEY_IDS.split(',').map(k => k.trim()) : []
const REGION = process.env.DO_REGION || 'nyc1'
const PORT = process.env.PORT || 3000

// Store active droplets (in-memory for simplicity)
const droplets = new Map()

// ---------- API Routes ----------

// Create a new droplet
app.post('/api/droplets', async (req, res) => {
  if (!DO_TOKEN) {
    return res.status(500).json({ error: 'DO_API_TOKEN not configured' })
  }

  const dropletName = `openclaw-${Date.now().toString(36)}`

  const body = {
    name: dropletName,
    region: REGION,
    size: 's-2vcpu-4gb',        // Pro plan specs from sunnyside-ai
    image: 'moltbot',           // OpenClaw 1-Click marketplace image
    ssh_keys: SSH_KEY_IDS,
    backups: false,
    ipv6: true,
    monitoring: true,
    tags: ['openclaw'],
  }

  try {
    const response = await fetch(`${DO_API}/droplets`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DO_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const err = await response.json()
      console.error('[DO] Create failed:', err)
      return res.status(response.status).json({ error: err.message || 'Failed to create droplet' })
    }

    const data = await response.json()
    const dropletId = data.droplet.id
    console.log(`[Droplet] Created ${dropletId} (${dropletName})`)

    // Start polling for the droplet to become active
    droplets.set(dropletId, { name: dropletName, status: 'new', ip: null })
    pollDroplet(dropletId)

    return res.json({ dropletId, name: dropletName, status: 'provisioning' })
  } catch (err) {
    console.error('[DO] Error:', err)
    return res.status(500).json({ error: 'Failed to create droplet' })
  }
})

// Get droplet status
app.get('/api/droplets/:id', async (req, res) => {
  const dropletId = parseInt(req.params.id, 10)
  const cached = droplets.get(dropletId)

  if (cached && cached.status === 'active' && cached.ip) {
    return res.json(cached)
  }

  // Fetch fresh from DO
  try {
    const info = await fetchDropletInfo(dropletId)
    if (info) {
      droplets.set(dropletId, info)
      return res.json(info)
    }
    return res.status(404).json({ error: 'Droplet not found' })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch droplet' })
  }
})

// ---------- Polling ----------

async function fetchDropletInfo(dropletId) {
  const response = await fetch(`${DO_API}/droplets/${dropletId}`, {
    headers: { 'Authorization': `Bearer ${DO_TOKEN}` },
  })

  if (!response.ok) return null

  const data = await response.json()
  const d = data.droplet
  const publicIp = d.networks?.v4?.find(n => n.type === 'public')?.ip_address || null

  return {
    id: d.id,
    name: d.name,
    status: d.status,
    ip: publicIp,
    region: d.region?.slug,
    memory: d.memory,
    vcpus: d.vcpus,
    disk: d.disk,
  }
}

async function pollDroplet(dropletId, attempts = 0) {
  if (attempts > 60) {
    console.error(`[Droplet] ${dropletId} timed out after 60 attempts`)
    const cached = droplets.get(dropletId)
    if (cached) cached.status = 'error'
    return
  }

  try {
    const info = await fetchDropletInfo(dropletId)
    if (info && info.status === 'active' && info.ip) {
      console.log(`[Droplet] ${dropletId} is active at ${info.ip}`)
      droplets.set(dropletId, info)
      return
    }
  } catch (err) {
    console.error(`[Droplet] Poll error:`, err.message)
  }

  // Retry in 5 seconds
  setTimeout(() => pollDroplet(dropletId, attempts + 1), 5000)
}

// ---------- Start ----------

app.listen(PORT, () => {
  console.log(`OpenClaw Droplet Creator running on http://localhost:${PORT}`)
  if (!DO_TOKEN) console.warn('⚠️  DO_API_TOKEN not set — droplet creation will fail')
})
