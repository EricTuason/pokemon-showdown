// server/timeline-ui.ts

/**
 * Timeline UI - Data-driven tree visualizer
 *
 * Renders a scrollable branching tree using inline-styled HTML divs.
 * No SVG, no <style> blocks, no class-based CSS (all stripped by sanitizer).
 */

const SP = 'https://play.pokemonshowdown.com/sprites';

const NODE_W = 200;
// Height scales with team size; base header + per-row height
const HEADER_H = 28;
const SIDE_LABEL_H = 14;
const ROW_H = 22;        // height per pokemon row
const SIDE_PAD = 4;      // padding inside a side block
const MAX_TEAM = 6;
// NODE_H is computed dynamically per node based on team sizes
// For layout purposes we use a fixed estimate:
const NODE_H_BASE = HEADER_H + (SIDE_LABEL_H + SIDE_PAD * 2 + ROW_H * MAX_TEAM) * 2 + 8;

const GAP_X = 32;
const GAP_Y = 24;
const PAD  = 28;

const LANE_COLORS = [
	'#70a0ff', '#b090ff', '#70e080', '#f0d070',
	'#ff7088', '#70d0e0', '#ffa070', '#f0a0c0',
];

// ── Shared types ────────────────────────────────────────

export interface PokemonSnapshot {
	name: string;
	/** Sprite-compatible id: "deoxys-speed", "alomomola" */
	species: string;
	/** HP as percentage 0-100 */
	hp: number;
	/** Whether this pokemon is currently active on the field */
	isActive?: boolean;
	status?: string;
	/** Whether this pokemon has fainted */
	fainted?: boolean;
}

export interface TimelineNodeData {
	timelineId: string;
	timelineNum: number;
	turn: number;
	parentTimelineId: string | null;
	branchTurn: number | null;
	isCurrent: boolean;
	ended: boolean;
	/** Full team snapshot for player 1 */
	p1Team: PokemonSnapshot[];
	/** Full team snapshot for player 2 */
	p2Team: PokemonSnapshot[];
	/** @deprecated use p1Team[].isActive instead */
	p1Active?: PokemonSnapshot | null;
	/** @deprecated use p2Team[].isActive instead */
	p2Active?: PokemonSnapshot | null;
}

// ── Internal layout types ───────────────────────────────

interface LayoutNode {
	timelineId: string;
	timelineNum: number;
	turn: number;
	col: number;
	row: number;
	x: number;
	y: number;
	nodeH: number;
	color: string;
	isCurrent: boolean;
	ended: boolean;
	isFirst: boolean;
	isBranch: boolean;
	branchFromCol: number | null;
	branchFromRow: number | null;
	branchLabel: string | null;
	p1Team: PokemonSnapshot[];
	p2Team: PokemonSnapshot[];
}

interface Connection {
	type: 'vertical' | 'branch';
	x1: number; y1: number;
	x2: number; y2: number;
	color: string;
	dotColor?: string;
}

// ── Helpers ─────────────────────────────────────────────

function computeNodeH(p1Team: PokemonSnapshot[], p2Team: PokemonSnapshot[]): number {
	const p1Rows = Math.max(p1Team.length, 1);
	const p2Rows = Math.max(p2Team.length, 1);
	const sideH = (rows: number) => SIDE_LABEL_H + SIDE_PAD * 2 + rows * ROW_H;
	return HEADER_H + sideH(p1Rows) + sideH(p2Rows) + 8;
}

// ── Layout computation ──────────────────────────────────

