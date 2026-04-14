require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-1234';
const ADMIN_USERNAME = 'maaz_khan';

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Postgres schema on startup
db.initDb().then(() => {
    console.log('Postgres schema initialized.');
}).catch((err) => {
    console.error('Failed to initialize Postgres schema:', err);
});

// Health checks / keep-alive
app.get('/health', (req, res) => res.status(200).send('ok'));
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Admin (no auth required by request)
app.get('/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
    (async () => {
        try {
            const { rows } = await db.query('SELECT username, created_at FROM users ORDER BY created_at DESC, id DESC');
            res.json(rows || []);
        } catch (err) {
            return res.status(500).json({ error: 'Database error' });
        }
    })();
});

// Admin dashboard APIs (authenticated)
app.get('/api/admin/dashboard/stats', authenticateToken, requireAdmin, (req, res) => {
    (async () => {
        try {
            const totalUsers = Number((await db.query('SELECT COUNT(*)::int as c FROM users WHERE username != $1', ['__system__'])).rows[0]?.c || 0);
            const totalMessages = Number((await db.query('SELECT COUNT(*)::int as c FROM messages')).rows[0]?.c || 0);
            const totalGroups = Number((await db.query('SELECT COUNT(*)::int as c FROM groups')).rows[0]?.c || 0);
            const activeUsersToday = Number((await db.query(
                "SELECT COUNT(DISTINCT id)::int as c FROM users WHERE last_seen >= (NOW() - INTERVAL '1 day') AND username != $1",
                ['__system__']
            )).rows[0]?.c || 0);

            const days = 14;
            const messagesPerDay = (await db.query(`
                SELECT to_char(date_trunc('day', timestamp), 'YYYY-MM-DD') as day, COUNT(*)::int as count
                FROM messages
                WHERE timestamp >= (NOW() - ($1 || ' days')::interval)
                GROUP BY date_trunc('day', timestamp)
                ORDER BY day ASC
            `, [String(days)])).rows;

            const signupsPerDay = (await db.query(`
                SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, COUNT(*)::int as count
                FROM users
                WHERE created_at >= (NOW() - ($1 || ' days')::interval) AND username != $2
                GROUP BY date_trunc('day', created_at)
                ORDER BY day ASC
            `, [String(days), '__system__'])).rows;

            res.json({
                totals: { users: totalUsers, messages: totalMessages, groups: totalGroups, activeUsersToday },
                series: { messagesPerDay, signupsPerDay }
            });
        } catch (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
    })();
});

app.get('/api/admin/dashboard/settings', authenticateToken, requireAdmin, (req, res) => {
    (async () => {
        res.json({
            maintenance_mode: (await getSettingAsync('maintenance_mode', 'false')) === 'true',
            invite_only: (await getSettingAsync('invite_only', 'false')) === 'true',
            welcome_message: await getSettingAsync('welcome_message', 'Welcome to MaazX')
        });
    })();
});

app.put('/api/admin/dashboard/settings', authenticateToken, requireAdmin, (req, res) => {
    (async () => {
        try {
            const { maintenance_mode, invite_only, welcome_message } = req.body || {};
            if (typeof maintenance_mode === 'boolean') await setSettingAsync('maintenance_mode', maintenance_mode ? 'true' : 'false');
            if (typeof invite_only === 'boolean') await setSettingAsync('invite_only', invite_only ? 'true' : 'false');
            if (typeof welcome_message === 'string') await setSettingAsync('welcome_message', welcome_message.slice(0, 200));
            res.json({ ok: true });
        } catch (err) {
            return res.status(500).json({ error: 'Failed to update settings' });
        }
    })();
});

app.get('/api/admin/dashboard/users', authenticateToken, requireAdmin, (req, res) => {
    (async () => {
        try {
            const { rows } = await db.query(
                `SELECT id, username, role, banned, created_at, last_seen
                 FROM users
                 WHERE username != $1
                 ORDER BY created_at DESC, id DESC`,
                ['__system__']
            );

            const enriched = (rows || []).map(u => {
                const room = io.sockets.adapter.rooms.get(`user_${u.id}`);
                const online = room && room.size > 0;
                return { ...u, online: !!online };
            });

            res.json(enriched);
        } catch (err) {
            return res.status(500).json({ error: 'Database error' });
        }
    })();
});

app.post('/api/admin/dashboard/users/:id/ban', authenticateToken, requireAdmin, (req, res) => {
    (async () => {
        try {
            const id = Number(req.params.id);
            const banned = !!req.body?.banned;
            await db.query('UPDATE users SET banned = $1 WHERE id = $2 AND username != $3', [banned, id, ADMIN_USERNAME]);
            res.json({ ok: true });
        } catch (err) {
            return res.status(500).json({ error: 'Failed to update user' });
        }
    })();
});

app.delete('/api/admin/dashboard/users/:id', authenticateToken, requireAdmin, (req, res) => {
    (async () => {
        const id = Number(req.params.id);
        const client = await db.pool.connect();
        try {
            const userRes = await client.query('SELECT id, username FROM users WHERE id = $1', [id]);
            const userRow = userRes.rows[0];
            if (!userRow) return res.status(404).json({ error: 'User not found' });
            if (userRow.username === ADMIN_USERNAME || userRow.username === '__system__') return res.status(400).json({ error: 'Cannot delete this user' });

            await client.query('BEGIN');
            await client.query('DELETE FROM message_reactions WHERE user_id = $1', [id]);
            await client.query('DELETE FROM contacts WHERE user_id = $1 OR friend_id = $1', [id]);
            await client.query('DELETE FROM friend_requests WHERE sender_id = $1 OR receiver_id = $1', [id]);
            await client.query('DELETE FROM group_members WHERE user_id = $1', [id]);
            await client.query('DELETE FROM messages WHERE sender_id = $1 OR receiver_id = $1', [id]);
            await client.query('DELETE FROM users WHERE id = $1', [id]);
            await client.query('COMMIT');

            res.json({ ok: true });
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch (_) {}
            console.error(err);
            return res.status(500).json({ error: 'Failed to delete user' });
        } finally {
            client.release();
        }
    })();
});

app.get('/api/admin/dashboard/messages', authenticateToken, requireAdmin, (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
    (async () => {
        try {
            const { rows } = await db.query(
                `SELECT m.id, m.sender_id, su.username as sender_username,
                        m.receiver_id, ru.username as receiver_username,
                        m.group_id, g.name as group_name,
                        m.type, m.content, m.image_url, m.timestamp
                 FROM messages m
                 LEFT JOIN users su ON su.id = m.sender_id
                 LEFT JOIN users ru ON ru.id = m.receiver_id
                 LEFT JOIN groups g ON g.id = m.group_id
                 ORDER BY m.timestamp DESC
                 LIMIT $1`,
                [limit]
            );
            res.json(rows || []);
        } catch (err) {
            return res.status(500).json({ error: 'Database error' });
        }
    })();
});

app.delete('/api/admin/dashboard/messages/:id', authenticateToken, requireAdmin, (req, res) => {
    const messageId = Number(req.params.id);
    (async () => {
        try {
            await db.query('DELETE FROM message_reactions WHERE message_id = $1', [messageId]);
            await db.query('DELETE FROM messages WHERE id = $1', [messageId]);
            res.json({ ok: true });
        } catch (err) {
            return res.status(500).json({ error: 'Failed to delete message' });
        }
    })();
});

app.post('/api/admin/dashboard/broadcast', authenticateToken, requireAdmin, (req, res) => {
    (async () => {
        const content = String(req.body?.content || '').trim();
        if (!content) return res.status(400).json({ error: 'Message required' });
        if (!systemUser) return res.status(500).json({ error: 'System user not available' });

        const client = await db.pool.connect();
        try {
            const usersRes = await client.query('SELECT id FROM users WHERE username != $1', ['__system__']);
            const users = usersRes.rows || [];

            await client.query('BEGIN');
            const insertText = "INSERT INTO messages (sender_id, receiver_id, group_id, content, type, status) VALUES ($1, $2, NULL, $3, 'system', 'sent')";
            for (const u of users) {
                if (u.id === systemUser.id) continue;
                await client.query(insertText, [systemUser.id, u.id, content]);
            }
            await client.query('COMMIT');

            for (const u of users) {
                if (u.id === systemUser.id) continue;
                const room = io.sockets.adapter.rooms.get(`user_${u.id}`);
                const online = room && room.size > 0;
                if (online) {
                    io.to(`user_${u.id}`).emit('receive_message', {
                        id: null,
                        sender_id: systemUser.id,
                        sender_username: systemUser.username,
                        receiver_id: u.id,
                        group_id: null,
                        content,
                        image_url: null,
                        type: 'system',
                        status: 'sent',
                        timestamp: new Date().toISOString(),
                        reactions: []
                    });
                }
            }
            res.json({ ok: true });
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch (_) {}
            console.error(err);
            return res.status(500).json({ error: 'Failed to broadcast' });
        } finally {
            client.release();
        }
    })();
});

// Setup static uploads directory
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));

