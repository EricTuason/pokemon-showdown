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

	const team: any[] = side.pokemon || [];
	if (team.length === 0) return [];

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

/** MultiBattleManager type - defined in multi-battle-manager.ts */
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
 * Extract full PokemonSet data from a side object.
 */
function extractTeamSets(side: any): PokemonSet[] {
	if (!side) return [];
	const team: any[] = side.pokemon || [];
	if (team.length === 0) return [];

	return team.map(pokemon => {
		const set = pokemon.set;
		if (!set) return null;

		return {
			name: set.name || pokemon.name || '',
			species: set.species || pokemon.species?.name || '',
			item: set.item || pokemon.item || '',
			ability: set.ability || pokemon.ability || '',
			moves: set.moves || pokemon.moveSlots?.map((m: any) => m.id) || [],
			nature: set.nature || '',
			gender: set.gender || pokemon.gender || '',
			evs: set.evs || { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
			ivs: set.ivs || { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
			level: set.level || pokemon.level || 100,
			shiny: set.shiny,
			happiness: set.happiness,
			pokeball: set.pokeball,
			hpType: set.hpType,
			dynamaxLevel: set.dynamaxLevel,
			gigantamax: set.gigantamax,
			teraType: set.teraType,
		} as PokemonSet;
	}).filter((s): s is PokemonSet => s !== null);
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

/**
 * Represents a transfer that has been requested but not yet executed.
 * Stored until the turn resolves, then executed via the hooked send callback.
 */
interface PendingTransfer {
	sideId: 'p1' | 'p2' | 'p3' | 'p4';
	sourceBattleId: string;
	targetGlobalId: string;
	targetTurn: number;
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
	private turnJustResolved = false;

	/**
	 * Pending transfers: keyed by sideId. Only one transfer per side per turn.
	 * These are NOT executed immediately — they wait until the turn resolves.
	 */
	private pendingTransfers: Map<string, {
		sideId: 'p1' | 'p2' | 'p3' | 'p4';
		sourceBattleId: string;
		targetGlobalId: string;
		targetTurn: number;
	}> = new Map();

	/**
	 * When true, we are currently inside a sendUpdates flush triggered by
	 * commitChoices (turn resolution). This is how we know the turn just ended.
	 */
	private turnResolving = false;

	/**
	 * The turn number before the current write operation started.
	 * Used to detect when a turn has advanced.
	 */
	private turnBeforeWrite: number | undefined;

	/**
	 * Buffer for messages during transfer execution.
	 * When we're processing transfers after turn resolution, we need to
	 * hold the update messages and append transfer messages before flushing.
	 */
	private heldUpdateMessages: string[] | null = null;

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
		p1Sets: PokemonSet[];
		p2Sets: PokemonSet[];
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

		const p1Sets = extractTeamSets(p1Side);
		const p2Sets = extractTeamSets(p2Side);

		if (p1Team.length > 0 || p2Team.length > 0) {
			history.set(turn, { p1Team, p2Team, p1Sets, p2Sets });
		}
	}

	/**
	 * The room ID IS the match ID. No suffix, no transformation.
	 */
	private getRootBattleId(): string {
		return this.matchId!;
	}

	/**
	 * Generate a branch battle ID that is deterministic and traceable.
	 */
	private getBranchBattleId(): string {
		return `${this.matchId}>>branch${this.timelineCounter + 1}`;
	}

	/**
	 * Generate a unique timeline ID within this match.
	 */
	private generateTimelineId(battleId: string): string {
		return battleId;
	}

	/**
	 * Resolve any ID (room-facing or internal) to the manager's registered battle ID.
	 */
	resolveManagerBattleId(roomOrTimelineId: string): string | null {
		if (this.managedBattleIds.has(roomOrTimelineId)) {
			return this.managedBattleIds.get(roomOrTimelineId)!;
		}
		if (this.manager.getBattle(roomOrTimelineId)) {
			return roomOrTimelineId;
		}
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

	/**
	 * Hook a battle's send callback.
	 * 
	 * We CANNOT execute transfers inside this callback because that would
	 * cause recursive sendUpdates() calls. Instead, we set a flag that
	 * _write() checks after sendUpdates() returns.
	 */
	private hookBattleSend(globalId: string, battle: any) {
		if (!battle) return;

		battle.send = (sendType: string, data: any) => {
			if (Array.isArray(data)) data = data.join('\n');
			this.pushMessage(sendType, data);

			if (sendType === 'update') {
				this.captureSnapshot(globalId, battle);

				// If we have pending transfers, mark that the turn just resolved.
				// The actual transfer execution happens in _write() after
				// sendUpdates() has fully returned.
				if (this.pendingTransfers.size > 0) {
					this.turnJustResolved = true;
					console.log(`[TIMELINE DEBUG] Turn resolved with ${this.pendingTransfers.size} pending transfers — flagged for post-update execution`);
				} else {
					this.emitTimelineUpdate();
				}
			}
		};
	}

	/**
	 * Execute all pending transfers. Called AFTER sendUpdates() has fully
	 * returned, so we're not inside the battle's send callback.
	 */
	private executePendingTransfers() {
		if (this.pendingTransfers.size === 0) return;

		console.log(`[TIMELINE DEBUG] Executing ${this.pendingTransfers.size} pending transfers after turn resolution`);

		const transfers = new Map(this.pendingTransfers);
		this.pendingTransfers.clear();

		const battle = this.battle?.battle;
		if (!battle) {
			console.log(`[TIMELINE DEBUG] No battle found for transfer execution`);
			return;
		}

		for (const [sideId, transfer] of transfers) {
			console.log(`[TIMELINE DEBUG] Executing transfer: ${transfer.sideId} from ${transfer.sourceBattleId} -> ${transfer.targetGlobalId} turn ${transfer.targetTurn}`);

			try {
				this.executeTransfer(transfer);
			} catch (err: any) {
				console.log(`[TIMELINE DEBUG] Transfer execution failed: ${err.message}`);
				console.log(`[TIMELINE DEBUG] Stack: ${err.stack}`);
				this.pushMessage('update',
					`|-message|Transfer failed for ${transfer.sideId}: ${err.message}`);
			}
		}

		// After all transfers complete, we need to issue new requests.
		// battle.makeRequest('move') internally calls:
		//   1. side.clearChoice() for all sides
		//   2. getRequests(type) which calls side.getRequestData()
		//      which calls pokemon.getSwitchRequestData()
		//      which accesses slotConditions[position]
		//   3. side.emitRequest() via sendUpdates()
		//
		// We need to ensure slotConditions is valid for all sides before this.
		// replaceTeamFromSnapshot already resets it for the transferred side,
		// but let's be safe and check all sides.
		for (const side of battle.sides) {
			if (!side) continue;
			// Ensure slotConditions has entries for all active slot positions
			if (!side.slotConditions) {
				side.slotConditions = [];
			}
			for (let i = 0; i < side.active.length; i++) {
				if (!side.slotConditions[i]) {
					side.slotConditions[i] = {};
				}
			}
		}

		// Now try makeRequest. If it still fails, we fall back to manually
		// constructing and emitting requests.
		try {
			console.log(`[TIMELINE DEBUG] Issuing new move request after transfers`);
			battle.makeRequest('move');
			console.log(`[TIMELINE DEBUG] makeRequest succeeded`);
		} catch (e: any) {
			console.log(`[TIMELINE DEBUG] makeRequest threw: ${e.message}`);
			console.log(`[TIMELINE DEBUG] Stack: ${e.stack}`);

			// Fallback: manually set request state so the battle can continue.
			// We set requestState to 'move' and clear choices, then build
			// requests manually for each side.
			try {
				console.log(`[TIMELINE DEBUG] Attempting manual request fallback`);
				battle.requestState = 'move';

				for (const side of battle.sides) {
					if (!side) continue;
					side.clearChoice();

					// Build a minimal request manually
					const pokemon = side.pokemon.map((mon: any, i: number) => {
						const isActive = i < side.active.length && side.active[i] === mon;
						const condition = mon.fainted ? '0 fnt' :
							`${mon.hp}/${mon.maxhp}${mon.status ? ` ${mon.status}` : ''}`;

						return {
							ident: `${side.id}: ${mon.name}`,
							details: mon.details || `${mon.species.name}, L${mon.level}`,
							condition: condition,
							active: isActive,
							stats: {
								atk: mon.baseStoredStats?.['atk'] || 0,
								def: mon.baseStoredStats?.['def'] || 0,
								spa: mon.baseStoredStats?.['spa'] || 0,
								spd: mon.baseStoredStats?.['spd'] || 0,
								spe: mon.baseStoredStats?.['spe'] || 0,
							},
							moves: (mon.moves || mon.moveSlots?.map((m: any) => m.id) || []) as ID[],
							baseAbility: mon.baseAbility || mon.ability || '',
							item: mon.item || '',
							pokeball: mon.pokeball || 'pokeball',
							ability: mon.ability || '',
							teraType: mon.teraType || '',
							terastallized: mon.terastallized || '',
						};
					});

					// Build active move data for the active pokemon
					const activeMon = side.active[0];
					let activeData: any[] = [];
					if (activeMon && !activeMon.fainted) {
						const moves = activeMon.moveSlots.map((moveSlot: any) => {
							return {
								move: moveSlot.move,
								id: moveSlot.id,
								pp: moveSlot.pp,
								maxpp: moveSlot.maxpp,
								target: moveSlot.target || 'normal',
								disabled: moveSlot.disabled || false,
							};
						});

						activeData = [{
							moves: moves,
							canDynamax: false,
							canTerastallize: activeMon.teraType && !activeMon.terastallized ?
								activeMon.teraType : undefined,
						}];
					}

					const request: any = {
						requestType: 'move',
						active: activeData,
						side: { name: side.name, id: side.id, pokemon },
					};

					// If this side has no active pokemon or it's fainted,
					// they might need a force switch instead
					if (!activeMon || activeMon.fainted) {
						const hasAlive = side.pokemon.some((p: any) => !p.fainted && p.hp > 0);
						if (hasAlive) {
							request.requestType = 'switch';
							request.forceSwitch = [true];
							delete request.active;
						} else {
							request.wait = true;
						}
					}

					side.activeRequest = request;
				}

				battle.sentRequests = false;
				console.log(`[TIMELINE DEBUG] Manual request fallback completed`);
			} catch (fallbackErr: any) {
				console.log(`[TIMELINE DEBUG] Manual request fallback also failed: ${fallbackErr.message}`);
				console.log(`[TIMELINE DEBUG] Stack: ${fallbackErr.stack}`);
			}
		}

		// Flush updates (sends requests to players)
		try {
			battle.sendUpdates();
		} catch (e: any) {
			console.log(`[TIMELINE DEBUG] sendUpdates after transfer threw: ${e.message}`);
		}

		// Update timeline visualization
		const entry = this.timelineRegistry.get(this.battle!.currentTimelineId);
		if (entry) {
			this.captureSnapshot(this.battle!.currentTimelineId, battle);
		}
		this.emitTimelineUpdate();
	}

	/**
	 * Execute a single transfer operation.
	 * Does NOT call makeRequest or sendUpdates — the caller handles that
	 * after all transfers are done.
	 */
	private executeTransfer(transfer: {
		sideId: 'p1' | 'p2' | 'p3' | 'p4';
		sourceBattleId: string;
		targetGlobalId: string;
		targetTurn: number;
	}) {
		const { sideId, sourceBattleId, targetGlobalId, targetTurn } = transfer;

		const resolvedTargetId = this.resolveManagerBattleId(targetGlobalId);
		if (!resolvedTargetId) {
			throw new Error(`Target battle "${targetGlobalId}" not found in manager`);
		}

		// Step 1: Capture the active Pokemon's state from the source battle
		const transferState = this.manager.getPokemonTransferState(
			sourceBattleId,
			sideId as 'p1' | 'p2',
			0
		);
		if (!transferState) {
			throw new Error(`No active Pokemon to transfer`);
		}
		console.log(`[TIMELINE DEBUG] Captured transfer state for ${transferState.set.name || transferState.set.species}`);

		// Step 2: Get the stored team from the target timeline node
		const targetSide = sideId as 'p1' | 'p2';
		const snapshotSets = this.getStoredSets(resolvedTargetId, targetTurn, targetSide);
		const snapshotDisplays = this.getStoredSnapshots(resolvedTargetId, targetTurn, targetSide);

		if (!snapshotSets || snapshotSets.length === 0) {
			console.log(`[TIMELINE DEBUG] No stored sets found for target - using empty team`);
		} else {
			console.log(`[TIMELINE DEBUG] Found ${snapshotSets.length} stored sets for target timeline`);
		}

		// Step 3: Replace the team (does NOT call makeRequest/sendUpdates)
		const result = this.manager.replaceTeamFromSnapshot(
			sourceBattleId,
			sideId as 'p1' | 'p2',
			snapshotSets || [],
			snapshotDisplays || [],
			transferState
		);

		console.log(`[TIMELINE DEBUG] replaceTeamFromSnapshot result:`, JSON.stringify({
			success: result.success,
			error: result.error,
			transferred: result.transferredPokemon?.set?.name,
		}));

		if (!result.success) {
			throw new Error(result.error || 'Transfer failed');
		}

		const coord = `Timeline ${targetGlobalId}, Turn ${targetTurn}`;
		this.pushMessage('update',
			`|-message|${sideId}'s Pokemon transferred to ${coord}!`);
	}

	/** Emit a |timenodes| message with full tree state */
	private emitTimelineUpdate() {
		const data = this._getTimelineNodes();
		this.pushMessage('update', `|timenodes|${JSON.stringify(data)}`);
	}

	override _write(chunk: string) {
		// Reset the flag before processing
		this.turnJustResolved = false;

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

		// After sendUpdates() has fully returned (and the send callback
		// has finished), check if we need to execute transfers.
		if (this.turnJustResolved) {
			this.turnJustResolved = false;
			this.executePendingTransfers();
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

			this.matchId = options.roomid || `match-${Date.now()}`;

			console.log(`[TIMELINE DEBUG] Starting match: ${this.matchId}`);
			console.log(`[TIMELINE DEBUG] Format: ${options.formatid}`);

			const rootBattleId = this.getRootBattleId();

			const battle = this.manager.createBattle(rootBattleId, {
				formatid: options.formatid,
				seed: options.seed,
				debug: this.debug,
			});

			const timeline = this.registerTimeline(rootBattleId);
			this.rootTimelineId = timeline.globalId;

			if (options.roomid && options.roomid !== rootBattleId) {
				this.managedBattleIds.set(options.roomid, rootBattleId);
			}

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

			this.hookBattleSend(timeline.globalId, battle);

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

			// ── Handle transfer commands ──
			if (message.startsWith('transfer|')) {
				console.log(`[TIMELINE DEBUG] Transfer choice received: ${sideId} ${message}`);
				const transferParts = message.split('|');
				const targetGlobalId = transferParts[1];
				const targetTurn = parseInt(transferParts[2]);

				if (!targetGlobalId || isNaN(targetTurn)) {
					this.pushMessage('sideupdate',
						`${sideId}\n|error|[Invalid transfer] Invalid timeline or turn`);
					break;
				}

				// Store the transfer intent — do NOT execute it yet
				this.pendingTransfers.set(sideId, {
					sideId,
					sourceBattleId: entry.battleId,
					targetGlobalId,
					targetTurn,
				});

				console.log(`[TIMELINE DEBUG] Transfer stored as pending for ${sideId}`);
				console.log(`[TIMELINE DEBUG] Pending transfers: ${this.pendingTransfers.size}`);

				// Submit a "pass" choice so the battle engine sees this side as done.
				// The actual move doesn't matter because the transfer will replace
				// the team after the turn resolves.
				// We try "default" first (which picks a valid move), falling back to "pass".
				const battle = this.manager.getBattle(entry.battleId);
				if (!battle) {
					this.pushMessage('sideupdate',
						`${sideId}\n|error|[Invalid transfer] Battle not found`);
					this.pendingTransfers.delete(sideId);
					break;
				}

				try {
					// Use "move 1" as the placeholder — "default" may not always work
					// and we want the Pokemon to still take a turn action normally.
					// The transfer happens AFTER the turn resolves.
					const result = battle.choose(sideId, 'default');
					if (!result) {
						// If default fails, try move 1
						console.log(`[TIMELINE DEBUG] 'default' failed for ${sideId}, trying 'move 1'`);
						const result2 = battle.choose(sideId, 'move 1');
						if (!result2) {
							console.log(`[TIMELINE DEBUG] 'move 1' also failed, trying 'pass'`);
							battle.choose(sideId, 'pass');
						}
					}
				} catch (err: any) {
					console.log(`[TIMELINE DEBUG] Placeholder choice failed: ${err.message}`);
					// Last resort
					try {
						battle.choose(sideId, 'pass');
					} catch (e2: any) {
						console.log(`[TIMELINE DEBUG] Even pass failed: ${e2.message}`);
						this.pendingTransfers.delete(sideId);
						this.pushMessage('sideupdate',
							`${sideId}\n|error|[Invalid transfer] Could not submit placeholder choice`);
					}
				}

				// IMPORTANT: Do NOT call sendUpdates() here.
				// If both sides have chosen, commitChoices() already ran inside
				// battle.choose() above. The send callback (hookBattleSend) will
				// detect pending transfers and execute them before flushing.
				// If only one side has chosen, nothing happens yet — we wait for
				// the other side's choice.
				break;
			}
			// ── End transfer handling ──

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

			const newBattleId = this.getBranchBattleId();

			try {
				const newBattle = this.manager.createBattle(newBattleId, {
					formatid: currentBattle.format?.id || currentBattle.formatid,
					debug: this.debug,
				});

				this.manager.linkBattles(currentEntry.battleId, newBattleId);

				const newTimeline = this.registerTimeline(
					newBattleId,
					currentEntry.num,
					turn
				);

				const parentHistory = this.turnSnapshots.get(this.battle.currentTimelineId);
				if (parentHistory) {
					const newHistory = new Map<number, {
						p1Team: PokemonSnapshot[];
						p2Team: PokemonSnapshot[];
						p1Sets: PokemonSet[];
						p2Sets: PokemonSet[];
					}>();
					for (const [t, snap] of parentHistory) {
						if (t <= turn) {
							newHistory.set(t, {
								p1Team: snap.p1Team.map(p => ({ ...p })),
								p2Team: snap.p2Team.map(p => ({ ...p })),
								p1Sets: snap.p1Sets ? [...snap.p1Sets] : [],
								p2Sets: snap.p2Sets ? [...snap.p2Sets] : [],
							});
						}
					}
					this.turnSnapshots.set(newTimeline.globalId, newHistory);
				}

				this.hookBattleSend(newTimeline.globalId, newBattle);

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

			if (battle) this.captureSnapshot(globalId, battle);

			const history = this.turnSnapshots.get(globalId);

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

	/**
	 * Get the stored PokemonSets for a specific timeline at a specific turn.
	 */
	getStoredSets(
		timelineId: string,
		turn: number,
		side: 'p1' | 'p2'
	): PokemonSet[] | null {
		const history = this.turnSnapshots.get(timelineId);
		if (!history) {
			console.log(`[Timeline Team] getStoredSets: no history for timeline "${timelineId}"`);
			return null;
		}

		let closestTurn = -1;
		for (const [t] of history) {
			if (t <= turn && t > closestTurn) closestTurn = t;
		}

		if (closestTurn === -1) {
			console.log(`[Timeline Team] getStoredSets: no snapshot at or before turn ${turn}`);
			return null;
		}

		const snap = history.get(closestTurn)!;
		const sets = side === 'p1' ? snap.p1Sets : snap.p2Sets;
		console.log(`[Timeline Team] getStoredSets("${timelineId}", turn=${turn}, side=${side}) -> ${sets.length} sets from turn ${closestTurn}`);
		return sets;
	}

	/**
	 * Get the stored PokemonSnapshot for a specific timeline at a specific turn.
	 */
	getStoredSnapshots(
		timelineId: string,
		turn: number,
		side: 'p1' | 'p2'
	): PokemonSnapshot[] | null {
		const history = this.turnSnapshots.get(timelineId);
		if (!history) return null;

		let closestTurn = -1;
		for (const [t] of history) {
			if (t <= turn && t > closestTurn) closestTurn = t;
		}
		if (closestTurn === -1) return null;

		const snap = history.get(closestTurn)!;
		return side === 'p1' ? snap.p1Team : snap.p2Team;
	}
}