function computeLayout(data: TimelineNodeData[]): {
	nodes: LayoutNode[];
	connections: Connection[];
	width: number;
	height: number;
} {
	if (!data.length) return {nodes: [], connections: [], width: 0, height: 0};

	const timelineIds = [...new Set(data.map(n => n.timelineId))];
	const numForId = new Map<string, number>();
	for (const d of data) numForId.set(d.timelineId, d.timelineNum);
	timelineIds.sort((a, b) => (numForId.get(a) || 0) - (numForId.get(b) || 0));

	const colFor = new Map<string, number>();
	timelineIds.forEach((id, i) => colFor.set(id, i));

	const allTurns = [...new Set(data.map(n => n.turn))].sort((a, b) => a - b);
	const rowFor = new Map<number, number>();
	allTurns.forEach((t, i) => rowFor.set(t, i));

	const parentIdFor = new Map<string, string | null>();
	const branchTurnFor = new Map<string, number | null>();
	for (const d of data) {
		if (!parentIdFor.has(d.timelineId)) {
			parentIdFor.set(d.timelineId, d.parentTimelineId);
			branchTurnFor.set(d.timelineId, d.branchTurn);
		}
	}

	const grouped = new Map<string, TimelineNodeData[]>();
	for (const d of data) {
		if (!grouped.has(d.timelineId)) grouped.set(d.timelineId, []);
		grouped.get(d.timelineId)!.push(d);
	}
	for (const arr of grouped.values()) arr.sort((a, b) => a.turn - b.turn);

	// We need per-row max heights to compute y positions
	// First pass: compute node heights per (col, row)
	// For y positioning we use the max nodeH in each row
	const rowMaxH = new Map<number, number>();
	for (const [, tlNodes] of grouped) {
		for (const d of tlNodes) {
			const row = rowFor.get(d.turn) || 0;
			const p1Team = d.p1Team?.length ? d.p1Team : (d.p1Active ? [d.p1Active] : []);
			const p2Team = d.p2Team?.length ? d.p2Team : (d.p2Active ? [d.p2Active] : []);
			const h = computeNodeH(p1Team, p2Team);
			rowMaxH.set(row, Math.max(rowMaxH.get(row) || 0, h));
		}
	}

	// Compute cumulative y offsets per row
	const rowY = new Map<number, number>();
	let yAccum = PAD;
	const sortedRows = [...new Set(data.map(n => rowFor.get(n.turn) || 0))].sort((a, b) => a - b);
	for (const row of sortedRows) {
		rowY.set(row, yAccum);
		yAccum += (rowMaxH.get(row) || NODE_H_BASE) + GAP_Y;
	}

	// Build layout nodes
	const nodes: LayoutNode[] = [];
	for (const [tlId, tlNodes] of grouped) {
		const col = colFor.get(tlId) || 0;
		const color = LANE_COLORS[col % LANE_COLORS.length];
		const parentTlId = parentIdFor.get(tlId) || null;
		const bTurn = branchTurnFor.get(tlId) ?? null;

		tlNodes.forEach((d, idx) => {
			const row = rowFor.get(d.turn) || 0;
			const isFirst = idx === 0;
			const isBranch = isFirst && parentTlId !== null;

			const p1Team = d.p1Team?.length ? d.p1Team : (d.p1Active ? [d.p1Active] : []);
			const p2Team = d.p2Team?.length ? d.p2Team : (d.p2Active ? [d.p2Active] : []);
			const nodeH = computeNodeH(p1Team, p2Team);

			let branchFromCol: number | null = null;
			let branchFromRow: number | null = null;
			let branchLabel: string | null = null;
			if (isBranch && parentTlId) {
				branchFromCol = colFor.get(parentTlId) ?? null;
				branchFromRow = bTurn !== null ? (rowFor.get(bTurn) ?? null) : null;
				const pNum = numForId.get(parentTlId) || '?';
				branchLabel = `from #${pNum} t${bTurn ?? '?'}`;
			}

			nodes.push({
				timelineId: tlId, timelineNum: d.timelineNum,
				turn: d.turn, col, row,
				x: PAD + col * (NODE_W + GAP_X),
				y: rowY.get(row) || PAD,
				nodeH,
				color, isCurrent: d.isCurrent, ended: d.ended,
				isFirst, isBranch,
				branchFromCol, branchFromRow, branchLabel,
				p1Team, p2Team,
			});
		});
	}

	// Build connections
	const connections: Connection[] = [];

	// Vertical lines within each timeline
	for (const [tlId] of grouped) {
		const tlNodes = nodes
			.filter(n => n.timelineId === tlId)
			.sort((a, b) => a.turn - b.turn);
		for (let i = 0; i < tlNodes.length - 1; i++) {
			const a = tlNodes[i];
			const b = tlNodes[i + 1];
			connections.push({
				type: 'vertical',
				x1: a.x + NODE_W / 2,
				y1: a.y + a.nodeH,
				x2: b.x + NODE_W / 2,
				y2: b.y,
				color: a.color,
			});
		}
	}

	// Branch lines
	for (const n of nodes) {
		if (!n.isBranch || n.branchFromCol === null || n.branchFromRow === null) continue;
		const px = PAD + n.branchFromCol * (NODE_W + GAP_X) + NODE_W;
		const parentRowH = rowMaxH.get(n.branchFromRow) || NODE_H_BASE;
		const py = (rowY.get(n.branchFromRow) || PAD) + parentRowH / 2;
		const parentColor = LANE_COLORS[n.branchFromCol % LANE_COLORS.length];
		connections.push({
			type: 'branch',
			x1: px,
			y1: py,
			x2: n.x,
			y2: n.y + n.nodeH / 2,
			color: n.color,
			dotColor: parentColor,
		});
	}

	const maxCol = Math.max(...nodes.map(n => n.col), 0);
	const totalH = yAccum;

	return {
		nodes, connections,
		width: PAD * 2 + (maxCol + 1) * (NODE_W + GAP_X) - GAP_X,
		height: totalH,
	};
}

