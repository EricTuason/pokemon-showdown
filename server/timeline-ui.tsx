// server/timeline-ui.ts

/**
 * Timeline UI - Data-driven tree visualizer
 *
 * Renders a scrollable branching tree using inline-styled HTML divs.
 * No SVG, no <style> blocks, no class-based CSS (all stripped by sanitizer).
 */

const SP = 'https://play.pokemonshowdown.com/sprites';

const NODE_W = 170;
const NODE_H = 110;
const GAP_X = 28;
const GAP_Y = 20;
const PAD = 28;
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
	status?: string;
}

export interface TimelineNodeData {
	timelineId: string;
	timelineNum: number;
	turn: number;
	parentTimelineId: string | null;
	branchTurn: number | null;
	isCurrent: boolean;
	ended: boolean;
	p1Active: PokemonSnapshot | null;
	p2Active: PokemonSnapshot | null;
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
	color: string;
	isCurrent: boolean;
	ended: boolean;
	isFirst: boolean;
	isBranch: boolean;
	branchFromCol: number | null;
	branchFromRow: number | null;
	branchLabel: string | null;
	p1Active: PokemonSnapshot | null;
	p2Active: PokemonSnapshot | null;
}

interface Connection {
	type: 'vertical' | 'branch';
	x1: number; y1: number;
	x2: number; y2: number;
	color: string;
	dotColor?: string;
}

// ── Layout computation ──────────────────────────────────

function computeLayout(data: TimelineNodeData[]): {
	nodes: LayoutNode[];
	connections: Connection[];
	width: number;
	height: number;
} {
	if (!data.length) return {nodes: [], connections: [], width: 0, height: 0};

	// Unique timeline IDs sorted by their num
	const timelineIds = [...new Set(data.map(n => n.timelineId))];
	const numForId = new Map<string, number>();
	for (const d of data) numForId.set(d.timelineId, d.timelineNum);
	timelineIds.sort((a, b) => (numForId.get(a) || 0) - (numForId.get(b) || 0));

	const colFor = new Map<string, number>();
	timelineIds.forEach((id, i) => colFor.set(id, i));

	// Unique sorted turns → compact row indices
	const allTurns = [...new Set(data.map(n => n.turn))].sort((a, b) => a - b);
	const rowFor = new Map<number, number>();
	allTurns.forEach((t, i) => rowFor.set(t, i));

	// Parent/branch info per timeline (from first node encountered)
	const parentIdFor = new Map<string, string | null>();
	const branchTurnFor = new Map<string, number | null>();
	for (const d of data) {
		if (!parentIdFor.has(d.timelineId)) {
			parentIdFor.set(d.timelineId, d.parentTimelineId);
			branchTurnFor.set(d.timelineId, d.branchTurn);
		}
	}

	// Group by timeline, sorted by turn
	const grouped = new Map<string, TimelineNodeData[]>();
	for (const d of data) {
		if (!grouped.has(d.timelineId)) grouped.set(d.timelineId, []);
		grouped.get(d.timelineId)!.push(d);
	}
	for (const arr of grouped.values()) arr.sort((a, b) => a.turn - b.turn);

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

			let branchFromCol: number | null = null;
			let branchFromRow: number | null = null;
			let branchLabel: string | null = null;
			if (isBranch && parentTlId) {
				branchFromCol = colFor.get(parentTlId) ?? null;
				branchFromRow = bTurn !== null ? (rowFor.get(bTurn) ?? null) : null;
				const pNum = numForId.get(parentTlId) || '?';
				branchLabel = `from ${pNum}:${bTurn ?? '?'}`;
			}

			nodes.push({
				timelineId: tlId, timelineNum: d.timelineNum,
				turn: d.turn, col, row,
				x: PAD + col * (NODE_W + GAP_X),
				y: PAD + row * (NODE_H + GAP_Y),
				color, isCurrent: d.isCurrent, ended: d.ended,
				isFirst, isBranch,
				branchFromCol, branchFromRow, branchLabel,
				p1Active: d.p1Active, p2Active: d.p2Active,
			});
		});
	}

	// Build connections
	const connections: Connection[] = [];

	// Vertical progression lines within each timeline
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
				y1: a.y + NODE_H,       // bottom edge of card
				x2: b.x + NODE_W / 2,
				y2: b.y,                 // top edge of next card
				color: a.color,
			});
		}
	}

	// Branch lines from parent node to child's first node
	for (const n of nodes) {
		if (!n.isBranch || n.branchFromCol === null || n.branchFromRow === null) continue;
		const px = PAD + n.branchFromCol * (NODE_W + GAP_X) + NODE_W;  // right edge of parent
		const py = PAD + n.branchFromRow * (NODE_H + GAP_Y) + NODE_H / 2;  // vertical center
		const parentColor = LANE_COLORS[n.branchFromCol % LANE_COLORS.length];
		connections.push({
			type: 'branch',
			x1: px,
			y1: py,
			x2: n.x,                    // left edge of child
			y2: n.y + NODE_H / 2,       // vertical center
			color: n.color,
			dotColor: parentColor,
		});
	}

	const maxCol = Math.max(...nodes.map(n => n.col), 0);
	const maxRow = Math.max(...nodes.map(n => n.row), 0);

	return {
		nodes, connections,
		width: PAD * 2 + (maxCol + 1) * (NODE_W + GAP_X) - GAP_X,
		height: PAD * 2 + (maxRow + 1) * (NODE_H + GAP_Y) - GAP_Y,
	};
}

// ── Sprite URL ──────────────────────────────────────────

