/**
 * Timeline UI - Data-driven tree visualizer
 *
 * Renders a scrollable branching tree using inline-styled HTML divs.
 * No SVG, no <style> blocks, no class-based CSS (all stripped by sanitizer).
 */

const SP = 'https://play.pokemonshowdown.com/sprites';

/**
 * ── Node width budget ─────────────────────────────────────────────
 * Computed once, statically. We do NOT measure at render time.
 *
 *   node border (current, worst case)   4 × 2  =   8
 *   side-block horizontal margin        4 × 2  =   8
 *   side-block border                   1 × 2  =   2
 *   row horizontal padding              4 × 2  =   8
 *   sprite <img>                                 =  20
 *   sprite → name gap                            =   3
 *   name text — 18 chars, 8px Arial bold
 *     (≈5.8 px/char avg worst-case)     18 × 5.8 ≈ 105
 *   status badge — 2px margin + 4px pad
 *     + 3 glyphs @ 6px (≈12px)                   =  18
 *   safety slack                                 =   2
 *   ─────────────────────────────────────────────────────
 *   TOTAL                                        = 174
 */
const NODE_W = 174;

const HEADER_H = 28;
const SIDE_LABEL_H = 14;
const ROW_H = 22;
const SIDE_PAD = 4;
const MAX_TEAM = 6;

/**
 * Baseline node height for a 2-player, 6-mon-per-side node.
 * Used only as a defensive fallback in rowMaxH lookups — real heights
 * are computed per-node from whatever sides are actually present.
 * FFA nodes (4 sides) will be taller than this.
 */
const NODE_H_BASE = HEADER_H + (SIDE_LABEL_H + SIDE_PAD * 2 + ROW_H * MAX_TEAM) * 2 + 8;

const GAP_X = 32;
const GAP_Y = 24;
const PAD  = 28;

/** Fixed HP-bar width in px (≈ 8 'm' widths at the row's 8px font). */
const HP_BAR_PX = 64;

const LANE_COLORS = [
	'#70a0ff', '#b090ff', '#70e080', '#f0d070',
	'#ff7088', '#70d0e0', '#ffa070', '#f0a0c0',
];

/**
 * Per-player block border colors. P1 is special-cased to use the
 * timeline's lane color (see collectSides) so its block visually ties
 * to the timeline column — preserves the existing 2-player look.
 * P2–P4 get fixed colors so players are identifiable across timelines.
 */
const SIDE_COLORS = {
	p2: '#e07070',
	p3: '#60b060',
	p4: '#c09040',
};

const CURRENT_COLOR = '#111111';
const CURRENT_GLOW  = 'rgba(0,0,0,0.35)';

// ── Shared types ────────────────────────────────────────

export interface PokemonSnapshot {
	name: string;
	species: string;
	hp: number;
	isActive?: boolean;
	status?: string;
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
	p1Team: PokemonSnapshot[];
	p2Team: PokemonSnapshot[];
	/** Present only for FFA/multi formats. Absent → 2-player node. */
	p3Team?: PokemonSnapshot[];
	/** Present only for FFA/multi formats. Absent → 2-player node. */
	p4Team?: PokemonSnapshot[];
	/** @deprecated */ p1Active?: PokemonSnapshot | null;
	/** @deprecated */ p2Active?: PokemonSnapshot | null;
}

// ── Internal layout types ───────────────────────────────

/**
 * One side-block within a node card. `sides` on LayoutNode holds 2–4
 * of these depending on format, so the render path doesn't need to
 * know or care how many players there are.
 */
interface SideBlock {
	label: string;
	team: PokemonSnapshot[];
	color: string;
}

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
	/** 2 entries for singles/doubles, 4 for FFA/multi. */
	sides: SideBlock[];
}

interface Connection {
	type: 'vertical' | 'branch';
	x1: number; y1: number;
	x2: number; y2: number;
	color: string;
	dotColor?: string;
	path?: number[];
}

// ── Helpers ─────────────────────────────────────────────

/**
 * Gathers whichever sides exist on this node into a uniform array.
 * p1/p2 are always included (even if empty — they render as a '—' row)
 * to keep 2-player node shape stable. p3/p4 are only included when the
 * server sent them, so 2-player nodes stay the same height as before.
 *
 * P1's block color is the timeline's lane color — ties it visually to
 * the column. P2–P4 use fixed player colors so you can track "which
 * one is player 3" across different timelines.
 */
