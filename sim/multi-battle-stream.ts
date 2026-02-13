/**
 * Multi-Battle Stream
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Wraps MultiBattleManager to emulate the BattleStream interface.
 * Routes battle commands to the correct timeline and emits messages with timeline metadata.
 *
 * @license MIT
 */

import { Streams, Utils } from '../lib';
import type { PokemonSnapshot, TimelineNodeData } from '../server/timeline-ui';

function pokemonToSpriteId(pokemon: any): string {
	// pokemon.species.name preserves hyphens: "Deoxys-Speed", "Mr. Mime"
	// pokemon.species.id strips them: "deoxysspeed", "mrmime"
	// Gen5 sprite files USE hyphens for forms: deoxys-speed.png
	const name: string =
		pokemon.species?.name ||
		pokemon.speciesData?.name ||
		pokemon.name ||
		'substitute';
	return name
		.split(',')[0]  // strip gender suffix "Alomomola, M" → "Alomomola"
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, '');  // keep hyphens, strip spaces/periods/etc
}

function extractPokemonSnapshot(pokemon: any): PokemonSnapshot | null {
	if (!pokemon || pokemon.fainted) return null;
	const spriteId = pokemonToSpriteId(pokemon);
	return {
		name: pokemon.name || pokemon.species?.name || spriteId,
		species: spriteId,
		hp: pokemon.maxhp > 0 ? Math.round((pokemon.hp / pokemon.maxhp) * 100) : 0,
		status: pokemon.status || undefined,
	};
}
/** MultiBattleManager type - defined in game-logic/MultiBattleManager.js */
type MultiBattleManager = any;

/**
 * Like string.split(delimiter), but only recognizes the first `limit`
 * delimiters (default 1).
 */
function splitFirst(str: string, delimiter: string, limit = 1) {
	const splitStr: string[] = [];
	while (splitStr.length < limit) {
		const delimiterIndex = str.indexOf(delimiter);
		if (delimiterIndex >= 0) {
			splitStr.push(str.slice(0, delimiterIndex));
			str = str.slice(delimiterIndex + delimiter.length);
		} else {
			splitStr.push(str);
			str = '';
		}
	}
	splitStr.push(str);
	return splitStr;
}

/**
 * Wrapper presenting a single Battle-like interface while delegating to
 * the MultiBattleManager's active timeline.
 */
class MultiTimeBattle {
	manager: MultiBattleManager;
	matchId: string;
	currentTimelineId: string = '';
	currentTimeline: any = null;

	constructor(manager: MultiBattleManager, matchId: string) {
		this.manager = manager;
		this.matchId = matchId;
	}

	get battle() {
		if (!this.currentTimeline) return null;
		return this.currentTimeline.battle;
	}

	get turn(): number {
		return this.battle?.turn ?? 0;
	}

	get ended(): boolean {
		return this.battle?.ended ?? false;
	}

	get requestState(): string | null {
		return this.battle?.requestState ?? null;
	}

	get sides() {
		return this.battle?.sides ?? [];
	}

	get players() {
		return this.battle?.players ?? [];
	}

	get allChoicesDone(): boolean {
		return this.battle?.allChoicesDone() ?? false;
	}

	sendUpdates() {
		if (this.battle) this.battle.sendUpdates();
	}
}

export class MultiTimeBattleStream extends Streams.ObjectReadWriteStream<string> {
	debug: boolean;
	noCatch: boolean;
	replay: boolean | 'spectator';
	keepAlive: boolean;
	battle: MultiTimeBattle | null;
	private manager: any;
	private matchId: string | null;
	private rootTimelineId: string = '';

	constructor(
		manager: any,
		options: {
			debug?: boolean, noCatch?: boolean, keepAlive?: boolean, replay?: boolean | 'spectator',
		} = {}
	) {
		super();
		this.manager = manager;
		this.matchId = null;
		this.debug = !!options.debug;
		this.noCatch = !!options.noCatch;
		this.replay = options.replay || false;
		this.keepAlive = !!options.keepAlive;
		this.battle = null;
	}

	private turnSnapshots: Map<string, Map<number, {
		p1Active: PokemonSnapshot | null;
		p2Active: PokemonSnapshot | null;
	}>> = new Map();

	private captureSnapshot(timelineId: string, battle: any) {
		if (!battle) return;
		const turn = battle.turn ?? 0;

		if (!this.turnSnapshots.has(timelineId)) {
			this.turnSnapshots.set(timelineId, new Map());
		}
		const history = this.turnSnapshots.get(timelineId)!;

		// Always overwrite current turn (state may have changed mid-turn)
		history.set(turn, {
			p1Active: extractPokemonSnapshot(battle.sides?.[0]?.active?.[0] ?? null),
			p2Active: extractPokemonSnapshot(battle.sides?.[1]?.active?.[0] ?? null),
		});
	}

	/** Hook a timeline's battle.send to capture snapshots and emit tree updates */
	private hookBattleSend(timeline: any) {
		const battle = timeline.battle;
		if (!battle) return;
		const tlId = timeline.globalId;

		battle.send = (sendType: string, data: any) => {
			if (Array.isArray(data)) data = data.join('\n');
			this.pushMessage(sendType, data);

			if (sendType === 'update') {
				this.captureSnapshot(tlId, battle);
				this.emitTimelineUpdate();
			}
		};
	}

	/** Emit a |timenodes| message with full tree state */
	private emitTimelineUpdate() {
		const data = this._getTimelineNodes();
		this.pushMessage('update', `|timenodes|${JSON.stringify(data)}`);
	}

	override _write(chunk: string) {
		if (this.noCatch) {
			this._writeLines(chunk);
		} else {
			try {
				this._writeLines(chunk);
			} catch (err: any) {
				this.pushError(err, true);
				return;
			}
		}

		// Call sendUpdates to flush any pending battle messages
		if (this.battle) {
			this.battle.sendUpdates();
		}
	}