function gen5Sprite(speciesId: string): string {
	// speciesId should already be "deoxys-speed", "alomomola" etc
	return `${SP}/gen5/${speciesId}.png`;
}

// ── HTML fragments ──────────────────────────────────────

function pokeSideHTML(poke: PokemonSnapshot | null, label: string): string {
	if (!poke) {
		return '<div style="display:flex;flex-direction:column;align-items:center;width:72px;">' +
			`<div style="width:40px;height:30px;display:flex;align-items:center;` +
			`justify-content:center;font-size:18px;color:#ccc;">\u2014</div>` +
			`<div style="font-size:9px;color:#bbb;margin-top:1px;">${label}</div>` +
			'</div>';
	}

	const hpColor = poke.hp > 50 ? '#4caf50' : poke.hp > 20 ? '#f0d040' : '#e04040';
	const statusHTML = poke.status
		? '<span style="display:inline-block;font-size:7px;padding:0 2px;border-radius:2px;' +
		  `background:#888;color:white;margin-left:2px;text-transform:uppercase;` +
		  `vertical-align:middle;line-height:10px;">${poke.status}</span>`
		: '';

	return '<div style="display:flex;flex-direction:column;align-items:center;width:72px;">' +
		// Sprite
		`<img src="${gen5Sprite(poke.species)}" width="40" height="30" ` +
		`style="image-rendering:pixelated;display:block;" />` +
		// Name on its own line
		'<div style="font-size:9px;font-weight:bold;color:#333;text-align:center;' +
		`width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` +
		`margin-top:1px;line-height:12px;">${poke.name}${statusHTML}</div>` +
		// HP bar
		'<div style="width:60px;height:4px;background:#ddd;border-radius:2px;' +
		'overflow:hidden;margin-top:2px;">' +
		`<div style="width:${poke.hp}%;height:100%;background:${hpColor};` +
		`border-radius:2px;"></div>` +
		'</div>' +
		'</div>';
}

function nodeCardHTML(node: LayoutNode): string {
	const borderW = node.isCurrent ? 3 : 2;
	const borderColor = node.isCurrent ? '#ff6b6b' : node.color;
	const bg = node.ended ? '#f5f5f5' : (node.isCurrent ? '#fff8f0' : 'white');
	const shadow = node.isCurrent ? 'box-shadow:0 0 8px rgba(255,107,107,0.4);' : '';

	// Branch tag (floats above card)
	const branchTag = node.branchLabel
		? `<div style="position:absolute;top:-9px;right:6px;font-size:8px;` +
		  `background:#e74c3c;color:white;padding:1px 5px;border-radius:3px;` +
		  `white-space:nowrap;">${node.branchLabel}</div>`
		: '';

	const endedBadge = node.ended
		? '<span style="font-size:8px;color:#999;font-weight:normal;"> ended</span>'
		: '';

	return `<div style="position:absolute;left:${node.x}px;top:${node.y}px;` +
		`width:${NODE_W}px;height:${NODE_H}px;">` +
		// Card
		`<div style="width:100%;height:100%;border:${borderW}px solid ${borderColor};` +
		`border-radius:8px;background:${bg};${shadow}overflow:hidden;position:relative;">` +
		branchTag +
		// Header
		`<div style="display:flex;justify-content:space-between;align-items:center;` +
		`padding:3px 8px;background:${node.color}18;border-bottom:1px solid ${node.color}40;">` +
		`<span style="font-size:10px;font-weight:bold;color:#444;">Turn ${node.turn}${endedBadge}</span>` +
		`<span style="font-size:9px;font-weight:bold;color:${node.color};">` +
		`#${node.timelineNum}</span>` +
		'</div>' +
		// Pokemon area: p1 vs p2 side by side
		'<div style="display:flex;align-items:center;justify-content:center;' +
		`padding:4px 2px 2px;gap:0px;height:${NODE_H - 28}px;">` +
		pokeSideHTML(node.p1Active, 'P1') +
		// VS divider
		'<div style="font-size:8px;color:#bbb;font-weight:bold;' +
		'margin:0 2px;align-self:center;">vs</div>' +
		pokeSideHTML(node.p2Active, 'P2') +
		'</div>' +
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
		// Dashed line
		`<div style="position:absolute;left:${c.x1}px;top:${c.y1}px;` +
		`width:${Math.round(len)}px;height:0;border-top:2px dashed ${c.color};` +
		`transform-origin:0 0;transform:rotate(${angle.toFixed(1)}deg);` +
		`opacity:0.7;"></div>` +
		// Dot at origin
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

	// Connections (render behind nodes)
	const connHTML = layout.connections.map(c =>
		c.type === 'vertical' ? verticalLineHTML(c) : branchLineHTML(c)
	).join('');

	// Nodes
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
		'<div style="overflow:auto;max-height:420px;max-width:100%;' +
		'-webkit-overflow-scrolling:touch;' +
		'background:#fafafa;border:1px solid #e0e0e0;border-radius:4px;padding:4px;">' +
		`<div style="position:relative;width:${layout.width}px;` +
		`height:${layout.height}px;min-width:${layout.width}px;">` +
		connHTML + nodeHTML +
		'</div></div>' +
		// Legend bar
		'<div style="display:flex;gap:16px;margin-top:10px;padding-top:8px;' +
		'border-top:1px solid #ddd;flex-wrap:wrap;justify-content:center;' +
		'font-size:11px;color:#666;">' +
		legendItems + branchLeg + currentLeg +
		'</div></div>';
}