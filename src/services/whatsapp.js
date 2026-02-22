const { default: makeWASocket, DisconnectReason, Browsers, makeInMemoryStore } = require('@whiskeysockets/baileys');
const useMongoAuthState = require('../auth/mongoAuthState');
const { Session, AuthState } = require('../models');
const sendWebhook = require('./webhook');
const pino = require('pino');

const sessions = new Map();
const stores = new Map();

const createSession = async (sessionId, customWebhook = null) => {
    const { state, saveCreds } = await useMongoAuthState(sessionId);
    
    if (customWebhook) {
        await Session.findOneAndUpdate({ sessionId }, { webhook: customWebhook }, { upsert: true, returnDocument: 'after' });
    }

    // Initialize or retrieve Store
    let store = stores.get(sessionId);
    if (!store) {
        store = makeInMemoryStore({ logger: pino({ level: 'silent' }) });
        stores.set(sessionId, store);
    }

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        generateHighQualityLinkPreview: true,
        syncFullHistory: false // Prevents webhook spam from downloading old messages
    });

    store.bind(sock.ev);
    sessions.set(sessionId, sock);

    sock.ev.process(async (events) => {
        
        // 1. Connection Updates
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
                
                // 401 = User clicked "Log Out" on phone. 500 = Encryption keys are corrupt/invalid.
                const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession;

                if (isLoggedOut) {
                    console.log(`❌ [${sessionId}] Session logged out or corrupted. Wiping data for fresh QR...`);
                    await Session.findOneAndUpdate({ sessionId }, { status: 'DISCONNECTED', qrCode: null });
                    await AuthState.deleteMany({ sessionId });
                    sessions.delete(sessionId);
                    stores.delete(sessionId);
                    
                    // Tell Flask to drop the connection so the UI asks for a new QR
                    await sendWebhook(sessionId, 'status-find', { status: 'logoutsession' });
                } else {
                    console.log(`🔄 [${sessionId}] Connection lost (Code: ${statusCode}). Reconnecting in 3s...`);
                    // IMPORTANT: We do NOT delete session data here. We just restart the socket.
                    setTimeout(() => {
                        createSession(sessionId);
                    }, 3000);
                }
            } else if (connection === 'open') {
                console.log(`✅ [${sessionId}] WhatsApp Connected successfully!`);
                await Session.findOneAndUpdate({ sessionId, status: 'CONNECTED', qrCode: null, waNumber: sock.user.id });
                await sendWebhook(sessionId, 'status-find', { status: 'qrReadSuccess' });
            }
        }

        // 2. Save Credentials
        if (events['creds.update']) {
            await saveCreds();
        }

        // 3. Forward Incoming Messages to Webhook
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
                        message: msg.message
                    });
                }
            }
        }
    });

    return sock;
};

const getSession = (sessionId) => sessions.get(sessionId);
const getStore = (sessionId) => stores.get(sessionId);

const deleteSession = async (sessionId) => {
    const sock = sessions.get(sessionId);
    if (sock) {
        try { await sock.logout(); } catch (e) {}
        sessions.delete(sessionId);
        stores.delete(sessionId);
    }
    await Session.findOneAndUpdate({ sessionId }, { status: 'DISCONNECTED', qrCode: null });
    await AuthState.deleteMany({ sessionId });
};

module.exports = { createSession, getSession, getStore, deleteSession };