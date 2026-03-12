/**
 * Multi-Battle Stream
 * Pokemon Showdown - http://pokemonshowdown.com/
 */

import { Streams } from '../lib';
import {
	PokemonSnapshot,
	PokemonSnapshotClient,
	PokemonTransferState,
	toClientSnapshot,
	PokemonSet,
} from './multi-battle-manager';

export interface TimelineNodeData {
	timelineId: string;
	timelineNum: number;
	turn: number;
	parentTimelineId: string | null;
	branchTurn: number | null;
	isCurrent: boolean;
	ended: boolean;
	p1Team: PokemonSnapshotClient[];
	p2Team: PokemonSnapshotClient[];
	p1SideConditions: SideConditionSnapshot[];
	p2SideConditions: SideConditionSnapshot[];
	field: FieldSnapshot;
}

export interface FieldConditionSnapshot {
	id: string;
	turnsLeft?: number;
	source?: string;
}

export interface FieldSnapshot {
	weather: FieldConditionSnapshot | null;
	terrain: FieldConditionSnapshot | null;
	pseudoWeather: FieldConditionSnapshot[];
}

export interface SideConditionSnapshot {
	id: string;
	turnsLeft?: number;
	layers?: number;
	source?: string;
}

export interface SlotConditionSnapshot {
	id: string;
	turnsLeft?: number;
	source?: string;
}

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
		const isActive = activeSet.has(pokemon);
		const maxhp = pokemon.maxhp || 100;
		const hpPercent = fainted ? 0 : (maxhp > 0
			? Math.round((pokemon.hp / maxhp) * 100)
			: 0);

		return {
			name: pokemon.name || pokemon.species?.name || spriteId,
			species: spriteId,
			hp: hpPercent,
			maxhp,
			status: pokemon.status || '',
			isActive,
			fainted,
			boosts: isActive && !fainted && pokemon.boosts
				? { ...pokemon.boosts }
				: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
			item: pokemon.item || '',
			ability: pokemon.ability || '',
			moves: pokemon.moveSlots?.map((m: any) => m.id) || [],
			position: pokemon.position ?? -1,
			volatiles: isActive && !fainted && pokemon.volatiles
				? Object.keys(pokemon.volatiles)
				: [],
		};
	});
}

type MultiBattleManager = any;

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
 * Extracts field condition snapshot from a battle
 */
function extractFieldSnapshot(battle: any): FieldSnapshot {
	const field = battle?.field;
	if (!field) {
		console.log(`[Timeline Field] extractFieldSnapshot: no field object`);
		return { weather: null, terrain: null, pseudoWeather: [] };
	}

	console.log(`[Timeline Field] extractFieldSnapshot - weather: ${field.weather || 'none'}, terrain: ${field.terrain || 'none'}`);

	let weather: FieldConditionSnapshot | null = null;
	if (field.weather) {
		weather = {
			id: field.weather,
			turnsLeft: field.weatherState?.duration,
			source: field.weatherState?.source?.name,
		};
		console.log(`[Timeline Field]   Weather captured: ${weather.id}, turnsLeft: ${weather.turnsLeft ?? 'infinite'}`);
	}

	let terrain: FieldConditionSnapshot | null = null;
	if (field.terrain) {
		terrain = {
			id: field.terrain,
			turnsLeft: field.terrainState?.duration,
			source: field.terrainState?.source?.name,
		};
		console.log(`[Timeline Field]   Terrain captured: ${terrain.id}, turnsLeft: ${terrain.turnsLeft ?? 'infinite'}`);
	}

	const pseudoWeather: FieldConditionSnapshot[] = [];
	if (field.pseudoWeather) {
		for (const id in field.pseudoWeather) {
			const state = field.pseudoWeather[id];
			pseudoWeather.push({
				id: id,
				turnsLeft: state.duration,
				source: state.source?.name,
			});
			console.log(`[Timeline Field]   PseudoWeather captured: ${id}, turnsLeft: ${state.duration ?? 'infinite'}`);
		}
	}

	return { weather, terrain, pseudoWeather };
}

/**
 * Extracts side conditions from a battle side
 */
function extractSideConditions(side: any): SideConditionSnapshot[] {
	if (!side?.sideConditions) {
		console.log(`[Timeline Side] extractSideConditions: no sideConditions object for ${side?.id || 'unknown'}`);
		return [];
	}

	const conditions: SideConditionSnapshot[] = [];
	for (const id in side.sideConditions) {
		const state = side.sideConditions[id];
		conditions.push({
			id: id,
			turnsLeft: state.duration,
			layers: state.layers,
			source: state.source?.name,
		});
		console.log(`[Timeline Side]   ${side.id} condition: ${id}, turnsLeft: ${state.duration ?? 'N/A'}, layers: ${state.layers ?? 'N/A'}`);
	}

	if (conditions.length === 0) {
		console.log(`[Timeline Side]   ${side.id} has no side conditions`);
	}

	return conditions;
}

