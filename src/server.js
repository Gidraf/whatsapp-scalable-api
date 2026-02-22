const express = require('express');
const mongoose = require('mongoose');
const { createSession, getSession } = require('./services/whatsapp');
const { Session } = require('./models');

const app = express();
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URL)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// Auth Guard Middleware
const authGuard = async (req, res, next) => {
    const { session } = req.params;
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;

    const sessionDb = await Session.findOne({ sessionId: session });
    if (!sessionDb) return res.status(404).json({ error: 'Session not found. Create it first.' });
    if (sessionDb.secret !== token) return res.status(401).json({ error: 'Unauthorized. Invalid secret.' });

    req.sessionDb = sessionDb;
    next();
};

app.post('/api/:session/config', async (req, res) => {
    const { session } = req.params;
    const { secret, webhook } = req.body;
    
    await Session.findOneAndUpdate(
        { sessionId: session },
        { sessionId: session, secret, webhook },
        { upsert: true, new: true }
    );
    
    res.json({ status: 'success', message: 'Session configured successfully.' });
});

app.post('/api/:session/start', authGuard, async (req, res) => {
    const { session } = req.params;
    
    let sock = getSession(session);
    if (!sock) {
        sock = await createSession(session);
    }

    setTimeout(async () => {
        const state = await Session.findOne({ sessionId: session });
        res.json({ status: 'success', state: state.status, message: 'Process started. Listen to webhooks.' });
    }, 2000);
});

app.post('/api/:session/send-message', authGuard, async (req, res) => {
    const { session } = req.params;
    const { phone, message } = req.body;

    const sock = getSession(session);
    if (!sock) return res.status(400).json({ error: 'Session is not active. Call /start first.' });

    try {
        const jid = `${phone}@s.whatsapp.net`;
        const result = await sock.sendMessage(jid, { text: message });
        res.json({ status: 'success', response: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));