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

// 1. Generate Token: /api/v1/wabot/{session}/{wa_secret}/generate-token
app.post('/:session/:secret/generate-token', async (req, res) => {
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

// 2. Status Session: /api/v1/wabot/{session}/status-session
app.get('/:session/status-session', authGuard, async (req, res) => {
    const sessionDb = req.sessionDb;
    res.json({
        status: sessionDb.status,
        qrcode: sessionDb.qrCode || null,
        message: 'Session status retrieved'
    });
});

// 3. Start Session (Dynamic Webhook): /api/v1/wabot/{session}/start-session
app.post('/:session/start-session', authGuard, async (req, res) => {
    const { session } = req.params;
    const { webhook, waitQrCode } = req.body;
    
    let sock = getSession(session);
    if (!sock) {
        sock = await createSession(session, webhook);
    } else if (webhook) {
        // Update webhook dynamically if session already exists
        await Session.findOneAndUpdate({ sessionId: session }, { webhook });
    }

    // If Flask wants to wait for QR, give Baileys a second to generate it
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

// 4. Logout Session: /api/v1/wabot/{session}/logout-session
app.post('/:session/logout-session', authGuard, async (req, res) => {
    const { session } = req.params;
    await deleteSession(session);
    res.json({ status: 'success', message: 'Session logged out and disconnected.' });
});

// 5. Get Phone Number: /api/v1/wabot/{session}/get-phone-number
app.get('/:session/get-phone-number', authGuard, async (req, res) => {
    const sessionDb = req.sessionDb;
    res.json({
        status: 'success',
        response: sessionDb.waNumber // Returns the bot's ID e.g., 254712345678@s.whatsapp.net
    });
});

// 6. Get LID Contact: /api/v1/wabot/{session}/contact/pn-lid/{from}
app.get('/:session/contact/pn-lid/:from', authGuard, async (req, res) => {
    // Note: Baileys handles LID mapping internally, but you can mock this response 
    // or parse the ID from your database if needed.
    const { from } = req.params;
    res.json({
        phoneNumber: {
            id: from.split('@')[0] // Fallback mapping for your Flask app
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));