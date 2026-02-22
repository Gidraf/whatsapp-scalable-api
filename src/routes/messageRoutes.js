const express = require('express');
const { getSession, getStore } = require('../services/whatsapp');
const router = express.Router({ mergeParams: true });

const formatJid = (phone) => phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;

// Middleware to grab socket
const requireSock = (req, res, next) => {
    req.sock = getSession(req.params.session);
    if (!req.sock) return res.status(400).json({ status: 'error', message: 'Session disconnected' });
    next();
};

router.use(requireSock);

// Send Text, Image, Video, Audio, Docs
router.post('/send', async (req, res) => {
    const { phone, type, text, url, caption, mimetype, filename, pollName, pollOptions, lat, lng, eventDetails } = req.body;
    let payload = {};

    if (type === 'text') payload = { text };
    else if (type === 'image') payload = { image: { url }, caption };
    else if (type === 'document') payload = { document: { url }, mimetype, fileName: filename };
    
    // 👇 Add the new types here
    else if (type === 'poll') {
        payload = { poll: { name: pollName, values: pollOptions, selectableCount: 1 } };
    } 
    else if (type === 'location') {
        payload = { location: { degreesLatitude: lat, degreesLongitude: lng } };
    } 
    else if (type === 'event') {
        payload = { eventMessage: eventDetails };
    }

    try {
        const result = await req.sock.sendMessage(formatJid(phone), payload);
        res.json({ status: 'success', response: result });
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});

// Send Sticker (Static or GIF)
router.post('/send-sticker', async (req, res) => {
    const { phone, url } = req.body;
    try {
        // Note: Baileys expects proper WebP buffers with EXIF data for stickers.
        const result = await req.sock.sendMessage(formatJid(phone), { sticker: { url } });
        res.json({ status: 'success', response: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send Location
router.post('/send-location', async (req, res) => {
    const { phone, lat, lng } = req.body;
    try {
        const result = await req.sock.sendMessage(formatJid(phone), { 
            location: { degreesLatitude: lat, degreesLongitude: lng }
        });
        res.json({ status: 'success', response: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send Contacts
router.post('/send-contact', async (req, res) => {
    const { phone, contactName, contactPhone } = req.body;
    const vcard = 'BEGIN:VCARD\n' 
        + 'VERSION:3.0\n' 
        + `FN:${contactName}\n` 
        + `TEL;type=CELL;type=VOICE;waid=${contactPhone}:+${contactPhone}\n` 
        + 'END:VCARD';
        
    try {
        const result = await req.sock.sendMessage(formatJid(phone), { 
            contacts: { displayName: contactName, contacts: [{ vcard }] }
        });
        res.json({ status: 'success', response: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Forward Message
router.post('/forward', async (req, res) => {
    const { phone, messageId, remoteJid } = req.body;
    const store = getStore(req.params.session);
    try {
        const msg = await store.loadMessage(remoteJid, messageId);
        if (!msg) return res.status(404).json({ error: 'Message not found in store' });
        
        const result = await req.sock.sendMessage(formatJid(phone), { forward: msg });
        res.json({ status: 'success', response: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send to Status
router.post('/send-status', async (req, res) => {
    const { type, text, url, caption } = req.body;
    let payload = type === 'text' ? { text } : { image: { url }, caption };
    try {
        const result = await req.sock.sendMessage('status@broadcast', payload);
        res.json({ status: 'success', response: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send to Channel
router.post('/send-channel', async (req, res) => {
    const { channelId, text } = req.body;
    // Channels use the @newsletter JID
    const jid = channelId.includes('@') ? channelId : `${channelId}@newsletter`;
    try {
        const result = await req.sock.sendMessage(jid, { text });
        res.json({ status: 'success', response: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;