import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { HttpDrive } from '../src/lib/http-drive.js';
import {
    APP_PROXY_MIME,
    registerProxiedApp,
    getProxiedApp,
    buildAppProxyUrl,
    appDefToFileItem,
    mergeAppsIntoRootItems
} from '../src/lib/app-proxy.js';

function makeLocalSocketTransport(port) {
    return () => {
        let sock = null;
        return {
            get isOpen() {
                return !!sock && !sock.destroyed;
            },
            get bufferedAmount() {
                return sock && sock.writableLength > 0 ? sock.writableLength : 0;
            },
            async connect(onData, onClose) {
                sock = net.connect(port, '127.0.0.1');
                sock.on('data', (d) => onData(new Uint8Array(d)));
                sock.on('close', () => onClose());
                await new Promise((resolve, reject) => {
                    sock.once('connect', resolve);
                    sock.once('error', reject);
                });
            },
            send(bytes) {
                sock.write(Buffer.from(bytes));
            },
            close() {
                if (sock) sock.destroy();
                sock = null;
            }
        };
    };
}

async function testLiveAutopilotOverHttpDrive() {
    const drive = new HttpDrive({
        transportFactory: makeLocalSocketTransport(4000),
        maxConns: 4,
        isPrivateMode: true
    });

    // 1. Discover apps on live node
    const appsResp = await drive.fetch('/api/node/apps', {
        method: 'GET',
        headers: [['X-Client', 'svar']]
    });
    assert.equal(appsResp.status, 200);
    const { apps } = await appsResp.json();
    const ap = apps.find((a) => a.slug === 'autopilot');
    assert.ok(ap, 'Autopilot discovered in /api/node/apps');
    assert.equal(ap.port, 4000);
    assert.equal(ap.entryPath, '/autopilot');

    // 2. Verify shortcut item & placement next to Terminal and Chats
    const item = appDefToFileItem('testnode123', ap);
    assert.equal(item.mimeType, APP_PROXY_MIME);
    assert.equal(getProxiedApp('testnode123', 'autopilot').port, 4000);
    assert.equal(buildAppProxyUrl('testnode123', 'autopilot'), '/__app/testnode123/autopilot/autopilot');

    const baseRoot = [
        { id: '/beelink/Documents', name: 'Documents', type: 'folder', isDir: true },
        { id: '/beelink/Terminal', name: 'Terminal', mimeType: 'application/x-terminal' },
        { id: '/beelink/Chats', name: 'Chats', mimeType: 'application/x-chat' }
    ];
    const merged = mergeAppsIntoRootItems('/beelink', baseRoot, [item]);
    assert.equal(merged.length, 4);
    assert.equal(merged[3].name, 'Autopilot');
    assert.equal(merged[3].id, '/beelink/__app_autopilot');

    // 3. Tunnel GET /autopilot HTML & GET /autopilot/api/state over HttpDrive
    const htmlResp = await drive.fetch('/autopilot', {
        method: 'GET',
        headers: [['Host', '127.0.0.1:4000']]
    });
    assert.equal(htmlResp.status, 200);
    const html = await htmlResp.text();
    assert.ok(html.includes('Autopilot') || html.includes('/autopilot/api/state'), 'Autopilot UI HTML loaded');

    const stateResp = await drive.fetch('/autopilot/api/state', {
        method: 'GET',
        headers: [['Host', '127.0.0.1:4000']]
    });
    assert.equal(stateResp.status, 200);
    const stateJson = await stateResp.json();
    assert.equal(typeof stateJson, 'object');

    drive.close();
    console.log('ok live Autopilot discovery + HTML + API state over HttpDrive');
}

async function testHeadAndEmptyPostFraming() {
    const server = http.createServer((req, res) => {
        if (req.method === 'HEAD') {
            res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': '12345' });
            res.end();
            return;
        }
        if (req.method === 'POST') {
            res.writeHead(302, {
                'Set-Cookie': ['_sess=abc123; Path=/; HttpOnly', 'theme=dark; Path=/'],
                Location: 'http://127.0.0.1/dashboard',
                'Content-Length': '0'
            });
            res.end();
            return;
        }
        res.writeHead(204);
        res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const drive = new HttpDrive({
        transportFactory: makeLocalSocketTransport(port),
        maxConns: 2
    });

    const headRes = await drive.fetch('/page', { method: 'HEAD', headers: [['Host', `127.0.0.1:${port}`]] });
    assert.equal(headRes.status, 200);
    assert.equal(await headRes.text(), '');

    const postRes = await drive.fetch('/login', { method: 'POST', headers: [['Host', `127.0.0.1:${port}`]] });
    assert.equal(postRes.status, 302);
    const setCookies = postRes._rawHeaders.filter(([k]) => k.toLowerCase() === 'set-cookie');
    assert.equal(setCookies.length, 2);

    const noContentRes = await drive.fetch('/ping', { method: 'GET' });
    assert.equal(noContentRes.status, 204);

    drive.close();
    await new Promise((r) => server.close(r));
    console.log('ok HEAD, empty POST Content-Length: 0, multi Set-Cookie, and 204 framing');
}

(async () => {
    await testHeadAndEmptyPostFraming();
    await testLiveAutopilotOverHttpDrive();
    console.log('ALL APP-PROXY TESTS PASSED');
    process.exit(0);
})().catch((e) => {
    console.error('APP-PROXY TEST FAILURE:', e);
    process.exit(1);
});
