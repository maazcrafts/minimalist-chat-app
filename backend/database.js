const { Pool } = require('pg');

const DATABASE_URL = 'postgresql://postgres:Maaz_khan0459@db.ngmxrdnscopofiihveet.supabase.co:5432/postgres';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        banned BOOLEAN DEFAULT FALSE,
        last_seen TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        friend_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, friend_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS group_members (
        group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (group_id, user_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        sender_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        receiver_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        group_id BIGINT REFERENCES groups(id) ON DELETE SET NULL,
        content TEXT,
        image_url TEXT,
        type TEXT DEFAULT 'text',
        reply_to_id BIGINT,
        reply_to_type TEXT,
        reply_to_content TEXT,
        reply_to_image_url TEXT,
        reply_to_sender_username TEXT,
        status TEXT DEFAULT 'sent',
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_group_ts ON messages(group_id, timestamp);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_dm_ts ON messages(sender_id, receiver_id, timestamp);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS message_reactions (
        message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (message_id, user_id, emoji)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS friend_requests (
        id BIGSERIAL PRIMARY KEY,
        sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        receiver_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT DEFAULT 'pending',
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(sender_id, receiver_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query, initDb };