/**
 * Deep-clones a FieldSnapshot
 */
function deepCloneFieldSnapshot(field: FieldSnapshot): FieldSnapshot {
	return {
		weather: field.weather ? { ...field.weather } : null,
		terrain: field.terrain ? { ...field.terrain } : null,
		pseudoWeather: field.pseudoWeather.map(pw => ({ ...pw })),
	};
}

/**
 * Deep-clones an array of SideConditionSnapshots
 */
function deepCloneSideConditions(conditions: SideConditionSnapshot[]): SideConditionSnapshot[] {
	return conditions.map(c => ({ ...c }));
}

/**
 * Deep-clones a PokemonSnapshot, including nested objects.
 */
function deepCloneSnapshot(p: PokemonSnapshot): PokemonSnapshot {
	return {
		...p,
		boosts: { ...p.boosts },
		volatiles: [...p.volatiles],
		moves: [...p.moves],
	};
}

/**
 * Deep-clones a PokemonSet, including nested objects.
 */
function deepCloneSet(s: PokemonSet): PokemonSet {
	return {
		...s,
		moves: [...(s.moves || [])],
		evs: { ...(s.evs || { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }) },
		ivs: { ...(s.ivs || { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }) },
	};
}

/**
 * Deep-clones a full turn snapshot entry.
 */
function deepCloneTurnSnapshot(snap: {
	p1Team: PokemonSnapshot[];
	p2Team: PokemonSnapshot[];
	p1Sets: PokemonSet[];
	p2Sets: PokemonSet[];
	p1SideConditions: SideConditionSnapshot[];
	p2SideConditions: SideConditionSnapshot[];
	field: FieldSnapshot;
}): {
	p1Team: PokemonSnapshot[];
	p2Team: PokemonSnapshot[];
	p1Sets: PokemonSet[];
	p2Sets: PokemonSet[];
	p1SideConditions: SideConditionSnapshot[];
	p2SideConditions: SideConditionSnapshot[];
	field: FieldSnapshot;
} {
	return {
		p1Team: snap.p1Team.map(deepCloneSnapshot),
		p2Team: snap.p2Team.map(deepCloneSnapshot),
		p1Sets: snap.p1Sets.map(deepCloneSet),
		p2Sets: snap.p2Sets.map(deepCloneSet),
		p1SideConditions: deepCloneSideConditions(snap.p1SideConditions),
		p2SideConditions: deepCloneSideConditions(snap.p2SideConditions),
		field: deepCloneFieldSnapshot(snap.field),
	};
}


class MultiTimeBattle {
	manager: MultiBattleManager;
	matchId: string;
	currentTimelineId: string = '';
	currentTimeline: any = null;

	constructor(manager: MultiBattleManager, matchId: string) {
		this.manager = manager;
		this.matchId = matchId;
	}

