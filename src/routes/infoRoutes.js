const express = require('express');
const { getSession, getStore } = require('../services/whatsapp');
const router = express.Router({ mergeParams: true });

const requireSock = (req, res, next) => {
    req.sock = getSession(req.params.session);
    req.store = getStore(req.params.session);
    if (!req.sock) return res.status(400).json({ error: 'Disconnected' });
    next();
};

router.use(requireSock);

// Get Chats
router.get('/chats', (req, res) => {
    res.json({ status: 'success', response: req.store.chats.all() });
});

// Get Contacts
router.get('/contacts', (req, res) => {
    res.json({ status: 'success', response: Object.values(req.store.contacts) });
});

// Get Groups & Members
router.get('/groups', async (req, res) => {
    try {
        const groups = await req.sock.groupFetchAllParticipating();
        res.json({ status: 'success', response: groups });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get Blocklist
router.get('/blocklist', async (req, res) => {
    try {
        const blocklist = await req.sock.fetchBlocklist();
        res.json({ status: 'success', response: blocklist });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;