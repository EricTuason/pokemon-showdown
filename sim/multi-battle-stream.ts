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
	const name: string =
		pokemon.species?.name ||
		pokemon.speciesData?.name ||
		pokemon.name ||
		'substitute';
	return name
		.split(',')[0]
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, '');
}

function extractPokemonSnapshot(pokemon: any): PokemonSnapshot | null {
	if (!pokemon) return null;
	const fainted = pokemon.fainted || pokemon.hp <= 0;
	const spriteId = pokemonToSpriteId(pokemon);
	return {
		name: pokemon.name || pokemon.species?.name || spriteId,
		species: spriteId,
		hp: fainted ? 0 : (pokemon.maxhp > 0 ? Math.round((pokemon.hp / pokemon.maxhp) * 100) : 0),
		status: pokemon.status || undefined,
		isActive: !!pokemon.isActive,
		fainted,
	};
}

/**
 * Extract the full team snapshot from a side object.
 * Returns all pokemon on the side, not just the active one.
 */
function extractTeamSnapshot(side: any): PokemonSnapshot[] {
	if (!side) return [];

	// side.pokemon is the full team array in the sim
	const team: any[] = side.pokemon || [];
	if (team.length === 0) return [];

	// Determine which pokemon are active
	const activeSet = new Set<any>();
	if (side.active) {
		for (const a of side.active) {
			if (a) activeSet.add(a);
		}
	}

	return team.map(pokemon => {
		const fainted = pokemon.fainted || pokemon.hp <= 0;
		const spriteId = pokemonToSpriteId(pokemon);
		return {
			name: pokemon.name || pokemon.species?.name || spriteId,
			species: spriteId,
			hp: fainted ? 0 : (pokemon.maxhp > 0
				? Math.round((pokemon.hp / pokemon.maxhp) * 100)
				: 0),
			status: pokemon.status || undefined,
			isActive: activeSet.has(pokemon),
			fainted,
		};
	});
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
		return this.currentTimeline?.battle ?? null;
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
	private manager: MultiBattleManager;
	private matchId: string | null;
	private rootTimelineId: string = '';

	/**
	 * Maps room-facing IDs to internal battle IDs registered with the manager.
	 * This is the SINGLE SOURCE OF TRUTH for ID resolution.
	 */
	readonly managedBattleIds: Map<string, string> = new Map();

	// Track timeline relationships ourselves since the manager doesn't
	private timelineRegistry: Map<string, {
		battleId: string;
		num: number;
		parentNum: number | null;
		fromTurn: number | null;
		globalId: string;
	}> = new Map();
	private timelineCounter = 0;

	constructor(
		manager: MultiBattleManager,
		options: {
			debug?: boolean;
			noCatch?: boolean;
			keepAlive?: boolean;
			replay?: boolean | 'spectator';
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

	// Stores full team snapshots per timeline per turn
	private turnSnapshots: Map<string, Map<number, {
		p1Team: PokemonSnapshot[];
		p2Team: PokemonSnapshot[];
	}>> = new Map();

	private captureSnapshot(timelineId: string, battle: any) {
		if (!battle) return;
		const turn = battle.turn ?? 0;

		if (!this.turnSnapshots.has(timelineId)) {
			this.turnSnapshots.set(timelineId, new Map());
		}
		const history = this.turnSnapshots.get(timelineId)!;

		const p1Side = battle.sides?.[0] ?? null;
		const p2Side = battle.sides?.[1] ?? null;

		const p1Team = extractTeamSnapshot(p1Side);
		const p2Team = extractTeamSnapshot(p2Side);

		// Only store if we actually have team data
		// (sides may not be populated yet on turn 0 before players are set)
		if (p1Team.length > 0 || p2Team.length > 0) {
			history.set(turn, { p1Team, p2Team });
		}
	}

	/**
	 * The room ID IS the match ID. No suffix, no transformation.
	 * This is the canonical ID used everywhere.
	 */
	private getRootBattleId(): string {
		return this.matchId!;
	}

	/**
	 * Generate a branch battle ID that is deterministic and traceable.
	 * Format: "{matchId}>>branch{N}" so it's clear it belongs to this match.
	 */
	private getBranchBattleId(): string {
		return `${this.matchId}>>branch${this.timelineCounter + 1}`;
	}

	/**
	 * Generate a unique timeline ID within this match.
	 * For the root, this equals the matchId. For branches, includes the branch suffix.
	 */
	private generateTimelineId(battleId: string): string {
		return battleId;
	}

	/**
	 * Resolve any ID (room-facing or internal) to the manager's registered battle ID.
	 * Checks the mapping first, then falls back to direct lookup.
	 */
	resolveManagerBattleId(roomOrTimelineId: string): string | null {
		// Direct hit in our mapping
		if (this.managedBattleIds.has(roomOrTimelineId)) {
			return this.managedBattleIds.get(roomOrTimelineId)!;
		}
		// Maybe it's already a manager ID
		if (this.manager.getBattle(roomOrTimelineId)) {
			return roomOrTimelineId;
		}
		// Check timeline registry
		for (const [globalId, entry] of this.timelineRegistry) {
			if (entry.battleId === roomOrTimelineId) return entry.battleId;
			if (globalId === roomOrTimelineId) return entry.battleId;
		}
		return null;
	}

	/**
	 * Register a timeline (battle) in our local tracking
	 */
	private registerTimeline(
		battleId: string,
		parentNum: number | null = null,
		fromTurn: number | null = null
	) {
		this.timelineCounter++;
		const globalId = this.generateTimelineId(battleId);
		this.timelineRegistry.set(globalId, {
			battleId,
			num: this.timelineCounter,
			parentNum,
			fromTurn,
			globalId,
		});

		// Register the bidirectional mapping:
		// roomId -> managerBattleId AND managerBattleId -> managerBattleId
		this.managedBattleIds.set(globalId, battleId);
		this.managedBattleIds.set(battleId, battleId);

		console.log(`[TIMELINE DEBUG] Registered timeline: globalId="${globalId}", battleId="${battleId}" (num=${this.timelineCounter}, parent=${parentNum}, fromTurn=${fromTurn})`);

		return this.timelineRegistry.get(globalId)!;
	}

	/**
	 * Get the Battle object for a timeline ID
	 */
	private getTimelineBattle(globalId: string): any | null {
		const entry = this.timelineRegistry.get(globalId);
		if (!entry) return null;
		return this.manager.getBattle(entry.battleId) || null;
	}

	/** Hook a battle's send to capture snapshots and emit tree updates */
	private hookBattleSend(globalId: string, battle: any) {
		if (!battle) return;

		battle.send = (sendType: string, data: any) => {
			if (Array.isArray(data)) data = data.join('\n');
			this.pushMessage(sendType, data);

			if (sendType === 'update') {
				this.captureSnapshot(globalId, battle);
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

	public override pushError(err: any, recoverable: boolean) {
		if (recoverable) {
			this.pushMessage('update',
				`|html|<div class="broadcast-red"><b>The battle crashed</b></div>`);
		}
		this.pushMessage('error', err.stack || err.message || String(err));
	}

	private _writeLine(type: string, message: string) {
		switch (type) {
		case 'start': {
			const options = JSON.parse(message);

			// The room ID IS the match ID. Period.
			this.matchId = options.roomid || `match-${Date.now()}`;

			console.log(`[TIMELINE DEBUG] Starting match: ${this.matchId}`);
			console.log(`[TIMELINE DEBUG] Format: ${options.formatid}`);

			// Root battle ID = match ID. No suffix.
			const rootBattleId = this.getRootBattleId();

			const battle = this.manager.createBattle(rootBattleId, {
				formatid: options.formatid,
				seed: options.seed,
				debug: this.debug,
			});

			// Register: globalId = battleId = matchId for root
			const timeline = this.registerTimeline(rootBattleId);
			this.rootTimelineId = timeline.globalId;

			// Also register the raw roomid -> manager battle ID mapping
			// so room-battle.ts can find it by this.roomid
			if (options.roomid && options.roomid !== rootBattleId) {
				this.managedBattleIds.set(options.roomid, rootBattleId);
			}

			// Set up the MultiTimeBattle wrapper
			if (!this.matchId) {
				throw new Error('Failed to determine match ID');
			}
			if (!this.battle) {
				this.battle = new MultiTimeBattle(this.manager, this.matchId);
			}
			this.battle.currentTimelineId = timeline.globalId;
			this.battle.currentTimeline = {
				...timeline,
				battle,
			};

			// Hook send callback to capture snapshots and relay messages
			this.hookBattleSend(timeline.globalId, battle);

			// Initial tree state
			this.emitTimelineUpdate();
			break;
		}
		case 'player': {
			const [slot, playerJson] = splitFirst(message, ' ');
			const playerData = JSON.parse(playerJson);

			if (!this.battle || !this.battle.currentTimeline) {
				throw new Error('No active match');
			}

			const battle = this.battle.currentTimeline.battle;
			if (!battle) throw new Error('No battle in current timeline');

			console.log(`[TIMELINE DEBUG] Setting player ${slot}: ${playerData.name}`);

			const entry = this.timelineRegistry.get(this.battle.currentTimelineId);
			if (entry) {
				this.manager.setPlayer(entry.battleId, slot as any, {
					name: playerData.name,
					team: playerData.team,
					avatar: playerData.avatar,
				});
			} else {
				battle.setPlayer(slot as any, playerData);
			}
			break;
		}
		case 'p1':
		case 'p2':
		case 'p3':
		case 'p4': {
			if (!this.battle || !this.battle.currentTimeline) {
				throw new Error('No active timeline');
			}

			const sideId = type as 'p1' | 'p2' | 'p3' | 'p4';
			const entry = this.timelineRegistry.get(this.battle.currentTimelineId);

			if (!entry) {
				throw new Error(`Timeline ${this.battle.currentTimelineId} not registered`);
			}

			console.log(`[TIMELINE DEBUG] Choice: ${sideId} ${message} (battle: ${entry.battleId})`);

			try {
				const result = this.manager.choose(entry.battleId, sideId, message);
				if (result === false) {
					this.pushMessage('sideupdate',
						`${sideId}\n|error|[Invalid choice] ${message}`);
				}
			} catch (err: any) {
				this.pushMessage('sideupdate',
					`${sideId}\n|error|[Invalid choice] ${err.message}`);
			}
			break;
		}
		case 'branch': {
			if (!this.battle || !this.matchId) throw new Error('No active match');
			const turn = parseInt(message.trim()) || 0;

			console.log(`[TIMELINE DEBUG] Branching from ${this.battle.currentTimelineId} at turn ${turn}`);

			const currentEntry = this.timelineRegistry.get(this.battle.currentTimelineId);
			if (!currentEntry) {
				this.pushMessage('update', `|error|Current timeline not found`);
				break;
			}

			const currentBattle = this.manager.getBattle(currentEntry.battleId);
			if (!currentBattle) {
				this.pushMessage('update', `|error|Current battle not found`);
				break;
			}

			// Deterministic branch ID
			const newBattleId = this.getBranchBattleId();

			try {
				const newBattle = this.manager.createBattle(newBattleId, {
					formatid: currentBattle.format?.id || currentBattle.formatid,
					debug: this.debug,
				});

				// Link the battles in the manager
				this.manager.linkBattles(currentEntry.battleId, newBattleId);

				// Register the new timeline
				const newTimeline = this.registerTimeline(
					newBattleId,
					currentEntry.num,
					turn
				);

				// Copy parent snapshots up to the branch turn
				const parentHistory = this.turnSnapshots.get(this.battle.currentTimelineId);
				if (parentHistory) {
					const newHistory = new Map<number, {
						p1Team: PokemonSnapshot[];
						p2Team: PokemonSnapshot[];
					}>();
					for (const [t, snap] of parentHistory) {
						if (t <= turn) {
							// Deep copy each team array so mutation doesn't
							// bleed between timelines
							newHistory.set(t, {
								p1Team: snap.p1Team.map(p => ({ ...p })),
								p2Team: snap.p2Team.map(p => ({ ...p })),
							});
						}
					}
					this.turnSnapshots.set(newTimeline.globalId, newHistory);
				}

				// Hook the new battle's send
				this.hookBattleSend(newTimeline.globalId, newBattle);

				// Switch to the new branch
				this.battle.currentTimelineId = newTimeline.globalId;
				this.battle.currentTimeline = {
					...newTimeline,
					battle: newBattle,
				};

				this.pushMessage('update',
					`|-message|Branched timeline #${newTimeline.num} from turn ${turn}`);
				this.emitTimelineUpdate();
			} catch (err: any) {
				this.pushMessage('update', `|error|Failed to branch: ${err.message}`);
				console.log(`[TIMELINE DEBUG] Branch error:`, err);
			}
			break;
		}
		}
	}

	private _getTimelineNodes(): { nodes: TimelineNodeData[] } {
		if (!this.matchId) return { nodes: [] };

		const allNodes: TimelineNodeData[] = [];

		for (const [globalId, entry] of this.timelineRegistry) {
			const battle = this.manager.getBattle(entry.battleId);
			const currentTurn = battle?.turn ?? 0;

			// Always re-capture the latest state so the current turn is fresh
			if (battle) this.captureSnapshot(globalId, battle);

			const history = this.turnSnapshots.get(globalId);

			// No history yet: emit a placeholder turn-0 node so the
			// timeline appears in the tree immediately
			if (!history || history.size === 0) {
				allNodes.push({
					timelineId: globalId,
					timelineNum: entry.num,
					turn: 0,
					parentTimelineId: entry.parentNum
						? this.findGlobalIdByNum(entry.parentNum) : null,
					branchTurn: entry.fromTurn,
					isCurrent: this.battle?.currentTimelineId === globalId,
					ended: battle?.ended ?? false,
					p1Team: [],
					p2Team: [],
				});
				continue;
			}

			const parentGlobalId = entry.parentNum
				? this.findGlobalIdByNum(entry.parentNum) : null;

			for (const [turn, snap] of history) {
				allNodes.push({
					timelineId: globalId,
					timelineNum: entry.num,
					turn,
					parentTimelineId: parentGlobalId,
					branchTurn: entry.fromTurn,
					isCurrent: this.battle?.currentTimelineId === globalId
						&& turn === currentTurn,
					ended: battle?.ended ?? false,
					p1Team: snap.p1Team,
					p2Team: snap.p2Team,
				});
			}
		}

		return { nodes: allNodes };
	}

	/**
	 * Find a timeline's global ID by its number
	 */
	private findGlobalIdByNum(num: number): string | null {
		for (const [globalId, entry] of this.timelineRegistry) {
			if (entry.num === num) return globalId;
		}
		return null;
	}
}