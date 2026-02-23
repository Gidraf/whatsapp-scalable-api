const express = require('express');
const crypto = require('crypto');
const { createSession, getSession, deleteSession } = require('../services/whatsapp');
const { Session } = require('../models');

const router = express.Router({ mergeParams: true });

router.post('/:secret/generate-token', async (req, res) => {
    const { session, secret } = req.params;
    if (secret !== process.env.WA_SECRET) return res.status(401).json({ status: 'error', message: 'Invalid WA_SECRET' });

    const token = crypto.randomBytes(32).toString('hex');
    
    // 👈 ADDED $set here
    await Session.findOneAndUpdate(
        { sessionId: session }, 
        { $set: { sessionId: session, token: token } }, 
        { upsert: true, returnDocument: 'after' }
    );
    res.json({ status: 'success', token, full: `${session}-wabot`, message: 'Token generated' });
});

router.get('/status-session', async (req, res) => {
    res.json({ status: req.sessionDb.status, qrcode: req.sessionDb.qrCode, message: 'Session status retrieved' });
});

router.post('/start-session', async (req, res) => {
    const { session } = req.params;
    const { webhook } = req.body;
    let sock = getSession(session);
    
    if (!sock) {
        await createSession(session, webhook);
    } else if (webhook) {
        // 👈 ADDED $set here
        await Session.findOneAndUpdate(
            { sessionId: session }, 
            { $set: { webhook } } 
        );
    }

    setTimeout(async () => {
        const state = await Session.findOne({ sessionId: session });
        res.json({ status: 'success', state: state?.status, qrcode: state?.qrCode });
    }, 2000);
});

router.post('/logout-session', async (req, res) => {
    await deleteSession(req.params.session);
    res.json({ status: 'success', message: 'Logged out' });
});

router.get('/get-phone-number', (req, res) => {
    res.json({ status: 'success', response: req.sessionDb.waNumber });
});

module.exports = router;