	private _writeLines(chunk: string) {
		for (const line of chunk.split('\n')) {
			if (line.startsWith('>')) {
				const [type, message] = splitFirst(line.slice(1), ' ');
				this._writeLine(type, message);
			}
		}
	}

	private pushMessage(type: string, data: string) {
		this.push(`${type}\n${data}`);
	}

	private _writeLine(type: string, message: string) {
		switch (type) {
		case 'start': {
			const options = JSON.parse(message);
			const { match, timeline } = this.manager.createMatch({
				formatid: options.formatid,
				p1: { name: 'Player 1', team: null },
				p2: { name: 'Player 2', team: null },
			});
			this.matchId = match.id;
			this.rootTimelineId = timeline.globalId;

			if (!this.battle) {
				this.battle = new MultiTimeBattle(this.manager, match.id);
			}
			this.battle.currentTimelineId = timeline.globalId;
			this.battle.currentTimeline = timeline;

			// Hook send callback to capture snapshots and relay messages
			this.hookBattleSend(timeline);

			// Initial tree state (may have no Pokémon data yet)
			this.emitTimelineUpdate();
			break;
		}
		case 'player': {
			// >player p1 {"name":"Alice","team":"...packed team..."}
			const [slot, playerJson] = splitFirst(message, ' ');
			const playerData = JSON.parse(playerJson);

			if (!this.matchId) throw new Error('No active match');
			const parsed = this.manager.parseGlobalId(this.rootTimelineId);
			if (!parsed) throw new Error('Root timeline lost');

			const timeline = parsed.timeline;
			const battle = timeline.battle;
			
			// Use the battle's setPlayer method to apply the player data and team
			battle.setPlayer(slot as any, playerData);
			break;
		}
		case 'p1':
		case 'p2':
		case 'p3':
		case 'p4': {
			// >p1 move 1  or  >p2 switch 2
			if (!this.battle || !this.battle.currentTimeline) throw new Error('No active timeline');

			const sideId = type as any;
			const timeline = this.battle.currentTimeline;
			const battle = timeline.battle;

			// Submit the choice via the manager
			const result = this.manager.submitChoice(timeline.globalId, sideId, message);

			if (result !== true) {
				// On error, emit as sideupdate with error message
				this.pushMessage('sideupdate', `${sideId}\n|error|${result}`);
			}
			break;
		}
		case 'branch': {
			if (!this.battle || !this.matchId) throw new Error('No active match');
			const turn = parseInt(message.trim()) || 0;

			const result = this.manager.branchTimeline(
				this.battle.currentTimelineId, turn
			);
			if (!result || result.error) {
				this.pushMessage('update', `|error|${result?.error || 'Failed to branch'}`);
				break;
			}
			const newTimeline = result.timeline;

			// Copy parent snapshots up to the branch turn into the new timeline
			const parentHistory = this.turnSnapshots.get(this.battle.currentTimelineId);
			if (parentHistory) {
				const newHistory = new Map<number, {
					p1Active: PokemonSnapshot | null;
					p2Active: PokemonSnapshot | null;
				}>();
				for (const [t, snap] of parentHistory) {
					if (t <= turn) newHistory.set(t, { ...snap });
				}
				this.turnSnapshots.set(newTimeline.globalId, newHistory);
			}

			this.hookBattleSend(newTimeline);

			// Auto-switch to the new branch
			this.battle.currentTimelineId = newTimeline.globalId;
			this.battle.currentTimeline = newTimeline;

			this.pushMessage('update',
				`|-message|Branched timeline #${newTimeline.num} from turn ${turn}`);
			this.emitTimelineUpdate();
			break;
		}
		}
	}

	private _getTimelineNodes(): { nodes: TimelineNodeData[] } {
		if (!this.matchId) return { nodes: [] };

		const match = this.manager.matches.get(this.matchId);
		if (!match) return { nodes: [] };

		const allNodes: TimelineNodeData[] = [];

		for (const [, timeline] of match.timelines) {
			const tlId = timeline.globalId;
			const battle = timeline.battle;
			const currentTurn = battle?.turn ?? 0;

			// Make sure we have a snapshot of the current state
			if (battle) this.captureSnapshot(tlId, battle);

			const history = this.turnSnapshots.get(tlId);
			if (!history || history.size === 0) {
				// No history yet — emit at least one node at turn 0
				allNodes.push({
					timelineId: tlId,
					timelineNum: timeline.num || 1,
					turn: 0,
					parentTimelineId: timeline.parentNum
						? `${match.id}:${timeline.parentNum}` : null,
					branchTurn: timeline.fromTurn ?? null,
					isCurrent: this.battle?.currentTimelineId === tlId,
					ended: battle?.ended ?? false,
					p1Active: null,
					p2Active: null,
				});
				continue;
			}

			// Build parent timeline's global ID
			let parentTlId: string | null = null;
			if (timeline.parentNum) {
				// Find the parent timeline's global ID by its num
				for (const [, ptl] of match.timelines) {
					if (ptl.num === timeline.parentNum) {
						parentTlId = ptl.globalId;
						break;
					}
				}
			}

			for (const [turn, snap] of history) {
				allNodes.push({
					timelineId: tlId,
					timelineNum: timeline.num || 1,
					turn,
					parentTimelineId: parentTlId,
					branchTurn: timeline.fromTurn ?? null,
					isCurrent: this.battle?.currentTimelineId === tlId
						&& turn === currentTurn,
					ended: battle?.ended ?? false,
					p1Active: snap.p1Active,
					p2Active: snap.p2Active,
				});
			}
		}

		return { nodes: allNodes };
	}
}
