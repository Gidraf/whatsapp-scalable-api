const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true },
    secret: { type: String, required: true },
    webhook: { type: String },
    status: { type: String, default: 'DISCONNECTED' }
}, { timestamps: true });

const authStateSchema = new mongoose.Schema({
    sessionId: { type: String, required: true },
    key: { type: String, required: true },
    data: { type: String, required: true }
});
// Compound index to ensure keys are unique per session
authStateSchema.index({ sessionId: 1, key: 1 }, { unique: true });

const messageSchema = new mongoose.Schema({
    messageId: { type: String, required: true },
    sessionId: { type: String, required: true },
    remoteJid: { type: String, required: true },
    fromMe: { type: Boolean, required: true },
    text: { type: String },
    timestamp: { type: Date, required: true }
});
messageSchema.index({ sessionId: 1, messageId: 1 }, { unique: true });

module.exports = {
    Session: mongoose.model('Session', sessionSchema),
    AuthState: mongoose.model('AuthState', authStateSchema),
    Message: mongoose.model('Message', messageSchema)
};