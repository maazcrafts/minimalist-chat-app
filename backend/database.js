const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Prefer a persistent disk path on Render (if configured), otherwise fallback to project dir.
// Render persistent disks are commonly mounted under /var/data (Linux). Use DB_PATH to override.
const defaultPersistentDir =
  process.platform !== 'win32'
    ? (process.env.RENDER_DISK_PATH || '/var/data')
    : path.resolve(__dirname);

const dbFilePath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(defaultPersistentDir, 'chat.db');

try {
  fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });
} catch (_) {}

const db = new Database(dbFilePath, { verbose: console.log });

console.log('Connected to the SQLite database.');

db.pragma('journal_mode = WAL');

db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    banned INTEGER DEFAULT 0,
    last_seen DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.exec(`CREATE TABLE IF NOT EXISTS contacts (
    user_id INTEGER,
    friend_id INTEGER,
    PRIMARY KEY (user_id, friend_id),
    FOREIGN KEY (user_id) REFERENCES users (id),
    FOREIGN KEY (friend_id) REFERENCES users (id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users (id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER,
    user_id INTEGER,
    PRIMARY KEY (group_id, user_id),
    FOREIGN KEY (group_id) REFERENCES groups (id),
    FOREIGN KEY (user_id) REFERENCES users (id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER,
    receiver_id INTEGER,
    group_id INTEGER,
    content TEXT,
    image_url TEXT,
    type TEXT DEFAULT 'text',
    reply_to_id INTEGER,
    reply_to_type TEXT,
    reply_to_content TEXT,
    reply_to_image_url TEXT,
    reply_to_sender_username TEXT,
    status TEXT DEFAULT 'sent',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sender_id) REFERENCES users (id),
    FOREIGN KEY (receiver_id) REFERENCES users (id),
    FOREIGN KEY (group_id) REFERENCES groups (id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS message_reactions (
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id, emoji),
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
)`);

db.exec(`CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER,
    receiver_id INTEGER,
    status TEXT DEFAULT 'pending',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sender_id) REFERENCES users (id),
    FOREIGN KEY (receiver_id) REFERENCES users (id),
    UNIQUE(sender_id, receiver_id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
)`);

// Apply migrations for new columns gracefully (ignoring duplicate column errors)
try { db.exec("ALTER TABLE messages ADD COLUMN group_id INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE messages ADD COLUMN image_url TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE messages ADD COLUMN type TEXT DEFAULT 'text'"); } catch (e) {}
try { db.exec("ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'sent'"); } catch (e) {}
try { db.exec("ALTER TABLE messages ADD COLUMN reply_to_id INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE messages ADD COLUMN reply_to_type TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE messages ADD COLUMN reply_to_content TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE messages ADD COLUMN reply_to_image_url TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE messages ADD COLUMN reply_to_sender_username TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN last_seen DATETIME"); } catch (e) {}

module.exports = db;
