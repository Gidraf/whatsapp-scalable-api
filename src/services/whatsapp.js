const { default: makeWASocket, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const useMongoAuthState = require('../auth/mongoAuthState');
const { Session, AuthState } = require('../models');
const sendWebhook = require('./webhook');
const pino = require('pino');

const sessions = new Map();

const createSession = async (sessionId, customWebhook = null) => {
    const { state, saveCreds } = await useMongoAuthState(sessionId);
    
    if (customWebhook) {
        await Session.findOneAndUpdate({ sessionId }, { webhook: customWebhook }, { upsert: true, returnDocument: 'after' });
    }

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        generateHighQualityLinkPreview: true,
        syncFullHistory: false // Prevents massive data downloads on connect
    });

    sessions.set(sessionId, sock);

    sock.ev.process(async (events) => {
        // 1. Connection Lifecycle
        if (events['connection.update']) {
            const { connection, lastDisconnect, qr } = events['connection.update'];
            
            if (qr) {
                try {
                    const QRCode = require('qrcode');
                    const qrBase64 = (await QRCode.toDataURL(qr)).replace(/^data:image\/png;base64,/, "");
                    await Session.findOneAndUpdate({ sessionId }, { status: 'QR_READY', qrCode: qrBase64 });
                    await sendWebhook(sessionId, 'qrcode', { qrcode: qrBase64 });
                } catch (e) { console.error("QR Error:", e.message); }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                // 401: Logged out from phone | 500: Session keys are corrupted
                const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession;

                if (isLoggedOut) {
                    console.log(`❌ [${sessionId}] Session explicitly logged out or corrupted.`);
                    
                    // Update Database
                    await Session.findOneAndUpdate({ sessionId }, { status: 'DISCONNECTED', qrCode: null });
                    await AuthState.deleteMany({ sessionId });
                    sessions.delete(sessionId);
                    
                    // Notify Flask to update its DB and alert the frontend
                    await sendWebhook(sessionId, 'status-find', { status: 'logoutsession' });
                } else {
                    // It's just a network drop or Baileys internal restart. DO NOT wipe data.
                    console.log(`🔄 [${sessionId}] Network drop (Code: ${statusCode}). Reconnecting silently...`);
                    setTimeout(() => createSession(sessionId), 3000);
                }
            } else if (connection === 'open') {
                console.log(`✅ [${sessionId}] WhatsApp Connected successfully!`);
                await Session.findOneAndUpdate({ sessionId, status: 'CONNECTED', qrCode: null, waNumber: sock.user.id });
                await sendWebhook(sessionId, 'status-find', { status: 'qrReadSuccess' });
            }
        }

        if (events['creds.update']) await saveCreds();

        // 2. Pass Messages to Webhook
        if (events['messages.upsert']) {
            const m = events['messages.upsert'];
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (msg.key.fromMe) continue;
                    const messageType = Object.keys(msg.message || {})[0];
                    await sendWebhook(sessionId, 'onmessage', {
                        from: msg.key.remoteJid,
                        pushName: msg.pushName,
                        type: messageType,
                        message: msg.message,
                        raw: msg // Important for the Forwarding API
                    });
                }
            }
        }
        // 2. Stream Contacts directly to Flask
        if (events['contacts.upsert']) {
            const contacts = events['contacts.upsert'].map(c => ({
                id: c.id,
                name: c.name || c.notify || 'Unknown'
            }));
            await sendWebhook(sessionId, 'contacts-sync', { contacts });
        }

        // 3. Stream Chats directly to Flask
        if (events['chats.upsert']) {
            const chats = events['chats.upsert'].map(c => ({
                id: c.id,
                name: c.name || 'Unknown',
                unreadCount: c.unreadCount || 0
            }));
            await sendWebhook(sessionId, 'chats-sync', { chats });
        }
    });

    return sock;
};

const getSession = (sessionId) => sessions.get(sessionId);

// The API Logout endpoint triggers this
const deleteSession = async (sessionId) => {
    const sock = sessions.get(sessionId);
    if (sock) {
        try { await sock.logout(); } catch (e) {}
        sessions.delete(sessionId);
    }
    
    // Wipe DB
    await Session.findOneAndUpdate({ sessionId }, { status: 'DISCONNECTED', qrCode: null });
    await AuthState.deleteMany({ sessionId });
    
    // Notify Flask
    await sendWebhook(sessionId, 'status-find', { status: 'logoutsession' });
};

module.exports = { createSession, getSession, deleteSession };