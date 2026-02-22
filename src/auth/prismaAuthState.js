const { BufferJSON, initAuthCreds } = require('@whiskeysockets/baileys');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const usePrismaAuthState = async (sessionId) => {
    const writeData = async (data, key) => {
        const json = JSON.stringify(data, BufferJSON.replacer);
        await prisma.authState.upsert({
            where: { sessionId_key: { sessionId, key } },
            create: { sessionId, key, data: json },
            update: { data: json }
        });
    };

    const readData = async (key) => {
        const result = await prisma.authState.findUnique({
            where: { sessionId_key: { sessionId, key } }
        });
        if (result) {
            return JSON.parse(result.data, BufferJSON.reviver);
        }
        return null;
    };

    const removeData = async (key) => {
        await prisma.authState.deleteMany({
            where: { sessionId, key }
        });
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
};

module.exports = usePrismaAuthState;