// Multer Storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, uploadsDir) },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// JWT Middleware (function declarations are hoisted)
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access denied' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token' });
        req.user = user;
        next();
    });
}

function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Access denied' });
    if (req.user.username === ADMIN_USERNAME || req.user.role === 'admin') return next();
    return res.status(403).json({ error: 'Admin access required' });
}

const getSetting = (key, fallback) => {
    // (async wrapper used to keep existing call sites working)
    return fallback;
};

const setSetting = (key, value) => {
    // (async wrapper used to keep existing call sites working)
};

// Async settings + system user helpers
const getSettingAsync = async (key, fallback) => {
    try {
        const { rows } = await db.query('SELECT value FROM app_settings WHERE key = $1', [key]);
        const v = rows[0]?.value;
        if (v === null || v === undefined) return fallback;
        return v;
    } catch (_) {
        return fallback;
    }
};

const setSettingAsync = async (key, value) => {
    await db.query(
        'INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [key, value]
    );
};

const ensureSystemUserAsync = async () => {
    try {
        const existing = await db.query('SELECT id, username, role FROM users WHERE username = $1', ['__system__']);
        if (existing.rows[0]) return existing.rows[0];
        const hash = bcrypt.hashSync('system', 10);
        const created = await db.query(
            "INSERT INTO users (username, password_hash, role, banned) VALUES ($1, $2, 'system', FALSE) RETURNING id, username, role",
            ['__system__', hash]
        );
        return created.rows[0] || null;
    } catch (err) {
        console.error('Failed to ensure system user:', err.message);
        return null;
    }
};

