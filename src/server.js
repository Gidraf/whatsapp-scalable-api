const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { createSession, getSession } = require('./services/whatsapp');
const qrcode = require('qrcode');

const app = express();
const prisma = new PrismaClient();

app.use(express.json());

// Middleware to check Session Secret
const authGuard = async (req, res, next) => {
    const { session } = req.params;
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;

    const sessionDb = await prisma.session.findUnique({ where: { sessionId: session } });
    if (!sessionDb) return res.status(404).json({ error: 'Session not found. Create it first.' });
    if (sessionDb.secret !== token) return res.status(401).json({ error: 'Unauthorized. Invalid secret.' });

    req.sessionDb = sessionDb;
    next();
};

// 1. Create a new Session configuration (Equivalent to generating token)
app.post('/api/:session/config', async (req, res) => {
    const { session } = req.params;
    const { secret, webhook } = req.body;
    
    await prisma.session.upsert({
        where: { sessionId: session },
        update: { secret, webhook },
        create: { sessionId: session, secret, webhook }
    });
    
    res.json({ status: 'success', message: 'Session configured successfully.' });
});

// 2. Start Session & Get QR (WPPConnect pattern)
app.post('/api/:session/start', authGuard, async (req, res) => {
    const { session } = req.params;
    
    let sock = getSession(session);
    if (!sock) {
        sock = await createSession(session);
    }

    // Wait briefly to see if QR is generated or already connected
    setTimeout(async () => {
        const state = await prisma.session.findUnique({ where: { sessionId: session } });
        res.json({ status: 'success', state: state.status, message: 'Process started. Listen to webhooks for QR or Connection state.' });
    }, 2000);
});

// 3. Send Text Message
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

// 4. Get Contacts
app.get('/api/:session/contacts', authGuard, async (req, res) => {
    const { session } = req.params;
    const sock = getSession(session);
    if (!sock) return res.status(400).json({ error: 'Session is not active' });

    // Baileys requires you to sync contacts from the store or phone
    res.json({ status: 'success', message: 'Contacts fetch endpoint (Add @whiskeysockets/baileys store logic here)' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));