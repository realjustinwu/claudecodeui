// @ts-nocheck -- JWT request augmentation is narrowed by Auth route contracts.
import { randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { IS_PLATFORM } from '@/shared/utils.js';

import { userDb, appConfigDb } from '../database/index.js';

// Use env var if set, otherwise auto-generate a unique secret per installation
const JWT_SECRET = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();

/**
 * Platform mode per-user identity: the reverse proxy (wugong-nginx →
 * oauth2-proxy) authenticates the request and forwards the account name in
 * `X-Forwarded-User`. Map it to a real DB user, auto-creating on first sight
 * (password login never happens for platform users — identity is the
 * gateway's job, so the stored hash is an unguessable placeholder).
 *
 * No header (direct container-network call, health probe): fall back to the
 * legacy single-user behavior so internal tooling keeps working.
 */
const resolvePlatformUserFromHeader = (headerUser) => {
  const raw = typeof headerUser === 'string' ? headerUser.trim() : '';
  if (!raw) {
    return userDb.getFirstUser() ?? null;
  }
  const existing = userDb.getUserByUsername(raw);
  if (existing) {
    return userDb.getUserById(existing.id) ?? null;
  }
  const created = userDb.createUser(raw, `platform:${randomUUID()}`);
  return userDb.getUserById(created.id) ?? null;
};

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }
  
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  // Platform mode: map the reverse-proxy identity header to a real per-user
  // account (auto-created on first sight); header-less internal calls fall
  // back to the legacy single-user behavior.
  if (IS_PLATFORM) {
    try {
      const user = resolvePlatformUserFromHeader(req.headers['x-forwarded-user']);
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
      }
      req.user = user;
      return next();
    } catch (error) {
      console.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Normal OSS JWT validation
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  // Also check query param for SSE endpoints (EventSource can't set headers)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    res.setHeader('X-Auth-Error', 'invalid-token');
    return res.status(401).json({
      error: 'Access denied. No token provided.',
      code: 'AUTH_TOKEN_INVALID',
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Verify user still exists and is active
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      res.setHeader('X-Auth-Error', 'invalid-token');
      return res.status(401).json({
        error: 'Invalid token. User not found.',
        code: 'AUTH_TOKEN_INVALID',
      });
    }

    // Auto-refresh: if token is past halfway through its lifetime, issue a new one
    if (decoded.exp && decoded.iat) {
      const now = Math.floor(Date.now() / 1000);
      const halfLife = (decoded.exp - decoded.iat) / 2;
      if (now > decoded.iat + halfLife) {
        const newToken = generateToken(user);
        res.setHeader('X-Refreshed-Token', newToken);
      }
    }

    req.user = user;
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.setHeader('X-Auth-Error', 'session-expired');
      return res.status(401).json({
        error: 'Session expired. Please log in again.',
        code: 'AUTH_TOKEN_EXPIRED',
      });
    }

    console.warn(
      'Token verification failed:',
      error instanceof Error ? error.message : String(error),
    );
    res.setHeader('X-Auth-Error', 'invalid-token');
    return res.status(401).json({
      error: 'Invalid token',
      code: 'AUTH_TOKEN_INVALID',
    });
  }
};

// Generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// WebSocket authentication function
const authenticateWebSocket = (token, upgradeHeaders) => {
  // Platform mode: map the upgrade request's proxy identity header to a real
  // per-user account (same rule as the REST middleware)
  if (IS_PLATFORM) {
    try {
      const user = resolvePlatformUserFromHeader(
        upgradeHeaders ? upgradeHeaders['x-forwarded-user'] : undefined
      );
      if (user) {
        return { id: user.id, userId: user.id, username: user.username };
      }
      return null;
    } catch (error) {
      console.error('Platform mode WebSocket error:', error);
      return null;
    }
  }

  // Normal OSS JWT validation
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Verify user actually exists in database (matches REST authenticateToken behavior)
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return null;
    }
    return { userId: user.id, username: user.username };
  } catch (error) {
    if (!(error instanceof jwt.TokenExpiredError)) {
      console.warn(
        'WebSocket token verification failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
    return null;
  }
};

export {
  validateApiKey,
  authenticateToken,
  generateToken,
  authenticateWebSocket,
  JWT_SECRET
};