let systemUser = null;
ensureSystemUserAsync().then(u => { systemUser = u; }).catch(() => {});

// REST API Routes
// Register
app.post('/api/auth/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    (async () => {
        const inviteOnly = (await getSettingAsync('invite_only', 'false')) === 'true';
        if (inviteOnly && username !== ADMIN_USERNAME) {
            return res.status(403).json({ error: 'Registrations are currently invite-only' });
        }

        bcrypt.hash(password, 10, async (err, hash) => {
            if (err) return res.status(500).json({ error: 'Server error hashing password' });
            try {
                const role = username === ADMIN_USERNAME ? 'admin' : 'user';
                const created = await db.query(
                    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role',
                    [username, hash, role]
                );
                const row = created.rows[0];
                const token = jwt.sign({ id: row.id, username: row.username, role: row.role }, JWT_SECRET, { expiresIn: '30d' });
                res.json({ id: row.id, username: row.username, role: row.role, token });
            } catch (e) {
                if (String(e?.code) === '23505') return res.status(400).json({ error: 'Username already exists' });
                return res.status(500).json({ error: 'Database error' });
            }
        });
    })();
});

// Login
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    (async () => {
        try {
            const { rows } = await db.query('SELECT * FROM users WHERE username = $1', [username]);
            const user = rows[0];
            if (!user) return res.status(400).json({ error: 'User not found' });
            if (user.banned) return res.status(403).json({ error: 'Account is banned' });

            bcrypt.compare(password, user.password_hash, (err, result) => {
                if (err) return res.status(500).json({ error: 'Server error comparing password' });
                if (!result) return res.status(400).json({ error: 'Invalid password' });

                const role = user.username === ADMIN_USERNAME ? 'admin' : (user.role || 'user');
                const token = jwt.sign({ id: user.id, username: user.username, role }, JWT_SECRET, { expiresIn: '30d' });
                res.json({ id: user.id, username: user.username, role, token });
            });
        } catch (err) {
            return res.status(500).json({ error: 'Database error' });
        }
    })();
});

// Public settings for client UX (welcome text, maintenance, invite-only)
app.get('/api/settings/public', (req, res) => {
    (async () => {
        res.json({
            maintenance_mode: (await getSettingAsync('maintenance_mode', 'false')) === 'true',
            invite_only: (await getSettingAsync('invite_only', 'false')) === 'true',
            welcome_message: await getSettingAsync('welcome_message', 'Welcome to MaazX')
        });
    })();
});