// ── Sprite URL ──────────────────────────────────────────

function gen5Sprite(speciesId: string): string {
	return `${SP}/gen5/${speciesId}.png`;
}

// ── HTML fragments ──────────────────────────────────────

/**
 * Renders a single pokemon row inside a side block.
 * Layout: [sprite 20x15] [name/status] [HP bar]
 */
function pokeRowHTML(poke: PokemonSnapshot): string {
	const fainted = poke.fainted || poke.hp <= 0;
	const hpColor = fainted
		? '#bbb'
		: poke.hp > 50 ? '#4caf50'
		: poke.hp > 20 ? '#f0d040'
		: '#e04040';

	const activeDot = poke.isActive
		? '<div style="width:5px;height:5px;border-radius:50%;background:#4caf50;' +
		  'flex-shrink:0;align-self:center;margin-right:2px;"></div>'
		: '<div style="width:5px;flex-shrink:0;margin-right:2px;"></div>';

	const statusBadge = poke.status && !fainted
		? `<span style="display:inline-block;font-size:6px;padding:0 2px;border-radius:2px;` +
		  `background:#888;color:white;margin-left:2px;text-transform:uppercase;` +
		  `vertical-align:middle;line-height:9px;">${poke.status}</span>`
		: fainted
		? `<span style="display:inline-block;font-size:6px;padding:0 2px;border-radius:2px;` +
		  `background:#e04040;color:white;margin-left:2px;vertical-align:middle;` +
		  `line-height:9px;">FNT</span>`
		: '';

	const nameStyle = fainted ? 'color:#aaa;text-decoration:line-through;' : 'color:#333;';
	const imgStyle = fainted ? 'opacity:0.35;' : '';

	return '<div style="display:flex;align-items:center;height:' + ROW_H + 'px;' +
		'padding:0 4px;box-sizing:border-box;">' +
		activeDot +
		// Sprite
		`<img src="${gen5Sprite(poke.species)}" width="20" height="15" ` +
		`style="image-rendering:pixelated;flex-shrink:0;${imgStyle}" />` +
		// Name + status
		'<div style="flex:1;min-width:0;margin-left:3px;">' +
		`<div style="font-size:8px;font-weight:${poke.isActive ? 'bold' : 'normal'};` +
		`${nameStyle}overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` +
		`line-height:11px;">${poke.name}${statusBadge}</div>` +
		// HP bar
		'<div style="width:100%;height:3px;background:#e0e0e0;border-radius:2px;' +
		'overflow:hidden;margin-top:1px;">' +
		`<div style="width:${fainted ? 0 : poke.hp}%;height:100%;background:${hpColor};` +
		`border-radius:2px;transition:width 0.3s;"></div>` +
		'</div>' +
		'</div>' +
		'</div>';
}

/**
 * Renders a side block (P1 or P2) with label + all team members.
 */