function collectSides(d: TimelineNodeData, laneColor: string): SideBlock[] {
	const out: SideBlock[] = [];

	// p1/p2: always present; honor deprecated single-active fallback
	const p1 = d.p1Team?.length ? d.p1Team : (d.p1Active ? [d.p1Active] : []);
	const p2 = d.p2Team?.length ? d.p2Team : (d.p2Active ? [d.p2Active] : []);
	out.push({label: 'P1', team: p1, color: laneColor});
	out.push({label: 'P2', team: p2, color: SIDE_COLORS.p2});

	// p3/p4: only when the server sent them (FFA/multi)
	if (d.p3Team) out.push({label: 'P3', team: d.p3Team, color: SIDE_COLORS.p3});
	if (d.p4Team) out.push({label: 'P4', team: d.p4Team, color: SIDE_COLORS.p4});

	return out;
}

/**
 * Sums side-block heights. Variable-length input means 2-player nodes
 * compute the same value as before, FFA nodes are just taller.
 */
function computeNodeH(sides: SideBlock[]): number {
	const sideH = (rows: number) => SIDE_LABEL_H + SIDE_PAD * 2 + rows * ROW_H;
	let total = HEADER_H + 8;
	for (const s of sides) {
		total += sideH(Math.max(s.team.length, 1));
	}
	return total;
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

	// Pre-compute row heights. Has to happen before node placement
	// because every node in a row sits at the same Y, determined by the
	// tallest node in that row. With FFA nodes in the mix, rows can be
	// mixed-height across timelines (a 2p branch next to a 4p branch)
	// — each node still computes its own nodeH for the card, but its Y
	// offset comes from the row's maximum.
	const rowMaxH = new Map<number, number>();
	for (const [tlId, tlNodes] of grouped) {
		const col = colFor.get(tlId) || 0;
		const laneColor = LANE_COLORS[col % LANE_COLORS.length];
		for (const d of tlNodes) {
			const row = rowFor.get(d.turn) || 0;
			const sides = collectSides(d, laneColor);
			const h = computeNodeH(sides);
			rowMaxH.set(row, Math.max(rowMaxH.get(row) || 0, h));
		}
	}

	const rowY = new Map<number, number>();
	let yAccum = PAD;
	const sortedRows = [...new Set(data.map(n => rowFor.get(n.turn) || 0))].sort((a, b) => a - b);
	for (const row of sortedRows) {
		rowY.set(row, yAccum);
		yAccum += (rowMaxH.get(row) || NODE_H_BASE) + GAP_Y;
	}

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

			const sides = collectSides(d, color);
			const nodeH = computeNodeH(sides);

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
				sides,
			});
		});
	}

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

	// Branch lines — routed strictly through gutters/row-gaps so they
	// never cross a node box, with a small per-branch offset so lines
	// sharing a gutter don't stack on top of each other.
	for (const n of nodes) {
		if (!n.isBranch || n.branchFromCol === null || n.branchFromRow === null) continue;

		const parentColor = LANE_COLORS[n.branchFromCol % LANE_COLORS.length];

		// Right edge of parent node, at its vertical center
		const px = PAD + n.branchFromCol * (NODE_W + GAP_X) + NODE_W;
		const parentRowH = rowMaxH.get(n.branchFromRow) || NODE_H_BASE;
		const py = (rowY.get(n.branchFromRow) || PAD) + parentRowH / 2;

		// Target: top-center of child node
		const tx = n.x + NODE_W / 2;
		const ty = n.y;

		// Per-branch jitter keyed off the child column (unique per
		// branch). 5 lanes spread across the gutter/row-gap; values
		// chosen to stay comfortably inside GAP_X/2 and GAP_Y/2.
		const lane = n.col % 5;                 // 0..4
		const xJit = (lane - 2) * 3;            // -6,-3,0,+3,+6
		const yJit = (lane - 2) * 2;            // -4,-2,0,+2,+4

		// Gutter immediately RIGHT of the PARENT column — the first
		// horizontal hop is never more than half a gutter wide, so it
		// cannot cross an intermediate column.
		const parentGutterX = px + GAP_X / 2 + xJit;

		// Row-gap immediately ABOVE the child row — the long horizontal
		// traverse runs here, between rows, guaranteed node-free.
		const gapY = ty - GAP_Y / 2 + yJit;

		//   parent-right → parent's right gutter
		//   ↓ down gutter to row-gap above child
		//   → across row-gap to child's x-center
		//   ↓ into child top
		const path = [
			px,            py,
			parentGutterX, py,
			parentGutterX, gapY,
			tx,            gapY,
			tx,            ty,
		];

		connections.push({
			type: 'branch',
			x1: px, y1: py, x2: tx, y2: ty,
			color: n.color,
			dotColor: parentColor,
			path,
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

function pokeRowHTML(poke: PokemonSnapshot): string {
	const fainted = poke.fainted || poke.hp <= 0;
	const hpColor = fainted
		? '#bbb'
		: poke.hp > 50 ? '#4caf50'
		: poke.hp > 20 ? '#f0d040'
		: '#e04040';

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
		`<img src="${gen5Sprite(poke.species)}" width="20" height="15" ` +
		`style="image-rendering:pixelated;flex-shrink:0;${imgStyle}" />` +
		'<div style="flex:1;min-width:0;margin-left:3px;">' +
		`<div style="font-size:8px;font-weight:${poke.isActive ? 'bold' : 'normal'};` +
		`${nameStyle}overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` +
		`line-height:11px;">${poke.name}${statusBadge}</div>` +
		`<div style="width:${HP_BAR_PX}px;height:3px;background:#e0e0e0;` +
		'border-radius:2px;overflow:hidden;margin-top:1px;">' +
		`<div style="width:${fainted ? 0 : poke.hp}%;height:100%;background:${hpColor};` +
		`border-radius:2px;transition:width 0.3s;"></div>` +
		'</div></div></div>';
}

function sideBlockHTML(team: PokemonSnapshot[], label: string, borderColor: string): string {
	const rows = team.length
		? team.map(p => pokeRowHTML(p)).join('')
		: '<div style="height:' + ROW_H + 'px;display:flex;align-items:center;' +
		  'justify-content:center;font-size:9px;color:#bbb;">\u2014</div>';

	return '<div style="border:1px solid ' + borderColor + '30;border-radius:4px;' +
		'margin:2px 4px;background:' + borderColor + '08;">' +
		'<div style="font-size:8px;font-weight:bold;color:' + borderColor + ';' +
		'padding:1px 5px;border-bottom:1px solid ' + borderColor + '30;' +
		'background:' + borderColor + '14;border-radius:4px 4px 0 0;">' +
		label + '</div>' +
		rows +
		'</div>';
}

function nodeCardHTML(node: LayoutNode): string {
	const borderW = node.isCurrent ? 4 : 2;
	const borderColor = node.isCurrent ? CURRENT_COLOR : node.color;
	const bg = node.ended ? '#f5f5f5' : (node.isCurrent ? '#fffef5' : 'white');

	const currentRing = node.isCurrent
		? `outline:3px solid ${node.color};outline-offset:3px;` +
		  `box-shadow:0 0 0 1px white,0 2px 14px ${CURRENT_GLOW};`
		: '';

	const currentBadge = node.isCurrent
		? `<div style="position:absolute;top:-12px;left:-6px;font-size:9px;` +
		  `font-weight:bold;letter-spacing:0.5px;background:${CURRENT_COLOR};` +
		  `color:white;padding:2px 8px;border-radius:4px;z-index:3;` +
		  `box-shadow:0 1px 4px rgba(0,0,0,0.3);">\u25B6 CURRENT</div>`
		: '';

	const branchTag = node.branchLabel
		? `<div style="position:absolute;top:-9px;right:6px;font-size:7px;` +
		  `background:#e74c3c;color:white;padding:1px 5px;border-radius:3px;` +
		  `white-space:nowrap;z-index:2;">${node.branchLabel}</div>`
		: '';

	const endedBadge = node.ended
		? '<span style="font-size:8px;color:#999;font-weight:normal;"> ended</span>'
		: '';

	// Side blocks — however many there are. 2 for singles, 4 for FFA.
	// sideBlockHTML already takes label/color as args so no change
	// there; this just stops hardcoding which two to draw.
	const sideBlocks = node.sides
		.map(s => sideBlockHTML(s.team, s.label, s.color))
		.join('');

	return `<div style="position:absolute;left:${node.x}px;top:${node.y}px;` +
		`width:${NODE_W}px;height:${node.nodeH}px;` +
		`${node.isCurrent ? 'z-index:5;' : ''}">` +
		currentBadge +
		`<div style="width:100%;height:100%;border:${borderW}px solid ${borderColor};` +
		`border-radius:8px;background:${bg};${currentRing}position:relative;` +
		`box-sizing:border-box;">` +
		branchTag +
		`<div style="display:flex;justify-content:space-between;align-items:center;` +
		`height:${HEADER_H}px;padding:0 8px;background:${node.color}18;` +
		`border-bottom:1px solid ${node.color}40;flex-shrink:0;` +
		`border-radius:6px 6px 0 0;">` +
		`<span style="font-size:10px;font-weight:bold;color:#444;">` +
		`Turn ${node.turn}${endedBadge}</span>` +
		`<span style="font-size:9px;font-weight:bold;color:${node.color};">#${node.timelineNum}</span>` +
		'</div>' +
		sideBlocks +
		'</div></div>';
}

function verticalLineHTML(c: Connection): string {
	const h = c.y2 - c.y1;
	if (h <= 0) return '';
	return `<div style="position:absolute;left:${c.x1 - 1}px;top:${c.y1}px;` +
		`width:3px;height:${h}px;background:${c.color};border-radius:2px;` +
		`opacity:0.6;"></div>`;
}

function dashedSegment(x1: number, y1: number, x2: number, y2: number, color: string): string {
	if (x1 === x2) {
		const top = Math.min(y1, y2);
		const h = Math.abs(y2 - y1);
		if (h <= 0) return '';
		return `<div style="position:absolute;left:${x1 - 1}px;top:${top}px;` +
			`width:0;height:${h}px;border-left:2px dashed ${color};` +
			`opacity:0.75;"></div>`;
	} else {
		const left = Math.min(x1, x2);
		const w = Math.abs(x2 - x1);
		if (w <= 0) return '';
		return `<div style="position:absolute;left:${left}px;top:${y1 - 1}px;` +
			`width:${w}px;height:0;border-top:2px dashed ${color};` +
			`opacity:0.75;"></div>`;
	}
}

function branchLineHTML(c: Connection): string {
	let segs = '';

	if (c.path && c.path.length >= 4) {
		for (let i = 0; i < c.path.length - 2; i += 2) {
			segs += dashedSegment(
				c.path[i], c.path[i + 1],
				c.path[i + 2], c.path[i + 3],
				c.color
			);
		}
	} else {
		const dx = c.x2 - c.x1;
		const dy = c.y2 - c.y1;
		const len = Math.sqrt(dx * dx + dy * dy);
		const angle = Math.atan2(dy, dx) * (180 / Math.PI);
		segs = `<div style="position:absolute;left:${c.x1}px;top:${c.y1}px;` +
			`width:${Math.round(len)}px;height:0;border-top:2px dashed ${c.color};` +
			`transform-origin:0 0;transform:rotate(${angle.toFixed(1)}deg);` +
			`opacity:0.75;"></div>`;
	}

	const dot = `<div style="position:absolute;left:${c.x1 - 5}px;top:${c.y1 - 5}px;` +
		`width:10px;height:10px;border-radius:50%;` +
		`background:${c.dotColor || c.color};border:2px solid white;` +
		`box-shadow:0 0 0 1px ${c.dotColor || c.color};"></div>`;

	return segs + dot;
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
	const currentNode = layout.nodes.find(n => n.isCurrent);
	const countLabel =
		`${timelineCount} Timeline${timelineCount !== 1 ? 's' : ''}` +
		(currentNode
			? ` \u2014 Present Timeline: #${currentNode.timelineNum}`
			: '');

	const connHTML = layout.connections.map(c =>
		c.type === 'vertical' ? verticalLineHTML(c) : branchLineHTML(c)
	).join('');

	const nodeHTML = layout.nodes.map(n => nodeCardHTML(n)).join('');

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
		`<div style="width:12px;height:12px;border-radius:3px;` +
		`border:3px solid ${CURRENT_COLOR};box-sizing:border-box;"></div>` +
		'<span>Current</span></div>';

	return '<div style="margin:8px 0;padding:12px;border:2px solid #aaa;border-radius:6px;' +
		'background:white;font-family:Arial,Helvetica,sans-serif;">' +
		'<div style="display:flex;justify-content:space-between;align-items:center;' +
		'margin-bottom:10px;padding-bottom:8px;border-bottom:2px solid #ddd;">' +
		'<span style="font-weight:bold;font-size:14px;color:#333;">Timeline Map</span>' +
		'<span style="font-size:11px;color:white;background:#4a90e2;padding:3px 10px;' +
		`border-radius:4px;font-weight:bold;">${countLabel}</span>` +
		'</div>' +
		'<div style="overflow:auto;max-height:520px;max-width:100%;' +
		'-webkit-overflow-scrolling:touch;' +
		'background:#fafafa;border:1px solid #e0e0e0;border-radius:4px;padding:4px;">' +
		`<div style="position:relative;width:${layout.width}px;` +
		`height:${layout.height}px;min-width:${layout.width}px;">` +
		connHTML + nodeHTML +
		'</div></div>' +
		'<div style="display:flex;gap:16px;margin-top:10px;padding-top:8px;' +
		'border-top:1px solid #ddd;flex-wrap:wrap;justify-content:center;' +
		'font-size:11px;color:#666;">' +
		legendItems + branchLeg + currentLeg +
		'</div></div>';
}