// System info for broadcast/system messages
app.get('/api/system/info', authenticateToken, (req, res) => {
    if (!systemUser) return res.status(500).json({ error: 'System user not available' });
    res.json({ id: systemUser.id, username: systemUser.username });
});

// Get Contacts
app.get('/api/contacts/:userId', authenticateToken, (req, res) => {
    const userId = req.params.userId;
    const query = `
        SELECT u.id, u.username
        FROM contacts c
        JOIN users u ON c.friend_id = u.id
        WHERE c.user_id = $1
    `;
    (async () => {
        try {
            const { rows } = await db.query(query, [userId]);
            res.json(rows || []);
        } catch (err) {
            return res.status(500).json({ error: 'Database error' });
        }
    })();
});

// Add Friend Request
app.post('/api/contacts/add', authenticateToken, (req, res) => {
    const { userId, friendUsername } = req.body;
    (async () => {
        try {
            const friendRes = await db.query('SELECT id, username FROM users WHERE username = $1', [friendUsername]);
            const friend = friendRes.rows[0];
            if (!friend) return res.status(404).json({ error: 'User not found' });
            if (Number(friend.id) === Number(userId)) return res.status(400).json({ error: 'Cannot add yourself' });

            const isFriend = await db.query('SELECT 1 FROM contacts WHERE user_id = $1 AND friend_id = $2', [userId, friend.id]);
            if (isFriend.rows[0]) return res.status(400).json({ error: 'Already friends' });

            try {
                await db.query('INSERT INTO friend_requests (sender_id, receiver_id) VALUES ($1, $2)', [userId, friend.id]);
            } catch (e) {
                if (String(e?.code) === '23505') return res.status(400).json({ error: 'Request already sent' });
                throw e;
            }

            io.to(`user_${friend.id}`).emit('new_friend_request', { sender_id: userId });
            res.json({ message: 'Friend request sent' });
        } catch (err) {
            return res.status(500).json({ error: 'Database error' });
        }
    })();
});

// Get Friend Requests
app.get('/api/contacts/requests/:userId', authenticateToken, (req, res) => {
    const userId = req.params.userId;
    (async () => {
        try {
            const { rows } = await db.query(`
                SELECT fr.id as request_id, u.id as sender_id, u.username as sender_username 
                FROM friend_requests fr 
                JOIN users u ON fr.sender_id = u.id 
                WHERE fr.receiver_id = $1 AND fr.status = 'pending'
            `, [userId]);
            res.json(rows || []);
        } catch (err) {
            return res.status(500).json({ error: 'Database error' });
        }
    })();
});

// Respond to Request
app.post('/api/contacts/requests/respond', authenticateToken, (req, res) => {
    const { requestId, status } = req.body; // status: 'accepted' or 'rejected'
    (async () => {
        const client = await db.pool.connect();
        try {
            const reqRes = await client.query('SELECT * FROM friend_requests WHERE id = $1', [requestId]);
            const reqRow = reqRes.rows[0];
            if (!reqRow) return res.status(404).json({ error: 'Request not found' });

            if (status === 'accepted') {
                await client.query('BEGIN');
                await client.query('INSERT INTO contacts (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [reqRow.sender_id, reqRow.receiver_id]);
                await client.query('INSERT INTO contacts (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [reqRow.receiver_id, reqRow.sender_id]);
                await client.query('UPDATE friend_requests SET status = $1 WHERE id = $2', ['accepted', requestId]);
                await client.query('COMMIT');

                io.to(`user_${reqRow.sender_id}`).emit('friend_request_accepted', { new_friend_id: reqRow.receiver_id });
                const friendRes = await client.query('SELECT id, username FROM users WHERE id = $1', [reqRow.sender_id]);
                res.json({ success: true, newContact: friendRes.rows[0] });
            } else {
                await client.query('UPDATE friend_requests SET status = $1 WHERE id = $2', ['rejected', requestId]);
                res.json({ success: true });
            }
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch (_) {}
            return res.status(500).json({ error: 'Database error' });
        } finally {
            client.release();
        }
    })();
});

// Create Group
app.post('/api/groups/create', authenticateToken, (req, res) => {
    const { name, creatorId, memberIds } = req.body;
    if (!name || !creatorId || !memberIds || !memberIds.length) {
        return res.status(400).json({ error: 'Missing required group fields' });
    }

    (async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            const created = await client.query('INSERT INTO groups (name, created_by) VALUES ($1, $2) RETURNING id, name', [name, creatorId]);
            const groupId = created.rows[0].id;

            const allMembers = Array.from(new Set([...(memberIds || []), creatorId])).map(Number);
            for (const uid of allMembers) {
                await client.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [groupId, uid]);
            }

            await client.query('COMMIT');
            res.json({ id: groupId, name, is_group: true });
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch (_) {}
            return res.status(500).json({ error: 'Failed to create group' });
        } finally {
            client.release();
        }
    })();
});

