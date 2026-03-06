import { WebSocketServer } from 'ws';
import log from '../utils/logger.js';
import { fetchDeviceStats, fetchLatestData, fetchDeviceData, fetchLatestRawData, fetchDeviceConfig, getAllDeviceStatusesData } from './frontendController.js';

let wss;

export const initWebSocket = (server) => {
    log.info('[WS] Initializing Socket Server');
    wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
        log.info('[WS] Client connected');

        ws.on('message', async (message) => {
            try {
                const req = JSON.parse(message);

                switch (req.type) {
                    case 'GET_STATS':
                        sendToClient(ws, 'STATS', await fetchDeviceStats(req.deviceId), { deviceId: req.deviceId });
                        break;
                    case 'GET_LATEST':
                        sendToClient(ws, 'LATEST', await fetchLatestData(req.deviceId), { deviceId: req.deviceId });
                        break;
                    case 'GET_LATEST_RAW':
                        sendToClient(ws, 'LATEST_RAW', await fetchLatestRawData(req.deviceId), { deviceId: req.deviceId });
                        break;
                    case 'GET_DEVICE_CONFIG':
                        sendToClient(ws, 'DEVICE_CONFIG', await fetchDeviceConfig(req.deviceId), { deviceId: req.deviceId });
                        break;
                    case 'GET_GRAPH':
                        const graphData = await fetchDeviceData(req.deviceId, req.options);
                        sendToClient(ws, 'GRAPH', graphData.data, { deviceId: req.deviceId, options: req.options, mappings: graphData.mappings });
                        break;
                    case 'GET_ALL_STATUSES':
                        sendToClient(ws, 'ALL_STATUSES', await getAllDeviceStatusesData());
                        break;
                    default:
                        log.warn(`[WS] Unknown message type: ${req.type}`);
                }
            } catch (e) {
                log.error('[WS] Socket handler error', e);
            }
        });

        ws.on('close', () => {
            log.info('[WS] Client disconnected');
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

export const sendToClient = (wsClient, type, payload, extra = {}) => {
    if (wsClient.readyState === wsClient.OPEN) {
        wsClient.send(JSON.stringify({ type, payload, ...extra }));
    }
};