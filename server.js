/**
 * HTTP Server for Multi-Battle Timeline System
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { MultiBattleManager } = require('./game-logic/MultiBattleManager');
const { parseBody } = require('./game-logic/helpers');
const { TEAMS } = require('./data/teams');

const PORT = 3001;

// ── MIME map for the static-file handler ──
const MIME = {
	'.css'  : 'text/css',
	'.js'   : 'application/javascript',
	'.html' : 'text/html',
};

// ============================================================
//  MANAGER INITIALIZATION
// ============================================================
const mgr = new MultiBattleManager();

// initial match so the manager page has something to show
const _init = mgr.createMatch({
	formatid: 'gen9ou',
	p1: { name: 'Red',  team: TEAMS.electric },
	p2: { name: 'Blue', team: TEAMS.grass    },
});
mgr.startTimeline(_init.timeline);

// ============================================================
//  HTTP SERVER
// ============================================================
const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);

	res.setHeader('Access-Control-Allow-Origin',  '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

	// ── page routes ───────────────────────────────────────
	if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
		try {
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end(fs.readFileSync(path.join(__dirname, 'multi-battle-ui.html'), 'utf-8'));
		} catch (e) {
			res.writeHead(500); res.end(e.message);
		}
		return;
	}

	if (req.method === 'GET' && url.pathname === '/lobby') {
		try {
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end(fs.readFileSync(path.join(__dirname, 'multiplayer-lobby.html'), 'utf-8'));
		} catch (e) {
			res.writeHead(500); res.end(e.message);
		}
		return;
	}

	if (req.method === 'GET' && url.pathname === '/battle') {
		try {
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end(fs.readFileSync(path.join(__dirname, 'multi-battle-ui-multiplayer.html'), 'utf-8'));
		} catch (e) {
			res.writeHead(500); res.end(e.message);
		}
		return;
	}

	// ── API: full state (manager or match-filtered) ──────
	if (req.method === 'GET' && url.pathname === '/api/state') {
		const battleId = url.searchParams.get('battleId') || null;
		res.writeHead(200, { 'Content-Type': 'application/json' });
		const state = mgr.getFullState(battleId);
		res.end(JSON.stringify({ ...state, teams: Object.keys(TEAMS) }));
		return;
	}

	// ── API: single-timeline state (multiplayer) ─────────
	if (req.method === 'GET' && url.pathname === '/api/battle-state') {
		const id   = url.searchParams.get('id');
		const side = url.searchParams.get('side') || null;
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(mgr.getBattleState(id, side)));
		return;
	}

	// ── API: transfer target list ─────────────────────────
	if (req.method === 'GET' && url.pathname === '/api/transfer-targets') {
		// extract matchId from an optional battleId (globalId)
		let matchId = null;
		const battleId = url.searchParams.get('battleId');
		if (battleId) {
			const parsed = mgr.parseGlobalId(battleId);
			if (parsed) matchId = parsed.match.id;
		}
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ targets: mgr.getTransferTargets(matchId) }));
		return;
	}

	// ── API: submit a move / switch choice ────────────────
	if (req.method === 'POST' && url.pathname === '/api/choice') {
		try {
			const body   = await parseBody(req);
			const result = mgr.submitChoice(body.battleId, body.side, body.choice);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				success: result === true,
				error  : result !== true ? result : null,
			}));
		} catch (e) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: false, error: e.message }));
		}
		return;
	}

	// ── API: queue a time-transfer ────────────────────────
	if (req.method === 'POST' && url.pathname === '/api/queue-transfer') {
		try {
			const body   = await parseBody(req);
			const result = mgr.queueTransfer(
				body.battleId,
				body.side,
				body.targetTimelineId,   // globalId of the target timeline
				body.targetTurn
			);

			// auto-submit move 1 for the transferring side so the turn
			// can resolve as soon as the opponent also chooses
			if (result.success && result.queued) {
				mgr.submitChoice(body.battleId, body.side, 'move 1');
			}

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(result));
		} catch (e) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: false, error: e.message }));
		}
		return;
	}

	// ── API: create a new match ───────────────────────────
	if (req.method === 'POST' && url.pathname === '/api/create') {
		try {
			const body  = await parseBody(req);
			const p1Team = TEAMS[body.p1Team];
			const p2Team = TEAMS[body.p2Team];
			if (!p1Team || !p2Team) throw new Error('Invalid team name');

			const { match, timeline } = mgr.createMatch({
				formatid: body.format || 'gen9ou',
				p1: { name: body.p1Name, team: p1Team },
				p2: { name: body.p2Name, team: p2Team },
			});
			mgr.startTimeline(timeline);

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true, id: timeline.globalId }));
		} catch (e) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: false, error: e.message }));
		}
		return;
	}

	// ── static files (.css .js .html) ─────────────────────
	const ext = path.extname(url.pathname);
	if (req.method === 'GET' && MIME[ext]) {
		const filePath = path.join(__dirname, url.pathname);
		if (filePath.startsWith(__dirname + path.sep)) {
			try {
				res.writeHead(200, { 'Content-Type': MIME[ext] });
				res.end(fs.readFileSync(filePath));
				return;
			} catch (_) { /* fall through to 404 */ }
		}
	}

	// ── 404 ───────────────────────────────────────────────
	res.writeHead(404);
	res.end('Not found');
});

server.listen(PORT, () => {
	console.log(`\n⏳  Pokemon Timeline Battle Manager`);
	console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
	console.log(` http://localhost:${PORT}`);
	console.log(` Initial match     ${_init.match.id}`);
	console.log(` Initial timeline  ${_init.timeline.globalId}`);
	console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});