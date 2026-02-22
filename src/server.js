const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { createSession, getSession, deleteSession } = require('./services/whatsapp');
const { Session } = require('./models');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

mongoose.connect(process.env.MONGO_URL)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// Auth Guard checks the Bearer token
const authGuard = async (req, res, next) => {
    const { session } = req.params;
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;

    const sessionDb = await Session.findOne({ sessionId: session });
    if (!sessionDb || sessionDb.token !== token) {
        return res.status(401).json({ error: 'Unauthorized', status: 'error' });
    }
    req.sessionDb = sessionDb;
    next();
};

// 1. Generate Token (Now matches your NGINX / Flask path)
app.post('/api/:session/:secret/generate-token', async (req, res) => {
    const { session, secret } = req.params;
    
    // Check against global server secret
    if (secret !== process.env.WA_SECRET) {
        return res.status(401).json({ status: 'error', message: 'Invalid WA_SECRET' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    
    await Session.findOneAndUpdate(
        { sessionId: session },
        { sessionId: session, token: token },
        { upsert: true, new: true }
    );

    res.json({
        status: 'success',
        token: token,
        full: `${session}-wabot`, // Matches your Flask expectations
        message: 'Token generated'
    });
});

// 2. Status Session
app.get('/api/:session/status-session', authGuard, async (req, res) => {
    const sessionDb = req.sessionDb;
    res.json({
        status: sessionDb.status,
        qrcode: sessionDb.qrCode || null,
        message: 'Session status retrieved'
    });
});

// 3. Start Session (Dynamic Webhook)
app.post('/api/:session/start-session', authGuard, async (req, res) => {
    const { session } = req.params;
    const { webhook, waitQrCode } = req.body;
    
    let sock = getSession(session);
    if (!sock) {
        sock = await createSession(session, webhook);
    } else if (webhook) {
        // Update webhook dynamically if session already exists
        await Session.findOneAndUpdate({ sessionId: session }, { webhook });
    }

    // Give Baileys a second to generate the QR code
    setTimeout(async () => {
        const state = await Session.findOne({ sessionId: session });
        res.json({ 
            status: 'success', 
            state: state.status, 
            qrcode: state.qrCode,
            message: 'Session process started.' 
        });
    }, 2000);
});

// 4. Logout Session
app.post('/api/:session/logout-session', authGuard, async (req, res) => {
    const { session } = req.params;
    await deleteSession(session);
    res.json({ status: 'success', message: 'Session logged out and disconnected.' });
});

// 5. Get Phone Number
app.get('/api/:session/get-phone-number', authGuard, async (req, res) => {
    const sessionDb = req.sessionDb;
    res.json({
        status: 'success',
        response: sessionDb.waNumber 
    });
});

// 6. Get LID Contact
app.get('/api/:session/contact/pn-lid/:from', authGuard, async (req, res) => {
    const { from } = req.params;
    res.json({
        phoneNumber: {
            id: from.split('@')[0] 
        }
    });
});

// Health check endpoint
app.get('/', (req, res) => {
    res.send('WhatsApp API is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));