function sideBlockHTML(team: PokemonSnapshot[], label: string, borderColor: string): string {
	const rows = team.length
		? team.map(p => pokeRowHTML(p)).join('')
		: '<div style="height:' + ROW_H + 'px;display:flex;align-items:center;' +
		  'justify-content:center;font-size:9px;color:#bbb;">\u2014</div>';

	return '<div style="border:1px solid ' + borderColor + '30;border-radius:4px;' +
		'margin:2px 4px;background:' + borderColor + '08;">' +
		// Label bar
		'<div style="font-size:8px;font-weight:bold;color:' + borderColor + ';' +
		'padding:1px 5px;border-bottom:1px solid ' + borderColor + '30;' +
		'background:' + borderColor + '14;border-radius:4px 4px 0 0;">' +
		label + '</div>' +
		rows +
		'</div>';
}

function nodeCardHTML(node: LayoutNode): string {
	const borderW = node.isCurrent ? 3 : 2;
	const borderColor = node.isCurrent ? '#ff6b6b' : node.color;
	const bg = node.ended ? '#f5f5f5' : (node.isCurrent ? '#fff8f0' : 'white');
	const shadow = node.isCurrent ? 'box-shadow:0 0 8px rgba(255,107,107,0.4);' : '';

	const branchTag = node.branchLabel
		? `<div style="position:absolute;top:-9px;right:6px;font-size:7px;` +
		  `background:#e74c3c;color:white;padding:1px 5px;border-radius:3px;` +
		  `white-space:nowrap;z-index:1;">${node.branchLabel}</div>`
		: '';

	const endedBadge = node.ended
		? '<span style="font-size:8px;color:#999;font-weight:normal;"> ended</span>'
		: '';

	const p1HTML = sideBlockHTML(node.p1Team, 'P1', node.color);
	const p2HTML = sideBlockHTML(node.p2Team, 'P2', '#e07070');

	return `<div style="position:absolute;left:${node.x}px;top:${node.y}px;` +
		`width:${NODE_W}px;height:${node.nodeH}px;">` +
		`<div style="width:100%;height:100%;border:${borderW}px solid ${borderColor};` +
		`border-radius:8px;background:${bg};${shadow}overflow:hidden;position:relative;` +
		`box-sizing:border-box;">` +
		branchTag +
		// Header
		`<div style="display:flex;justify-content:space-between;align-items:center;` +
		`height:${HEADER_H}px;padding:0 8px;background:${node.color}18;` +
		`border-bottom:1px solid ${node.color}40;flex-shrink:0;">` +
		`<span style="font-size:10px;font-weight:bold;color:#444;">` +
		`Turn ${node.turn}${endedBadge}</span>` +
		`<span style="font-size:9px;font-weight:bold;color:${node.color};">#${node.timelineNum}</span>` +
		'</div>' +
		// Teams
		p1HTML +
		p2HTML +
		'</div></div>';
}

function verticalLineHTML(c: Connection): string {
	const h = c.y2 - c.y1;
	if (h <= 0) return '';
	return `<div style="position:absolute;left:${c.x1 - 1}px;top:${c.y1}px;` +
		`width:3px;height:${h}px;background:${c.color};border-radius:2px;` +
		`opacity:0.6;"></div>`;
}

function branchLineHTML(c: Connection): string {
	const dx = c.x2 - c.x1;
	const dy = c.y2 - c.y1;
	const len = Math.sqrt(dx * dx + dy * dy);
	const angle = Math.atan2(dy, dx) * (180 / Math.PI);

	return (
		`<div style="position:absolute;left:${c.x1}px;top:${c.y1}px;` +
		`width:${Math.round(len)}px;height:0;border-top:2px dashed ${c.color};` +
		`transform-origin:0 0;transform:rotate(${angle.toFixed(1)}deg);` +
		`opacity:0.7;"></div>` +
		`<div style="position:absolute;left:${c.x1 - 5}px;top:${c.y1 - 5}px;` +
		`width:10px;height:10px;border-radius:50%;` +
		`background:${c.dotColor || c.color};border:2px solid white;"></div>`
	);
}

// ── Main export ─────────────────────────────────────────

