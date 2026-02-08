import { WebSocketServer } from 'ws';
import log from '../utils/logger.js';
import { fetchDeviceStats, fetchLatestData, fetchDeviceData } from './frontendController.js';

let wss;

export const initWebSocket = (server) => {
    log.info('Initializing WebSocket Server');
    wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
        log.info('WS Client connected');

        ws.on('message', async (message) => {
            try {
                const req = JSON.parse(message);
                
                if (req.type === 'GET_STATS') {
                    const data = await fetchDeviceStats(req.deviceId);
                    ws.send(JSON.stringify({ type: 'STATS', deviceId: req.deviceId, payload: data }));
                } else if (req.type === 'GET_LATEST') {
                    const data = await fetchLatestData(req.deviceId);
                    ws.send(JSON.stringify({ type: 'LATEST', deviceId: req.deviceId, payload: data }));
                } else if (req.type === 'GET_GRAPH') {
                    const data = await fetchDeviceData(req.deviceId, req.options);
                    ws.send(JSON.stringify({ type: 'GRAPH', deviceId: req.deviceId, payload: data, options: req.options }));
                }
            } catch (e) {
                log.error('WS handler error', e);
            }
        });

        ws.on('close', () => {
            log.info('WS Client disconnected');
        });
    });
};

export const broadcast = (type, data) => {
    if (!wss) return;
    const message = JSON.stringify({ type, ...data });
    
    wss.clients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
            client.send(message);
        }
    });
};