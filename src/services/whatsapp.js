const { default: makeWASocket, DisconnectReason, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const useMongoAuthState = require('../auth/mongoAuthState');
const { Session, AuthState, Message } = require('../models');
const axios = require('axios');
const pino = require('pino');

const sessions = new Map();

// Formats and sends webhooks exactly how your Flask app expects them
const sendWebhook = async (sessionId, payload) => {
    try {
        const session = await Session.findOne({ sessionId });
        if (session && session.webhook) {
            await axios.post(session.webhook, payload);
        }
    } catch (err) {
        console.error(`Webhook error for session ${sessionId}:`, err.message);
    }
};

const createSession = async (sessionId, customWebhook = null) => {
    const { state, saveCreds } = await useMongoAuthState(sessionId);
    
    // Update webhook if provided dynamically during start-session
    if (customWebhook) {
        await Session.findOneAndUpdate({ sessionId }, { webhook: customWebhook });
    }

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
    });

    sessions.set(sessionId, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            await Session.findOneAndUpdate({ sessionId }, { status: 'QR_READY', qrCode: qr });
            await sendWebhook(sessionId, { event: 'status-find', session: sessionId, status: 'qrRead' });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                createSession(sessionId);
            } else {
                await Session.findOneAndUpdate({ sessionId }, { status: 'DISCONNECTED', qrCode: null });
                await AuthState.deleteMany({ sessionId });
                sessions.delete(sessionId);
                // Tells Flask to delete the integration
                await sendWebhook(sessionId, { event: 'status-find', session: sessionId, status: 'logoutsession' });
            }
        } else if (connection === 'open') {
            const user = sock.user;
            await Session.findOneAndUpdate({ 
                sessionId, 
                status: 'CONNECTED', 
                qrCode: null,
                waNumber: user.id
            });
            // Triggers "qrReadSuccess" in your Flask app
            await sendWebhook(sessionId, { event: 'status-find', session: sessionId, status: 'qrReadSuccess' });
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                if (msg.key.fromMe) continue;

                const messageType = Object.keys(msg.message || {})[0];
                let type = 'chat';
                let body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                let mimetype = null;
                let caption = msg.message?.imageMessage?.caption || msg.message?.documentMessage?.caption || '';
                let lat = null, lng = null;

                // Handle Media (Document / Image)
                if (messageType === 'imageMessage' || messageType === 'documentMessage') {
                    type = messageType === 'imageMessage' ? 'image' : 'document';
                    mimetype = msg.message[messageType].mimetype;
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', { }, { logger: pino({ level: 'silent' }) });
                        body = buffer.toString('base64'); // Flask will extract text from this base64 string
                    } catch (e) {
                        console.error('Failed to download media', e);
                    }
                } 
                // Handle Location
                else if (messageType === 'locationMessage') {
                    type = 'location';
                    lat = msg.message.locationMessage.degreesLatitude;
                    lng = msg.message.locationMessage.degreesLongitude;
                }

                const payload = {
                    event: 'onmessage',
                    session: sessionId,
                    from: msg.key.remoteJid,
                    type: type,
                    body: body,
                    caption: caption,
                    mimetype: mimetype,
                    lat: lat,
                    lng: lng,
                    sender: {
                        name: msg.pushName || 'User',
                        pushname: msg.pushName || 'User'
                    }
                };

                await sendWebhook(sessionId, payload);
            }
        }
    });

    return sock;
};

const getSession = (sessionId) => sessions.get(sessionId);

const deleteSession = async (sessionId) => {
    const sock = sessions.get(sessionId);
    if (sock) {
        await sock.logout();
        sessions.delete(sessionId);
    }
    await Session.findOneAndUpdate({ sessionId }, { status: 'DISCONNECTED', qrCode: null });
    await AuthState.deleteMany({ sessionId });
};

module.exports = { createSession, getSession, deleteSession };