	get battle() { return this.currentTimeline?.battle ?? null; }
	get turn(): number { return this.battle?.turn ?? 0; }
	get ended(): boolean { return this.battle?.ended ?? false; }
	get requestState(): string | null { return this.battle?.requestState ?? null; }
	get sides() { return this.battle?.sides ?? []; }
	get players() { return this.battle?.players ?? []; }
	get allChoicesDone(): boolean { return this.battle?.allChoicesDone() ?? false; }
	sendUpdates() { if (this.battle) this.battle.sendUpdates(); }
}

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

	readonly managedBattleIds: Map<string, string> = new Map();

	private timelineRegistry: Map<string, {
		battleId: string;
		num: number;
		parentNum: number | null;
		fromTurn: number | null;
		globalId: string;
	}> = new Map();
	private timelineCounter = 0;
	private turnJustResolved = false;
	private pendingTransfers: Map<string, PendingTransfer> = new Map();
	private turnResolving = false;
	private turnBeforeWrite: number | undefined;
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

	private turnSnapshots: Map<string, Map<number, {
		p1Team: PokemonSnapshot[];
		p2Team: PokemonSnapshot[];
		p1Sets: PokemonSet[];
		p2Sets: PokemonSet[];
		p1SideConditions: SideConditionSnapshot[];
		p2SideConditions: SideConditionSnapshot[];
		field: FieldSnapshot;
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
		const p1SideConditions = extractSideConditions(p1Side);
		const p2SideConditions = extractSideConditions(p2Side);
		const field = extractFieldSnapshot(battle);

		console.log(`[Timeline Snapshot] Capturing turn ${turn} for ${timelineId}`);
		console.log(`[Timeline Snapshot]   p1 team: ${p1Team.length}, p2 team: ${p2Team.length}`);
		console.log(`[Timeline Snapshot]   p1 conditions: [${p1SideConditions.map(c => c.id).join(', ')}]`);
		console.log(`[Timeline Snapshot]   p2 conditions: [${p2SideConditions.map(c => c.id).join(', ')}]`);
		console.log(`[Timeline Snapshot]   field: weather=${field.weather?.id || 'none'}, terrain=${field.terrain?.id || 'none'}, pseudoWeather=[${field.pseudoWeather.map(pw => pw.id).join(', ')}]`);

		if (p1Team.length > 0 || p2Team.length > 0) {
			history.set(turn, { 
				p1Team, 
				p2Team, 
				p1Sets, 
				p2Sets,
				p1SideConditions,
				p2SideConditions,
				field,
			});
		}
	}

	private getRootBattleId(): string { return this.matchId!; }

	private getBranchBattleId(): string {
		return `${this.matchId}>>branch${this.timelineCounter + 1}`;
	}

	private generateTimelineId(battleId: string): string { return battleId; }

	resolveManagerBattleId(roomOrTimelineId: string): string | null {
		if (this.managedBattleIds.has(roomOrTimelineId)) {
			return this.managedBattleIds.get(roomOrTimelineId)!;
		}
		if (this.manager.getBattle(roomOrTimelineId)) return roomOrTimelineId;
		for (const [globalId, entry] of this.timelineRegistry) {
			if (entry.battleId === roomOrTimelineId) return entry.battleId;
			if (globalId === roomOrTimelineId) return entry.battleId;
		}
		return null;
	}

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

	private getTimelineBattle(globalId: string): any | null {
		const entry = this.timelineRegistry.get(globalId);
		if (!entry) return null;
		return this.manager.getBattle(entry.battleId) || null;
	}

	private hookBattleSend(globalId: string, battle: any) {
		if (!battle) return;
		battle.send = (sendType: string, data: any) => {
			if (Array.isArray(data)) data = data.join('\n');
			this.pushMessage(sendType, data);

			if (sendType === 'update') {
				this.captureSnapshot(globalId, battle);
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
	 * Validate all pending transfers, then group by target (timelineId, turn).
	 * Single-player groups are handled by executeTransfer;
	 * multi-player groups (both players targeting the same point) are handled
	 * by executeJointTransfer, which creates exactly one branch.
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

		if (battle.ended) {
			console.log(`[TIMELINE DEBUG] Battle ended — cancelling all pending transfers`);
			this.pushMessage('update',
				`|-message|Pending transfers cancelled — the battle ended before they could execute.`);
			this.emitTimelineUpdate();
			return;
		}

		// ── Validate: drop transfers where the Pokemon fainted this turn ──
		const validTransfers: Map<string, PendingTransfer> = new Map();
		for (const [sideId, transfer] of transfers) {
			const sourceBattle = this.manager.getBattle(transfer.sourceBattleId);
			if (!sourceBattle) {
				console.log(`[TIMELINE DEBUG] Source battle not found — skipping ${sideId}`);
				this.pushMessage('update',
					`|-message|Transfer cancelled for ${sideId}: source battle unavailable.`);
				continue;
			}

			const side = sourceBattle[transfer.sideId as 'p1' | 'p2'];
			const activePokemon = side?.active?.[0];

			if (!activePokemon || activePokemon.fainted || activePokemon.hp <= 0) {
				console.log(`[TIMELINE DEBUG] Transfer cancelled for ${sideId}: Pokémon fainted`);
				this.pushMessage('update',
					`|-message|${sideId}'s transfer was cancelled — the Pokémon fainted!`);
				continue;
			}

			validTransfers.set(sideId, transfer);
		}

		if (validTransfers.size === 0) {
			console.log(`[TIMELINE DEBUG] No valid transfers — leaving battle state intact`);
			this.emitTimelineUpdate();
			return;
		}

		// ── Group by target (timelineId + turn) ──
		const groups = new Map<string, PendingTransfer[]>();
		for (const transfer of validTransfers.values()) {
			const key = `${transfer.targetGlobalId}::${transfer.targetTurn}`;
			const group = groups.get(key) ?? [];
			group.push(transfer);
			groups.set(key, group);
		}

		console.log(`[TIMELINE DEBUG] ${groups.size} distinct transfer target(s)`);

		let anyTransferExecuted = false;

		for (const [groupKey, groupTransfers] of groups) {
			console.log(`[TIMELINE DEBUG] Group "${groupKey}": ${groupTransfers.map(t => t.sideId).join(', ')}`);
			try {
				this.executeTransferGroup(groupTransfers);
				anyTransferExecuted = true;
			} catch (err: any) {
				console.log(`[TIMELINE DEBUG] Group execution failed: ${err.message}`);
				for (const t of groupTransfers) {
					this.pushMessage('update',
						`|-message|Transfer failed for ${t.sideId}: ${err.message}`);
				}
			}
		}

		if (!anyTransferExecuted) {
			console.log(`[TIMELINE DEBUG] No transfers executed — leaving battle state intact`);
			this.emitTimelineUpdate();
			return;
		}

		this.switchToPresentIfNeeded();

		this.finalizeAfterTransfers(battle);
	}

	/**
	 * Executes one group of transfers that all share the same target
	 * (targetGlobalId + targetTurn). Handles 1 or 2 transferring sides.
	 *
	 * The key insight for correctness: we snapshot the live battle AFTER
	 * removing the transferred Pokémon so that the stored snapshot for the
	 * source timeline's current turn naturally excludes the removed Pokémon.
	 * The target turn's stored snapshot is never mutated — we read it as-is,
	 * and it correctly represents the state at that historical point.
	 */
	private executeTransferGroup(transfers: PendingTransfer[]) {
		if (transfers.length === 0) return;

		const { targetGlobalId, targetTurn, sourceBattleId } = transfers[0];

		for (const t of transfers) {
			if (t.sourceBattleId !== sourceBattleId) {
				throw new Error(
					`Transfer group: mismatched source battles ("${t.sourceBattleId}" vs "${sourceBattleId}")`
				);
			}
		}

		const resolvedTargetId = this.resolveManagerBattleId(targetGlobalId);
		if (!resolvedTargetId) {
			throw new Error(`Target battle "${targetGlobalId}" not found in manager`);
		}

		const transferringSides = new Set(transfers.map(t => t.sideId as 'p1' | 'p2'));
		const allSides: ('p1' | 'p2')[] = ['p1', 'p2'];

		// ── Step 1: Capture all transfer states before modifying anything ──
		// We read from the live battle's active slots.
		const capturedStates = new Map<'p1' | 'p2', PokemonTransferState>();
		for (const transfer of transfers) {
			const side = transfer.sideId as 'p1' | 'p2';
			const state = this.manager.getPokemonTransferState(sourceBattleId, side, 0);
			if (!state) {
				throw new Error(`No active Pokemon to transfer for ${side}`);
			}
			capturedStates.set(side, state);
			console.log(`[TIMELINE DEBUG] Captured ${side}: ${state.set.name || state.set.species}`);
		}

		// ── Step 2: Remove transferred Pokémon from the live battle ──
		// After this, side.pokemon no longer contains the transferred mon.
		for (const side of transferringSides) {
			this.manager.removePokemonAfterCapture(sourceBattleId, side, 0);
			console.log(`[TIMELINE DEBUG] Removed ${side} active from live battle`);
		}

		// ── Step 3: Snapshot the source timeline NOW ──
		// The live battle's team arrays no longer contain the transferred
		// Pokémon, so this snapshot is inherently correct — no filtering
		// or post-hoc mutation of stored snapshots is needed.
		const currentGlobalId = this.battle?.currentTimelineId || '';
		if (currentGlobalId) {
			const srcBattle = this.manager.getBattle(sourceBattleId);
			if (srcBattle) {
				this.captureSnapshot(currentGlobalId, srcBattle);
				console.log(
					`[TIMELINE DEBUG] Captured post-removal snapshot for ` +
					`"${currentGlobalId}" at turn ${srcBattle.turn}`
				);
			}
		}

		// ── Step 4: Rebuild each side from the TARGET turn's snapshot ──
		// The target snapshot is a historical record and is read unmodified.
		for (const side of allSides) {
			const snapshotSets = this.getStoredSets(targetGlobalId, targetTurn, side);
			const snapshotDisplays = this.getStoredSnapshots(targetGlobalId, targetTurn, side);

			if (transferringSides.has(side)) {
				// Transferring side: replace team and inject captured Pokémon
				const transferredState = capturedStates.get(side)!;
				console.log(`[TIMELINE DEBUG] Replacing team for ${side} (transferring)`);
				const result = this.manager.replaceTeamFromSnapshot(
					sourceBattleId,
					side,
					snapshotSets || [],
					snapshotDisplays || [],
					transferredState
				);
				if (!result.success) {
					throw new Error(`replaceTeamFromSnapshot failed for ${side}: ${result.error}`);
				}
			} else {
				// Non-transferring side: restore from target snapshot
				if (snapshotSets && snapshotSets.length > 0) {
					console.log(`[TIMELINE DEBUG] Restoring team for ${side} (non-transferring)`);
					const result = this.manager.restoreTeamFromSnapshot(
						sourceBattleId,
						side,
						snapshotSets,
						snapshotDisplays || []
					);
					if (!result.success) {
						console.log(`[TIMELINE DEBUG] Warning: restoreTeamFromSnapshot failed for ${side}: ${result.error}`);
					}
				}
			}
		}

		// ── Step 5: Register the branch timeline ──
		const branchGlobalId = this.registerBranch(sourceBattleId, targetGlobalId, targetTurn);
		const branchNum = this.timelineRegistry.get(branchGlobalId)!.num;

		// ── Step 6: Snapshot the branch's initial state ──
		// This reads the now-rebuilt live battle (transferred mon + target
		// snapshot bench) and stores it as the branch's first turn entry.
		const srcBattle = this.manager.getBattle(sourceBattleId);
		if (srcBattle) this.captureSnapshot(branchGlobalId, srcBattle);

		// ── Step 7: Push transfer message ──
		const sideList = [...transferringSides].join(' and ');
		const coord = `Timeline ${targetGlobalId}, Turn ${targetTurn}`;
		this.pushMessage('update',
			`|-message|${sideList}'s Pokémon transferred to ${coord}! Branch #${branchNum} created at turn ${targetTurn + 1}.`
		);
	}

	/**
	 * Create and register a branch timeline entry.
	 * Shared between executeTransfer and executeJointTransfer.
	 * Handles:  registry entry creation, send hook installation,
	 * active timeline pointer update, and turn reset.
	 *
	 * Returns the new branch's globalId.
	 */
	private registerBranch(
		sourceBattleId: string,
		targetGlobalId: string,
		targetTurn: number
	): string {
		const targetEntry = this.timelineRegistry.get(targetGlobalId);
		if (!targetEntry) {
			throw new Error(`Target timeline "${targetGlobalId}" not in registry`);
		}

		this.timelineCounter++;
		const branchGlobalId = `${this.matchId}>>branch${this.timelineCounter}`;
		const branchEntry = {
			battleId: sourceBattleId,
			num: this.timelineCounter,
			parentNum: targetEntry.num,
			fromTurn: targetTurn,
			globalId: branchGlobalId,
		};

		this.timelineRegistry.set(branchGlobalId, branchEntry);
		this.managedBattleIds.set(branchGlobalId, sourceBattleId);
		console.log(`[TIMELINE DEBUG] Registered branch: globalId="${branchGlobalId}" ` +
			`(num=${branchEntry.num}, parent=#${targetEntry.num}, fromTurn=${targetTurn})`);

		// Branch history starts empty — snapshot will be captured by caller
		this.turnSnapshots.set(branchGlobalId, new Map());

		const sourceBattle = this.manager.getBattle(sourceBattleId);
		this.hookBattleSend(branchGlobalId, sourceBattle);

		if (this.battle) {
			this.battle.currentTimelineId = branchGlobalId;
			this.battle.currentTimeline = { ...branchEntry, battle: sourceBattle };
		}

		if (sourceBattle) {
			const branchStartTurn = targetTurn + 1;
			const oldTurn = sourceBattle.turn;
			sourceBattle.turn = branchStartTurn;
			sourceBattle.add('turn', branchStartTurn);
			console.log(`[TIMELINE DEBUG] Reset turn: ${oldTurn} → ${branchStartTurn} for branch #${branchEntry.num}`);
		}

		this.manager.linkBattles(
			this.resolveManagerBattleId(targetGlobalId)!,
			sourceBattleId
		);

		return branchGlobalId;
	}

	/**
	 * Post-transfer cleanup shared by all transfer paths.
	 * Ensures slotConditions are valid, issues a move request,
	 * flushes battle updates, and emits the timeline visualization.
	 */
	private finalizeAfterTransfers(battle: any) {
		// Ensure slotConditions are valid for all sides
		for (const side of battle.sides) {
			if (!side) continue;
			if (!side.slotConditions) side.slotConditions = [];
			for (let i = 0; i < side.active.length; i++) {
				if (!side.slotConditions[i]) side.slotConditions[i] = {};
			}
		}

		// Issue move request; fall back to manual construction if needed
		try {
			console.log(`[TIMELINE DEBUG] Issuing move request after transfers`);
			battle.makeRequest('move');
		} catch (e: any) {
			console.log(`[TIMELINE DEBUG] makeRequest threw: ${e.message} — attempting fallback`);
			try {
				battle.requestState = 'move';
				for (const side of battle.sides) {
					if (!side) continue;
					side.clearChoice();

					const pokemon = side.pokemon.map((mon: any, i: number) => {
						const isActive = i < side.active.length && side.active[i] === mon;
						return {
							ident: `${side.id}: ${mon.name}`,
							details: mon.details || `${mon.species.name}, L${mon.level}`,
							condition: mon.fainted
								? '0 fnt'
								: `${mon.hp}/${mon.maxhp}${mon.status ? ` ${mon.status}` : ''}`,
							active: isActive,
							stats: {
								atk: mon.baseStoredStats?.atk || 0,
								def: mon.baseStoredStats?.def || 0,
								spa: mon.baseStoredStats?.spa || 0,
								spd: mon.baseStoredStats?.spd || 0,
								spe: mon.baseStoredStats?.spe || 0,
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

					const activeMon = side.active[0];
					let activeData: any[] = [];
					if (activeMon && !activeMon.fainted) {
						activeData = [{
							moves: activeMon.moveSlots.map((s: any) => ({
								move: s.move,
								id: s.id,
								pp: s.pp,
								maxpp: s.maxpp,
								target: s.target || 'normal',
								disabled: s.disabled || false,
							})),
							canDynamax: false,
							canTerastallize: activeMon.teraType && !activeMon.terastallized
								? activeMon.teraType : undefined,
						}];
					}

					const request: any = {
						requestType: 'move',
						active: activeData,
						side: { name: side.name, id: side.id, pokemon },
					};

					if (!activeMon || activeMon.fainted) {
						const hasAlive = side.pokemon.some((p: any) => !p.fainted && p.hp > 0);
						request.requestType = hasAlive ? 'switch' : 'wait';
						if (hasAlive) {
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
				console.log(`[TIMELINE DEBUG] Manual fallback also failed: ${fallbackErr.message}`);
			}
		}

		try {
			battle.sendUpdates();
		} catch (e: any) {
			console.log(`[TIMELINE DEBUG] sendUpdates threw: ${e.message}`);
		}

		const entry = this.timelineRegistry.get(this.battle!.currentTimelineId);
		if (entry) this.captureSnapshot(this.battle!.currentTimelineId, battle);
		this.emitTimelineUpdate();
	}

	private emitTimelineUpdate() {
		const data = this._getTimelineNodes();
		this.pushMessage('update', `|timenodes|${JSON.stringify(data)}`);
	}

	/** Each timeline's head turn — NOT battle.turn (which is shared). */
	private getTimelineHeadTurn(globalId: string): number {
		// The current timeline owns battle.turn
		if (globalId === this.battle?.currentTimelineId) {
			const entry = this.timelineRegistry.get(globalId);
			const b = entry ? this.manager.getBattle(entry.battleId) : null;
			if (b) return b.turn;
		}
		// Non-current timelines: use their snapshot history's max turn
		const history = this.turnSnapshots.get(globalId);
		if (history && history.size > 0) {
			let max = 0;
			for (const t of history.keys()) if (t > max) max = t;
			return max;
		}
		// Newly-minted branch with no snapshot yet
		const entry = this.timelineRegistry.get(globalId);
		return entry?.fromTurn != null ? entry.fromTurn + 1 : 0;
	}

	/** Pure computation — no side effects. Safe for _getTimelineNodes. */
	private computePresentId(): string {
		let presentId = '';
		let lowestTurn = Infinity;
		let lowestNum = Infinity;

		for (const [globalId, entry] of this.timelineRegistry) {
			const b = this.manager.getBattle(entry.battleId);
			if (!b || b.ended) continue;

			const turn = this.getTimelineHeadTurn(globalId);
			if (turn < lowestTurn || (turn === lowestTurn && entry.num < lowestNum)) {
				lowestTurn = turn;
				lowestNum = entry.num;
				presentId = globalId;
			}
		}
		return presentId || this.battle?.currentTimelineId || '';
	}

	/**
	 * Switch the active Battle to the present timeline, restoring both
	 * teams from that timeline's snapshot. Returns true if a switch happened.
	 */
	private switchToPresentIfNeeded(): boolean {
		const presentId = this.computePresentId();
		if (!presentId || !this.battle) return false;
		if (this.battle.currentTimelineId === presentId) return false;

		const entry = this.timelineRegistry.get(presentId)!;
		const battle = this.manager.getBattle(entry.battleId);
		if (!battle) return false;

		const presentTurn = this.getTimelineHeadTurn(presentId);
		console.log(`[TIMELINE DEBUG] Present shift: ${this.battle.currentTimelineId} → ${presentId} @ turn ${presentTurn}`);

		// Snapshot the outgoing timeline so it can be revisited later
		const outgoingId = this.battle.currentTimelineId;
		const outEntry = this.timelineRegistry.get(outgoingId);
		const outBattle = outEntry ? this.manager.getBattle(outEntry.battleId) : null;
		if (outBattle) this.captureSnapshot(outgoingId, outBattle);

		// Restore both sides from the present node's snapshot
		for (const side of ['p1', 'p2'] as const) {
			const sets = this.getStoredSets(presentId, presentTurn, side);
			const displays = this.getStoredSnapshots(presentId, presentTurn, side);
			if (sets?.length && displays?.length) {
				this.manager.restoreTeamFromSnapshot(entry.battleId, side, sets, displays);
			}
		}
		battle.turn = presentTurn;

		this.battle.currentTimelineId = presentId;
		this.battle.currentTimeline = { ...entry, battle };
		this.hookBattleSend(presentId, battle);
		return true;
	}

	// Keep the old name as a thin wrapper for existing callers:
	private computeAndSwitchToPresent(): string {
		this.switchToPresentIfNeeded();
		return this.battle?.currentTimelineId || '';
	}

	override _write(chunk: string) {
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

		if (this.battle) this.battle.sendUpdates();

		if (this.turnJustResolved) {
			this.turnJustResolved = false;
			this.executePendingTransfers();
		} else if (this.switchToPresentIfNeeded()) {
			// A normal turn advanced one timeline past another — realign
			const b = this.battle?.battle;
			if (b && !b.ended) this.finalizeAfterTransfers(b);
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
			if (!this.matchId) {
				throw new Error('Invalid match ID');
			}
			console.log(`[TIMELINE DEBUG] Starting match: ${this.matchId}`);

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

			if (!this.battle) {
				this.battle = new MultiTimeBattle(this.manager, this.matchId);
			}
			this.battle.currentTimelineId = timeline.globalId;
			this.battle.currentTimeline = { ...timeline, battle };
			this.hookBattleSend(timeline.globalId, battle);
			this.emitTimelineUpdate();
			break;
		}
		case 'player': {
			const [slot, playerJson] = splitFirst(message, ' ');
			const playerData = JSON.parse(playerJson);

			if (!this.battle?.currentTimeline) throw new Error('No active match');

			const entry = this.timelineRegistry.get(this.battle.currentTimelineId);
			if (entry) {
				this.manager.setPlayer(entry.battleId, slot as any, {
					name: playerData.name,
					team: playerData.team,
					avatar: playerData.avatar,
				});
			} else {
				this.battle.currentTimeline.battle?.setPlayer(slot as any, playerData);
			}
			break;
		}
		case 'p1':
		case 'p2':
		case 'p3':
		case 'p4': {
			if (!this.battle?.currentTimeline) throw new Error('No active timeline');

			this.computeAndSwitchToPresent();

			const sideId = type as 'p1' | 'p2' | 'p3' | 'p4';
			const entry = this.timelineRegistry.get(this.battle.currentTimelineId);
			if (!entry) throw new Error(`Timeline ${this.battle.currentTimelineId} not registered`);

			// ── Transfer command ──
			if (message.startsWith('transfer|') || message.split('|')[0] === 'transfer') {
				const parts = message.split('|');
				const targetGlobalId = parts[1];
				const targetTurn = parseInt(parts[2]);

				if (!targetGlobalId || isNaN(targetTurn)) {
					this.pushMessage('sideupdate',
						`${sideId}\n|error|[Invalid transfer] Invalid timeline or turn`);
					break;
				}

				this.pendingTransfers.set(sideId, {
					sideId,
					sourceBattleId: entry.battleId,
					targetGlobalId,
					targetTurn,
				});

				console.log(`[TIMELINE DEBUG] Transfer pending for ${sideId}: ${targetGlobalId} turn ${targetTurn}`);

				const battle = this.manager.getBattle(entry.battleId);
				if (!battle) {
					this.pushMessage('sideupdate',
						`${sideId}\n|error|[Invalid transfer] Battle not found`);
					this.pendingTransfers.delete(sideId);
					break;
				}

				const side = battle[sideId];
				if (!side) {
					this.pushMessage('sideupdate',
						`${sideId}\n|error|[Invalid transfer] Side not found`);
					this.pendingTransfers.delete(sideId);
					break;
				}

				side.clearChoice();
				side.choice.actions.push({ choice: 'pass' } as any);
				side.choice.cantUndo = true;

				if (battle.allChoicesDone()) battle.commitChoices();
				break;
			}

			// ── Normal choice ──
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

				const newTimeline = this.registerTimeline(newBattleId, currentEntry.num, turn);

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
							newHistory.set(t, deepCloneTurnSnapshot(snap));
						}
					}
					this.turnSnapshots.set(newTimeline.globalId, newHistory);
				}

				this.hookBattleSend(newTimeline.globalId, newBattle);
				this.battle.currentTimelineId = newTimeline.globalId;
				this.battle.currentTimeline = { ...newTimeline, battle: newBattle };

				this.pushMessage('update',
					`|-message|Branched timeline #${newTimeline.num} from turn ${turn}`);
				this.emitTimelineUpdate();
			} catch (err: any) {
				this.pushMessage('update', `|error|Failed to branch: ${err.message}`);
			}
			break;
		}
		}
	}

	private _getTimelineNodes(): { nodes: TimelineNodeData[] } {
		if (!this.matchId) return { nodes: [] };

		const trackedId = this.battle?.currentTimelineId || '';
		if (trackedId) {
			const trackedEntry = this.timelineRegistry.get(trackedId);
			if (trackedEntry) {
				const trackedBattle = this.manager.getBattle(trackedEntry.battleId);
				if (trackedBattle) this.captureSnapshot(trackedId, trackedBattle);
			}
		}

		const computedCurrentId = this.computePresentId();
		const allNodes: TimelineNodeData[] = [];

		for (const [globalId, entry] of this.timelineRegistry) {
			const battle = this.manager.getBattle(entry.battleId);
			const history = this.turnSnapshots.get(globalId);
			const ended = battle?.ended ?? false;

			const emptyField: FieldSnapshot = { weather: null, terrain: null, pseudoWeather: [] };

			if (!history || history.size === 0) {
				console.log(`[Timeline Nodes] ${globalId}: no history, creating empty node`);
				allNodes.push({
					timelineId: globalId,
					timelineNum: entry.num,
					turn: battle?.turn ?? 0,
					parentTimelineId: entry.parentNum ? this.findGlobalIdByNum(entry.parentNum) : null,
					branchTurn: entry.fromTurn,
					isCurrent: computedCurrentId === globalId,
					ended,
					p1Team: [],
					p2Team: [],
					p1SideConditions: [],
					p2SideConditions: [],
					field: emptyField,
				});
				continue;
			}

			const parentGlobalId = entry.parentNum ? this.findGlobalIdByNum(entry.parentNum) : null;
			let maxTurn = 0;
			for (const [t] of history) { if (t > maxTurn) maxTurn = t; }

			for (const [turn, snap] of history) {
				console.log(`[Timeline Nodes] ${globalId} turn ${turn}: p1 conditions=[${snap.p1SideConditions.map(c => c.id).join(', ')}], field weather=${snap.field.weather?.id || 'none'}`);
				allNodes.push({
					timelineId: globalId,
					timelineNum: entry.num,
					turn,
					parentTimelineId: parentGlobalId,
					branchTurn: entry.fromTurn,
					isCurrent: computedCurrentId === globalId && turn === maxTurn,
					ended,
					p1Team: snap.p1Team.map(toClientSnapshot),
					p2Team: snap.p2Team.map(toClientSnapshot),
					p1SideConditions: snap.p1SideConditions,
					p2SideConditions: snap.p2SideConditions,
					field: snap.field,
				});
			}
		}

		console.log(`[Timeline Nodes] Generated ${allNodes.length} total nodes`);
		return { nodes: allNodes };
	}

	private findGlobalIdByNum(num: number): string | null {
		for (const [globalId, entry] of this.timelineRegistry) {
			if (entry.num === num) return globalId;
		}
		return null;
	}

	/**
	 * Retrieves stored PokemonSets for a timeline at a given turn.
	 * Uses "closest turn ≤ requested" lookup.
	 *
	 * NOTE: The returned sets reflect whatever was in the live battle
	 * when captureSnapshot was called for that turn. If a Pokémon was
	 * removed before the snapshot was taken (e.g. via transfer), it
	 * will already be absent — no caller-side filtering is needed.
	 */
	getStoredSets(timelineId: string, turn: number, side: 'p1' | 'p2'): PokemonSet[] | null {
		const history = this.turnSnapshots.get(timelineId);
		if (!history) return null;

		let closestTurn = -1;
		for (const [t] of history) {
			if (t <= turn && t > closestTurn) closestTurn = t;
		}
		if (closestTurn === -1) return null;

		const snap = history.get(closestTurn)!;
		const sets = side === 'p1' ? snap.p1Sets : snap.p2Sets;
		console.log(`[Timeline Team] getStoredSets("${timelineId}", turn=${turn}, side=${side}) -> ${sets.length} sets from turn ${closestTurn}`);
		return sets;
	}

	getStoredSnapshots(timelineId: string, turn: number, side: 'p1' | 'p2'): PokemonSnapshot[] | null {
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

	/**
	 * Retrieves stored side conditions for a timeline at a given turn.
	 */
	getStoredSideConditions(timelineId: string, turn: number, side: 'p1' | 'p2'): SideConditionSnapshot[] | null {
		const history = this.turnSnapshots.get(timelineId);
		if (!history) {
			console.log(`[Timeline Side] getStoredSideConditions: no history for ${timelineId}`);
			return null;
		}

		let closestTurn = -1;
		for (const [t] of history) {
			if (t <= turn && t > closestTurn) closestTurn = t;
		}
		if (closestTurn === -1) {
			console.log(`[Timeline Side] getStoredSideConditions: no turn <= ${turn} in history`);
			return null;
		}

		const snap = history.get(closestTurn)!;
		const conditions = side === 'p1' ? snap.p1SideConditions : snap.p2SideConditions;
		console.log(`[Timeline Side] getStoredSideConditions("${timelineId}", turn=${turn}, side=${side}) -> ${conditions.length} conditions from turn ${closestTurn}`);
		return conditions;
	}

	/**
	 * Retrieves stored field snapshot for a timeline at a given turn.
	 */
	getStoredField(timelineId: string, turn: number): FieldSnapshot | null {
		const history = this.turnSnapshots.get(timelineId);
		if (!history) {
			console.log(`[Timeline Field] getStoredField: no history for ${timelineId}`);
			return null;
		}

		let closestTurn = -1;
		for (const [t] of history) {
			if (t <= turn && t > closestTurn) closestTurn = t;
		}
		if (closestTurn === -1) {
			console.log(`[Timeline Field] getStoredField: no turn <= ${turn} in history`);
			return null;
		}

		const snap = history.get(closestTurn)!;
		console.log(`[Timeline Field] getStoredField("${timelineId}", turn=${turn}) -> weather=${snap.field.weather?.id || 'none'}, terrain=${snap.field.terrain?.id || 'none'} from turn ${closestTurn}`);
		return snap.field;
	}
}