// Get Groups
app.get('/api/groups/:userId', authenticateToken, (req, res) => {
    const userId = req.params.userId;
    const query = `
        SELECT g.id, g.name
        FROM group_members gm
        JOIN groups g ON gm.group_id = g.id
        WHERE gm.user_id = $1
    `;
    (async () => {
        try {
            const { rows } = await db.query(query, [userId]);
            const mapped = (rows || []).map(r => ({ ...r, is_group: true }));
            res.json(mapped);
        } catch (err) {
            return res.status(500).json({ error: 'Database error fetch groups' });
        }
    })();
});

// Upload File (Image or Audio)
app.post('/api/upload', authenticateToken, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const url = `https://minimalist-chat-app.onrender.com/uploads/${req.file.filename}`;
    res.json({ url });
});

// Get Messages
app.get('/api/messages/:userId/:friendOrGroupId', authenticateToken, (req, res) => {
    const { userId, friendOrGroupId } = req.params;
    const isGroup = req.query.isGroup === 'true';

    let query, params;
    if (isGroup) {
        query = `SELECT m.*, u.username as sender_username FROM messages m LEFT JOIN users u ON m.sender_id = u.id WHERE m.group_id = $1 ORDER BY m.timestamp ASC`;
        params = [friendOrGroupId];
    } else {
        query = `SELECT m.*, u.username as sender_username
                 FROM messages m
                 LEFT JOIN users u ON m.sender_id = u.id
                 WHERE ((m.sender_id = $1 AND m.receiver_id = $2 AND m.group_id IS NULL) OR (m.sender_id = $3 AND m.receiver_id = $4 AND m.group_id IS NULL))
                 ORDER BY m.timestamp ASC`;
        params = [userId, friendOrGroupId, friendOrGroupId, userId];
    }

    (async () => {
        try {
            const { rows } = await db.query(query, params);
            const ids = (rows || []).map(r => r.id).filter(Boolean);
            const reactionsByMessageId = {};
            if (ids.length) {
                const reactionRows = await db.query(
                    `SELECT message_id, emoji, COUNT(*)::int as count
                     FROM message_reactions
                     WHERE message_id = ANY($1::bigint[])
                     GROUP BY message_id, emoji`,
                    [ids]
                );
                for (const rr of reactionRows.rows) {
                    if (!reactionsByMessageId[rr.message_id]) reactionsByMessageId[rr.message_id] = [];
                    reactionsByMessageId[rr.message_id].push({ emoji: rr.emoji, count: rr.count });
                }
            }
            const enriched = (rows || []).map(r => ({ ...r, reactions: reactionsByMessageId[r.id] || [] }));
            res.json(enriched);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    })();
});

// Socket.IO
io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication error'));
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return next(new Error('Authentication error'));
        socket.user = user;
        next();
    });
});

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    
    // JWT auth on connect would be ideal here, but passing it securely requires handshake parsing.
    // For now we trust the emit join logic since socket does not hit REST routes unless logged in.
    socket.on('join', (userId) => {
        socket.join(`user_${userId}`);

        (async () => {
            try {
                await db.query("UPDATE users SET last_seen = NOW() WHERE id = $1", [userId]);
            } catch (_) {}
        })();
        
        (async () => {
            try {
                const { rows } = await db.query('SELECT group_id FROM group_members WHERE user_id = $1', [userId]);
                (rows || []).forEach(r => socket.join(`group_${r.group_id}`));
            } catch (err) {
                console.error('Error fetching group members:', err.message);
            }
        })();
    });

    socket.on('join_new_group', (groupId) => {
        socket.join(`group_${groupId}`);
    });

    socket.on('send_message', (data) => {
        const { senderId, receiverId, groupId, content, imageUrl, type, reply } = data;
        
        let msgType = type || 'text';
        let valReceiverId = groupId ? null : receiverId;
        const replyToId = reply?.id || null;
        const replyToType = reply?.type || null;
        const replyToContent = reply?.content || null;
        const replyToImageUrl = reply?.imageUrl || null;
        const replyToSenderUsername = reply?.senderUsername || null;
        
        (async () => {
            try {
                const inserted = await db.query(
                    `INSERT INTO messages (
                        sender_id, receiver_id, group_id,
                        content, image_url, type,
                        reply_to_id, reply_to_type, reply_to_content, reply_to_image_url, reply_to_sender_username,
                        status
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                     RETURNING id, timestamp`,
                    [
                        senderId, valReceiverId, groupId || null,
                        content, imageUrl || null, msgType,
                        replyToId, replyToType, replyToContent, replyToImageUrl, replyToSenderUsername,
                        'sent'
                    ]
                );
                const row = inserted.rows[0];

                const senderRow = await db.query('SELECT username FROM users WHERE id = $1', [senderId]);
                const senderUsername = senderRow.rows[0]?.username || 'Unknown';

                const messageObj = {
                    id: row.id,
                    sender_id: senderId,
                    receiver_id: valReceiverId,
                    group_id: groupId || null,
                    content,
                    image_url: imageUrl || null,
                    type: msgType,
                    reply_to_id: replyToId,
                    reply_to_type: replyToType,
                    reply_to_content: replyToContent,
                    reply_to_image_url: replyToImageUrl,
                    reply_to_sender_username: replyToSenderUsername,
                    reactions: [],
                    status: 'sent',
                    timestamp: row.timestamp
                };

                if (groupId) {
                    messageObj.sender_username = senderUsername;
                    io.to(`group_${groupId}`).emit('receive_message', messageObj);
                } else {
                    messageObj.sender_username = senderUsername;
                    io.to(`user_${receiverId}`).emit('receive_message', messageObj);
                    socket.emit('message_sent', messageObj);

                    const receiverRoom = io.sockets.adapter.rooms.get(`user_${receiverId}`);
                    const receiverOnline = receiverRoom && receiverRoom.size > 0;
                    if (receiverOnline) {
                        await db.query("UPDATE messages SET status = 'delivered' WHERE id = $1 AND status = 'sent'", [row.id]);
                        socket.emit('message_delivered', { messageId: row.id });
                    }
                }
            } catch (err) {
                console.error('Error saving message:', err.message);
            }
        })();
    });

    socket.on('toggle_reaction', ({ messageId, userId, emoji }) => {
        if (!messageId || !userId || !emoji) return;
        (async () => {
            const client = await db.pool.connect();
            try {
                await client.query('BEGIN');
                const existing = await client.query(
                    'SELECT 1 FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
                    [messageId, userId, emoji]
                );
                if (existing.rows[0]) {
                    await client.query(
                        'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
                        [messageId, userId, emoji]
                    );
                } else {
                    await client.query(
                        'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                        [messageId, userId, emoji]
                    );
                }

                const reactionRows = await client.query(
                    `SELECT emoji, COUNT(*)::int as count
                     FROM message_reactions
                     WHERE message_id = $1
                     GROUP BY emoji`,
                    [messageId]
                );
                const reactions = reactionRows.rows.map(r => ({ emoji: r.emoji, count: r.count }));

                const msg = await client.query('SELECT id, group_id, sender_id, receiver_id FROM messages WHERE id = $1', [messageId]);
                await client.query('COMMIT');

                const m = msg.rows[0];
                if (!m) return;
                const payload = { messageId, reactions };

                if (m.group_id) {
                    io.to(`group_${m.group_id}`).emit('reaction_updated', payload);
                } else {
                    io.to(`user_${m.sender_id}`).emit('reaction_updated', payload);
                    io.to(`user_${m.receiver_id}`).emit('reaction_updated', payload);
                }
            } catch (err) {
                try { await client.query('ROLLBACK'); } catch (_) {}
                console.error('Error toggling reaction:', err.message);
            } finally {
                client.release();
            }
        })();
    });

    socket.on('mark_read', ({ userId, friendId }) => {
        (async () => {
            try {
                await db.query(
                    "UPDATE messages SET status = 'seen' WHERE sender_id = $1 AND receiver_id = $2 AND status IN ('sent','delivered') AND group_id IS NULL",
                    [friendId, userId]
                );
                io.to(`user_${friendId}`).emit('messages_read', { by_user_id: userId, friend_id: friendId, user_id: userId });
            } catch (err) {
                console.error('Error marking read:', err.message);
            }
        })();
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
