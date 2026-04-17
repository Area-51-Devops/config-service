'use strict';
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const Redis   = require('ioredis');

const { logger }              = require('../shared/logger');
const { requestIdMiddleware }  = require('../shared/requestId');
const { errorMiddleware, createError } = require('../shared/errorMiddleware');

const PORT = process.env.PORT || 3008;

// Default config values (used for seeding Redis on startup)
const DEFAULTS = {
  fraudThresholdPaise:  500000000,   // ₹50,00,000 stored as paise (or just an int sentinel; UI formats)
  fraudThresholdInr:    500000,      // ₹5,00,000 (actual value used by services)
  maxTransferLimitInr:  1000000,     // ₹10,00,000
  maintenanceMode:      false,
  supportedCurrencies:  ['INR'],
  maxLoanAmountInr:     5000000      // ₹50,00,000
};

let redisClient;
let isStarted = false;

// ──────────────────────────────────────────────
// Exponential backoff connector
// ──────────────────────────────────────────────
async function connectWithRetry(maxRetries = 10) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const client = new Redis({
        host:        process.env.REDIS_HOST || 'redis',
        port:        parseInt(process.env.REDIS_PORT || '6379'),
        lazyConnect:  true
      });
      await client.connect();
      await client.ping();
      logger.info({ service: 'config-service' }, 'Redis connected');
      return client;
    } catch (err) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
      logger.warn({ service: 'config-service', attempt, delay }, `Redis not ready, retrying in ${delay}ms`);
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function seedDefaults() {
  // Only seed keys that don't already exist
  for (const [key, value] of Object.entries(DEFAULTS)) {
    const existing = await redisClient.get(`config:${key}`);
    if (existing === null) {
      await redisClient.set(`config:${key}`, JSON.stringify(value));
      logger.info({ key }, 'Seeded config key');
    }
  }
}

async function init() {
  redisClient = await connectWithRetry();
  await seedDefaults();
  isStarted = true;
}

// ──────────────────────────────────────────────
// Express App
// ──────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(requestIdMiddleware);

// ── Health Probes ──────────────────────────────
app.get('/health/startup', (req, res) => {
  res.json({ status: isStarted ? 'UP' : 'STARTING', service: 'config-service' });
});

app.get('/health/liveness', async (req, res, next) => {
  try {
    await redisClient.ping();
    res.json({ status: 'UP', service: 'config-service' });
  } catch (err) {
    next(createError(503, 'HEALTH_CHECK_FAILED', 'Redis ping failed'));
  }
});

app.get('/health/readiness', async (req, res, next) => {
  try {
    if (!isStarted) throw new Error('Not ready');
    await redisClient.ping();
    res.json({ status: 'READY', service: 'config-service' });
  } catch (err) {
    next(createError(503, 'NOT_READY', 'Not ready'));
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'UP', service: 'config-service' });
});

// ── GET all config ─────────────────────────────
app.get('/config', async (req, res, next) => {
  try {
    const keys = Object.keys(DEFAULTS).map(k => `config:${k}`);
    const values = await redisClient.mget(...keys);
    const config = {};
    Object.keys(DEFAULTS).forEach((k, i) => {
      try { config[k] = JSON.parse(values[i]); } catch { config[k] = DEFAULTS[k]; }
    });
    res.json({ success: true, config });
  } catch (err) {
    next(err);
  }
});

// ── GET single config key ──────────────────────
app.get('/config/:key', async (req, res, next) => {
  try {
    const raw = await redisClient.get(`config:${req.params.key}`);
    if (raw === null) return next(createError(404, 'CONFIG_NOT_FOUND', `Key '${req.params.key}' not found`));
    res.json({ success: true, key: req.params.key, value: JSON.parse(raw) });
  } catch (err) {
    next(err);
  }
});

// ── PUT update single config key ───────────────
app.put('/config/:key', async (req, res, next) => {
  try {
    const { value } = req.body;
    if (value === undefined) return next(createError(400, 'VALIDATION_ERROR', 'value is required'));
    await redisClient.set(`config:${req.params.key}`, JSON.stringify(value));
    logger.info({ key: req.params.key, value }, 'Config key updated');
    res.json({ success: true, key: req.params.key, value });
  } catch (err) {
    next(err);
  }
});

// ── Global Error Handler ───────────────────────
app.use(errorMiddleware);

// ── Boot ───────────────────────────────────────
app.listen(PORT, () => logger.info({ port: PORT }, 'config-service listening'));

init().catch(err => {
  logger.fatal({ err }, 'config-service failed to initialise');
  process.exit(1);
});
