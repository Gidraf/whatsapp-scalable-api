const { default: makeWASocket, DisconnectReason, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const useMongoAuthState = require('../auth/mongoAuthState');
const { Session, AuthState } = require('../models');
const sendWebhook = require('./webhook');
const pino = require('pino');

const sessions = new Map();
const retryCounts = new Map(); // 👈 Tracks retry attempts per session
const pendingSessions = new Set(); // 👈 NEW: Synchronous Lock

const createSession = async (sessionId, customWebhook = null) => {
    // 1. SYNCHRONOUS LOCK: Instantly block duplicate React requests
    if (sessions.has(sessionId) || pendingSessions.has(sessionId)) {
        console.log(`⚠️ [${sessionId}] is already booting. Ignoring duplicate request.`);
        return sessions.get(sessionId) || null;
    }

    // Lock it down before we make ANY database calls
    pendingSessions.add(sessionId);

    try {
        const { state, saveCreds } = await useMongoAuthState(sessionId);
        
        if (customWebhook) {
            await Session.findOneAndUpdate(
                { sessionId }, 
                { webhook: customWebhook }, 
                { upsert: true, returnDocument: 'after' }
            );
        }

        // 2. DYNAMIC VERSIONING: Fetch the absolute latest WA version to bypass 405 blocks
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`📱 Using WhatsApp Web v${version.join('.')}, isLatest: ${isLatest}`);

        const sock = makeWASocket({
            version, // 👈 Tell WhatsApp we are using the newest client
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: Browsers.macOS('Desktop'), // Default is safest
            generateHighQualityLinkPreview: true,
            syncFullHistory: false
        });

        // Save the socket and remove the pending lock
        sessions.set(sessionId, sock);
        pendingSessions.delete(sessionId);

    sock.ev.process(async (events) => {

        // 1. Connection Lifecycle
        if (events['connection.update']) {
            const { connection, lastDisconnect, qr } = events['connection.update'];
            
            if (qr) {
                await Session.findOneAndUpdate(
                    { sessionId }, 
                    { $set: { status: 'QR_READY', qrCode: qr } }
                );
                await sendWebhook(sessionId, 'qrcode', { qrcode: qr });
            }

            if (connection === 'close') {
                const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
                console.log(`⚠️ Connection closed. Status code: ${statusCode}. Details:`, lastDisconnect?.error?.message);
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;

                // Check if the API already marked this session as dead
                const sessionInDb = await Session.findOne({ sessionId });
                const isManuallyDisconnected = sessionInDb?.status === 'DISCONNECTED';

                // Abort reconnect if logged out from phone OR logged out via API
                if (isLoggedOut || isManuallyDisconnected) {
                    console.log(`❌ [${sessionId}] Session explicitly logged out or deleted.`);
                    retryCounts.delete(sessionId); // Clean up tracker
                    
                    await Session.findOneAndUpdate(
                        { sessionId }, 
                        { $set: { status: 'DISCONNECTED', qrCode: null } }
                    );
                    await AuthState.deleteMany({ sessionId });
                    sessions.delete(sessionId);
                    
                    // Only send webhook if logged out from the phone 
                    // (The API logout already sends its own webhook in deleteSession)
                    if (isLoggedOut) {
                        await sendWebhook(sessionId, 'connection-state', { status: 'DISCONNECTED', reason: 'logged_out' });
                    }
                } else {
                    // ---------------------------------------------------------
                    // RETRY LOGIC (30 Max, 1-Minute Delay)
                    // ---------------------------------------------------------
                    let currentRetries = retryCounts.get(sessionId) || 0;

                    if (currentRetries >= 30) {
                        console.log(`🚨 [${sessionId}] Max retries (30) reached. Deleting session permanently.`);
                        retryCounts.delete(sessionId);
                        
                        // Wipe the database
                        await Session.findOneAndUpdate(
                            { sessionId }, 
                            { $set: { status: 'DISCONNECTED', qrCode: null } }
                        );
                        await AuthState.deleteMany({ sessionId });
                        sessions.delete(sessionId);
                        
                        // Notify Flask to delete the integration
                        await sendWebhook(sessionId, 'connection-state', { status: 'DISCONNECTED', reason: 'max_retries_exceeded' });
                    } else {
                        currentRetries += 1;
                        retryCounts.set(sessionId, currentRetries);
                        
                        console.log(`🔄 [${sessionId}] Connection dropped (Code: ${statusCode}). Reconnecting attempt ${currentRetries}/30 in 1 minute...`);
                        
                        await Session.findOneAndUpdate(
                            { sessionId }, 
                            { $set: { status: 'RECONNECTING' } }
                        );
                        
                        await sendWebhook(sessionId, 'connection-state', { status: 'RECONNECTING', code: statusCode, attempt: currentRetries });
                        
                        // 60000 ms = 1 minute delay
                        setTimeout(() => createSession(sessionId, sessionInDb?.webhook), 60000);
                    }
                }
            } else if (connection === 'open') {
                console.log(`✅ [${sessionId}] WhatsApp Connected successfully!`);
                retryCounts.delete(sessionId); // 👈 Reset the tracker on success
                
                await Session.findOneAndUpdate(
                    { sessionId }, 
                    { $set: { status: 'CONNECTED', qrCode: null, waNumber: sock.user.id } }
                );
                
                await sendWebhook(sessionId, 'connection-state', { status: 'CONNECTED', waNumber: sock.user.id });
            }
        }

        // 2. Save Credentials to MongoDB
        if (events['creds.update']) {
            await saveCreds();
        }

        // 3. Stream Messages to Webhook (Stateless)
        if (events['messages.upsert']) {
            const m = events['messages.upsert'];
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (msg.key.fromMe) continue;
                    
                    const messageType = Object.keys(msg.message || {})[0];
                    let mediaBase64 = null;
                    let mimetype = null;

                    const mediaTypes = ['imageMessage', 'documentMessage', 'videoMessage', 'audioMessage'];
                    if (mediaTypes.includes(messageType)) {
                        try {
                            const buffer = await downloadMediaMessage(
                                msg,
                                'buffer',
                                { },
                                { logger: pino({ level: 'silent' }) }
                            );
                            mediaBase64 = buffer.toString('base64');
                            mimetype = msg.message[messageType]?.mimetype;
                        } catch (err) {
                            console.error(`❌ Failed to decrypt media for ${msg.key.remoteJid}:`, err.message);
                        }
                    }

                    await sendWebhook(sessionId, 'onmessage', {
                        from: msg.key.remoteJid,
                        pushName: msg.pushName,
                        type: messageType,
                        messageId: msg.key.id,
                        message: msg.message,
                        mediaBase64: mediaBase64,
                        mimetype: mimetype
                    });
                }
            }
        }

        // 4. Stream Contacts to Webhook
        if (events['contacts.upsert']) {
            const contacts = events['contacts.upsert'].map(c => ({
                id: c.id,
                name: c.name || c.notify || 'Unknown'
            }));
            await sendWebhook(sessionId, 'contacts-sync', { contacts });
        }

        // 5. Stream Chats to Webhook
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

const deleteSession = async (sessionId) => {
    const sock = sessions.get(sessionId);
    if (sock) {
        try { await sock.logout(); } catch (e) {}
        sessions.delete(sessionId);
    }
    retryCounts.delete(sessionId);
    
    // Wipe DB properly using $set
    await Session.findOneAndUpdate(
        { sessionId }, 
        { $set: { status: 'DISCONNECTED', qrCode: null } }
    );
    await AuthState.deleteMany({ sessionId });
    
    // Notify Webhook
    await sendWebhook(sessionId, 'connection-state', { status: 'DISCONNECTED', reason: 'manual_logout' });
};

// Auto-Restore Function
const restoreSessions = async () => {
    try {
        // Find both connected and previously reconnecting sessions to revive them
        const activeSessions = await Session.find({ status: { $in: ['CONNECTED', 'RECONNECTING'] } });
        console.log(`🔄 Found ${activeSessions.length} active sessions in DB. Booting them up...`);
        
        for (const sessionDb of activeSessions) {
            console.log(`🔌 Restoring session: [${sessionDb.sessionId}]`);
            await createSession(sessionDb.sessionId, sessionDb.webhook);
            await new Promise(resolve => setTimeout(resolve, 2000)); // 2s buffer to prevent rate-limiting
        }
    } catch (error) {
        console.error("❌ Failed to restore sessions:", error.message);
    }
};

module.exports = { createSession, getSession, deleteSession, restoreSessions };