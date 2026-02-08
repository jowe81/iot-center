import { getDb } from '../config/db.js';
import { ObjectId } from 'mongodb';

export const addCommand = async (deviceId, commandObj) => {
    const db = getDb();
    const result = await db.collection('command_queue').insertOne({
        deviceId,
        command: commandObj,
        status: 'pending',
        createdAt: new Date()
    });
    return result.insertedId;
};

export const markCommandAsSent = async (commandId) => {
    const db = getDb();
    await db.collection('command_queue').updateOne(
        { _id: new ObjectId(commandId) },
        { $set: { status: 'sent', sentAt: new Date() } }
    );
};

export const getPendingCommands = async (deviceId) => {
    const db = getDb();
    const commandQueue = db.collection('command_queue');
    
    const pendingCommands = await commandQueue.find({ deviceId, status: 'pending' }).toArray();
    
    if (pendingCommands.length === 0) {
        return null;
    }

    const commands = {};
    const commandIds = [];

    for (const cmd of pendingCommands) {
        commandIds.push(cmd._id.toString());
        for (const [subDevice, subCmds] of Object.entries(cmd.command)) {
            if (!commands[subDevice]) {
                commands[subDevice] = {};
            }
            Object.assign(commands[subDevice], subCmds);
        }
    }

    // Mark as sent
    const objectIds = commandIds.map(id => new ObjectId(id));
    await commandQueue.updateMany(
        { _id: { $in: objectIds } },
        { $set: { status: 'sent', sentAt: new Date() } }
    );

    if (commandIds.length > 0) {
        commands._ack = commandIds.join(',');
    }

    return commands;
};

export const acknowledgeCommands = async (commandIdsString) => {
    if (!commandIdsString) return [];
    
    let idsStr = commandIdsString;

    try {
        const trimmed = idsStr.trim();
        if (trimmed.startsWith('{')) {
            const json = JSON.parse(trimmed);
            if (json._ack) {
                idsStr = String(json._ack);
            }
        }
    } catch (e) { /* ignore */ }

    const cleanString = idsStr.replace(/\0/g, '');
    const ids = cleanString.split(',').map(id => id.trim()).filter(id => id);
    if (ids.length === 0) return [];

    const db = getDb();
    const objectIds = ids.map(id => {
        try { return new ObjectId(id); } catch (e) { return null; }
    }).filter(id => id);

    if (objectIds.length > 0) {
        const result = await db.collection('command_queue').updateMany(
            { _id: { $in: objectIds } },
            { $set: { status: 'acknowledged', ackAt: new Date() } }
        );
        if (result.matchedCount > 0) {
            return objectIds.map(id => id.toString());
        }
    }
    return [];
};