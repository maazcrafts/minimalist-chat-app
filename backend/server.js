const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

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

// REST API Routes
// Register
app.post('/api/auth/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    bcrypt.hash(password, 10, (err, hash) => {
        if (err) return res.status(500).json({ error: 'Server error hashing password' });
        
        db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username already exists' });
                return res.status(500).json({ error: 'Database error' });
            }
            res.json({ id: this.lastID, username });
        });
    });
});

// Login
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(400).json({ error: 'User not found' });

        bcrypt.compare(password, user.password_hash, (err, result) => {
            if (err) return res.status(500).json({ error: 'Server error comparing password' });
            if (!result) return res.status(400).json({ error: 'Invalid password' });
            
            res.json({ id: user.id, username: user.username });
        });
    });
});

// Get Contacts
app.get('/api/contacts/:userId', (req, res) => {
    const userId = req.params.userId;
    const query = `
        SELECT u.id, u.username
        FROM contacts c
        JOIN users u ON c.friend_id = u.id
        WHERE c.user_id = ?
    `;
    db.all(query, [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows || []);
    });
});

// Add Contact
app.post('/api/contacts/add', (req, res) => {
    const { userId, friendUsername } = req.body;
    db.get('SELECT id, username FROM users WHERE username = ?', [friendUsername], (err, friend) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!friend) return res.status(404).json({ error: 'User not found' });
        if (friend.id === parseInt(userId)) return res.status(400).json({ error: 'Cannot add yourself' });

        db.run('INSERT INTO contacts (user_id, friend_id) VALUES (?, ?)', [userId, friend.id], (err) => {
            if (err) {
                if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Already contacts' });
                return res.status(500).json({ error: 'Database error' });
            }
            db.run('INSERT OR IGNORE INTO contacts (user_id, friend_id) VALUES (?, ?)', [friend.id, userId], (err) => {
                res.json({ id: friend.id, username: friend.username });
            });
        });
    });
});

// Create Group
app.post('/api/groups/create', (req, res) => {
    const { name, creatorId, memberIds } = req.body;
    if (!name || !creatorId || !memberIds || !memberIds.length) {
        return res.status(400).json({ error: 'Missing required group fields' });
    }

    db.run('INSERT INTO groups (name, created_by) VALUES (?, ?)', [name, creatorId], function(err) {
        if (err) return res.status(500).json({ error: 'Failed to create group' });
        
        const groupId = this.lastID;
        // Include creator in group members
        const allMembers = Array.from(new Set([...memberIds, creatorId]));
        
        let stmt = db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)');
        allMembers.forEach(userId => {
            stmt.run([groupId, userId]);
        });
        stmt.finalize(() => {
            res.json({ id: groupId, name, is_group: true });
        });
    });
});

// Get Groups
app.get('/api/groups/:userId', (req, res) => {
    const userId = req.params.userId;
    const query = `
        SELECT g.id, g.name
        FROM group_members gm
        JOIN groups g ON gm.group_id = g.id
        WHERE gm.user_id = ?
    `;
    db.all(query, [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error fetch groups' });
        const mapped = (rows || []).map(r => ({ ...r, is_group: true }));
        res.json(mapped);
    });
});

// Upload Image
app.post('/api/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const url = `http://localhost:3000/uploads/${req.file.filename}`;
    res.json({ url });
});

// Get Messages
app.get('/api/messages/:userId/:friendOrGroupId', (req, res) => {
    const { userId, friendOrGroupId } = req.params;
    const isGroup = req.query.isGroup === 'true';

    let query, params;
    if (isGroup) {
        query = `SELECT m.*, u.username as sender_username FROM messages m LEFT JOIN users u ON m.sender_id = u.id WHERE m.group_id = ? ORDER BY m.timestamp ASC`;
        params = [friendOrGroupId];
    } else {
        query = `SELECT * FROM messages WHERE (sender_id = ? AND receiver_id = ? AND group_id IS NULL) OR (sender_id = ? AND receiver_id = ? AND group_id IS NULL) ORDER BY timestamp ASC`;
        params = [userId, friendOrGroupId, friendOrGroupId, userId];
    }

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Socket.IO
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    
    socket.on('join', (userId) => {
        socket.join(`user_${userId}`);
        
        // Also fetch and join all group rooms for this user
        db.all('SELECT group_id FROM group_members WHERE user_id = ?', [userId], (err, rows) => {
            if (!err && rows) {
                rows.forEach(r => socket.join(`group_${r.group_id}`));
            }
        });
    });

    socket.on('join_new_group', (groupId) => {
        socket.join(`group_${groupId}`);
    });

    socket.on('send_message', (data) => {
        const { senderId, receiverId, groupId, content, imageUrl, type } = data;
        
        let msgType = type || 'text';
        let valReceiverId = groupId ? null : receiverId;
        
        db.run('INSERT INTO messages (sender_id, receiver_id, group_id, content, image_url, type) VALUES (?, ?, ?, ?, ?, ?)', 
            [senderId, valReceiverId, groupId || null, content, imageUrl || null, msgType], 
            function(err) {
                if (err) return console.error('Error saving message:', err.message);
                
                const messageObj = {
                    id: this.lastID,
                    sender_id: senderId,
                    receiver_id: valReceiverId,
                    group_id: groupId || null,
                    content,
                    image_url: imageUrl || null,
                    type: msgType,
                    timestamp: new Date().toISOString()
                };

                if (groupId) {
                    db.get('SELECT username FROM users WHERE id = ?', [senderId], (err, row) => {
                        messageObj.sender_username = row ? row.username : 'Unknown';
                        io.to(`group_${groupId}`).emit('receive_message', messageObj);
                    });
                } else {
                    io.to(`user_${receiverId}`).emit('receive_message', messageObj);
                    socket.emit('message_sent', messageObj);
                }
            }
        );
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