export function generateTimelineHTML(data: {nodes: TimelineNodeData[]}): string {
	const nodes = data.nodes;
	if (!nodes.length) {
		return '<div style="margin:8px 0;padding:30px 20px;border:2px solid #aaa;' +
			'border-radius:6px;background:white;text-align:center;color:#999;' +
			'font-size:14px;">No timeline data yet</div>';
	}

	const layout = computeLayout(nodes);
	if (!layout.nodes.length) {
		return '<div style="margin:8px 0;padding:30px 20px;border:2px solid #aaa;' +
			'border-radius:6px;background:white;text-align:center;color:#999;' +
			'font-size:14px;">No timeline data yet</div>';
	}

	const timelineCount = new Set(nodes.map(n => n.timelineId)).size;
	const maxTurn = Math.max(...nodes.map(n => n.turn));
	const currentNode = layout.nodes.find(n => n.isCurrent);
	const countLabel = `${timelineCount} timeline${timelineCount !== 1 ? 's' : ''}` +
		` \u00b7 ${maxTurn} turn${maxTurn !== 1 ? 's' : ''}` +
		(currentNode ? ` \u00b7 Active: #${currentNode.timelineNum}` : '');

	const connHTML = layout.connections.map(c =>
		c.type === 'vertical' ? verticalLineHTML(c) : branchLineHTML(c)
	).join('');

	const nodeHTML = layout.nodes.map(n => nodeCardHTML(n)).join('');

	// Legend
	const usedCols = [...new Set(layout.nodes.map(n => n.col))].sort((a, b) => a - b);
	const legendItems = usedCols.map(c => {
		const color = LANE_COLORS[c % LANE_COLORS.length];
		const num = layout.nodes.find(n => n.col === c)?.timelineNum ?? c + 1;
		return `<div style="display:inline-flex;align-items:center;gap:4px;">` +
			`<div style="width:10px;height:10px;border-radius:50%;background:${color};"></div>` +
			`<span>#${num}</span></div>`;
	}).join('');

	const branchLeg = '<div style="display:inline-flex;align-items:center;gap:4px;">' +
		'<div style="width:16px;border-top:2px dashed #e74c3c;"></div>' +
		'<span>Branch</span></div>';
	const currentLeg = '<div style="display:inline-flex;align-items:center;gap:4px;">' +
		'<div style="width:10px;height:10px;border-radius:50%;border:2px solid #ff6b6b;"></div>' +
		'<span>Current</span></div>';
	const activeLeg = '<div style="display:inline-flex;align-items:center;gap:4px;">' +
		'<div style="width:6px;height:6px;border-radius:50%;background:#4caf50;"></div>' +
		'<span>Active</span></div>';

	return '<div style="margin:8px 0;padding:12px;border:2px solid #aaa;border-radius:6px;' +
		'background:white;font-family:Arial,Helvetica,sans-serif;">' +
		// Header bar
		'<div style="display:flex;justify-content:space-between;align-items:center;' +
		'margin-bottom:10px;padding-bottom:8px;border-bottom:2px solid #ddd;">' +
		'<span style="font-weight:bold;font-size:14px;color:#333;">Timeline Map</span>' +
		'<span style="font-size:11px;color:white;background:#4a90e2;padding:3px 10px;' +
		`border-radius:4px;font-weight:bold;">${countLabel}</span>` +
		'</div>' +
		// Scrollable graph
		'<div style="overflow:auto;max-height:520px;max-width:100%;' +
		'-webkit-overflow-scrolling:touch;' +
		'background:#fafafa;border:1px solid #e0e0e0;border-radius:4px;padding:4px;">' +
		`<div style="position:relative;width:${layout.width}px;` +
		`height:${layout.height}px;min-width:${layout.width}px;">` +
		connHTML + nodeHTML +
		'</div></div>' +
		// Legend
		'<div style="display:flex;gap:16px;margin-top:10px;padding-top:8px;' +
		'border-top:1px solid #ddd;flex-wrap:wrap;justify-content:center;' +
		'font-size:11px;color:#666;">' +
		legendItems + branchLeg + currentLeg + activeLeg +
		'</div></div>';
}