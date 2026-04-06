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
	FieldSnapshot,
	FieldConditionSnapshot,
	SideConditionSnapshot,
	SlotConditionSnapshot,
	VolatileSnapshot,
	BattleSideID,
	ALL_SIDE_IDS
} from './multi-battle-manager';
import { State } from './state';

/**
 * One entry in a timeline's turn-history map. `sides` holds client-facing
 * data for visualization; `serializedBattle` holds the complete engine
 * state for branch restoration via State.deserializeBattle.
 */
type TurnSnapshotEntry = {
	sides: Partial<Record<BattleSideID, SideSnapshotData>>;
	field: FieldSnapshot;
	serializedBattle: AnyObject | null;
};

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
	p3Team?: PokemonSnapshotClient[];            // NEW
	p4Team?: PokemonSnapshotClient[];            // NEW
	p1SideConditions: SideConditionSnapshot[];
	p2SideConditions: SideConditionSnapshot[];
	p3SideConditions?: SideConditionSnapshot[];  // NEW
	p4SideConditions?: SideConditionSnapshot[];  // NEW
	field: FieldSnapshot;
}

/**
 * Per-side data stored in a turn snapshot. Grouped so the snapshot structure
 * scales to any player count without adding 4 fields per side.
 */
type SideSnapshotData = {
	team: PokemonSnapshot[];
	sets: PokemonSet[];
	sideConditions: SideConditionSnapshot[];
	slotConditions: { [slot: number]: SlotConditionSnapshot[] };
};

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

/**
 * Captures an active Pokemon's volatiles with full EffectState data.
 *
 * Same approach as extractSideConditions: id + duration + source name +
 * sourceSlot + extraData for everything else. extraData picks up the
 * volatile-specific fields that make the condition actually work —
 * Substitute's `hp`, Encore's `move`, Stockpile's `layers`,
 * Confusion's `time`, Leech Seed's source tracking.
 *
 * Without this, the old string[] capture let restoreTeamFromSnapshot
 * put a Substitute back on a Pokemon, but the first attack of any
 * strength would break it because the sub's hp was never stored.
 */
function extractVolatileSnapshots(pokemon: any): VolatileSnapshot[] {
	if (!pokemon?.volatiles) return [];

	const out: VolatileSnapshot[] = [];
	for (const id in pokemon.volatiles) {
		const state = pokemon.volatiles[id];
		out.push({
			id,
			turnsLeft: state.duration,
			source: state.source?.name,
			sourceSlot: state.sourceSlot,
			extraData: extractExtraEffectData(state),
		});
	}
	return out;
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
			// Full EffectState capture instead of just Object.keys().
			// Bench Pokemon don't have volatiles (they're cleared on switch
			// out), so this is only non-empty for the active slot.
			volatiles: isActive && !fainted
				? extractVolatileSnapshots(pokemon)
				: [],
		};
	});
}


/**
 * EffectState keys that are either handled explicitly by the snapshot
 * schema (id, duration, layers, sourceSlot) or hold live game-object
 * references that can't be serialized (target, source). Everything NOT
 * in this set is captured into extraData.
 */
const EFFECTSTATE_STANDARD_KEYS = new Set([
	'id', 'target', 'source', 'sourceSlot', 'duration', 'effectOrder',
	'layers', 'isSlotCondition',
]);

/**
 * Captures condition-specific EffectState fields beyond the standard set.
 *
 * Some conditions stash extra data in their EffectState during
 * onSideStart/onFieldStart/onStart that the engine reads later when the
 * condition resolves. Future Sight stores `move` and `moveData`; Wish
 * stores `hp`. Without capturing these, a restored Future Sight would
 * count down correctly but deal zero damage on resolution.
 *
 * Game-object references (anything with a .battle / .side back-pointer
 * or a getSlot method) are skipped — they can't survive serialization
 * and would be stale after team rebuild anyway. Plain objects are
 * deep-copied via JSON round-trip, which also catches circular refs.
 */
function extractExtraEffectData(state: any): { [key: string]: any } | undefined {
	if (!state) return undefined;
	const extra: { [key: string]: any } = {};
	let hasExtra = false;

	for (const key in state) {
		if (EFFECTSTATE_STANDARD_KEYS.has(key)) continue;
		const val = state[key];

		if (val === null || val === undefined) {
			extra[key] = val;
			hasExtra = true;
			continue;
		}

		if (typeof val === 'function') continue;

		if (typeof val === 'object') {
			// Skip live game objects — Pokemon, Side, Battle, Field all
			// carry a .battle or .side pointer, or expose getSlot().
			if (val.battle || val.side || typeof val.getSlot === 'function') continue;
			if (Array.isArray(val) && val.length > 0 && (val[0]?.battle || val[0]?.side)) continue;
			// JSON round-trip: deep copy, drops functions, throws on cycles
			try {
				extra[key] = JSON.parse(JSON.stringify(val));
				hasExtra = true;
			} catch {
				// Circular or otherwise unserializable — skip silently
			}
		} else {
			extra[key] = val;
			hasExtra = true;
		}
	}

	return hasExtra ? extra : undefined;
}

/**
 * Reads weather, terrain, and pseudo-weather from a live battle's field.
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
			sourceSlot: field.weatherState?.sourceSlot,
			extraData: extractExtraEffectData(field.weatherState),
		};
		console.log(`[Timeline Field]   Weather captured: ${weather.id}, turnsLeft: ${weather.turnsLeft ?? 'infinite'}`);
	}

	let terrain: FieldConditionSnapshot | null = null;
	if (field.terrain) {
		terrain = {
			id: field.terrain,
			turnsLeft: field.terrainState?.duration,
			source: field.terrainState?.source?.name,
			sourceSlot: field.terrainState?.sourceSlot,
			extraData: extractExtraEffectData(field.terrainState),
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
				sourceSlot: state.sourceSlot,
				extraData: extractExtraEffectData(state),
			});
			console.log(`[Timeline Field]   PseudoWeather captured: ${id}, turnsLeft: ${state.duration ?? 'infinite'}`);
		}
	}

	return { weather, terrain, pseudoWeather };
}

/**
 * Reads one side's sideConditions dict.
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
			sourceSlot: state.sourceSlot,
			extraData: extractExtraEffectData(state),
		});
		console.log(`[Timeline Side]   ${side.id} condition: ${id}, turnsLeft: ${state.duration ?? 'N/A'}, layers: ${state.layers ?? 'N/A'}`);
	}

	if (conditions.length === 0) {
		console.log(`[Timeline Side]   ${side.id} has no side conditions`);
	}

	return conditions;
}

/**
 * Reads one side's slotConditions array. Returns a sparse object keyed by
 * slot index, only including slots that have at least one condition.
 */
function extractSlotConditions(side: any): { [slot: number]: SlotConditionSnapshot[] } {
	const result: { [slot: number]: SlotConditionSnapshot[] } = {};
	if (!side?.slotConditions) {
		console.log(`[Timeline Slot] extractSlotConditions: no slotConditions array for ${side?.id || 'unknown'}`);
		return result;
	}

	let total = 0;
	for (let slot = 0; slot < side.slotConditions.length; slot++) {
		const slotConds = side.slotConditions[slot];
		if (!slotConds) continue;
		const ids = Object.keys(slotConds);
		if (ids.length === 0) continue;

		result[slot] = [];
		for (const id of ids) {
			const state = slotConds[id];
			result[slot].push({
				id: id,
				turnsLeft: state.duration,
				source: state.source?.name,
				sourceSlot: state.sourceSlot,
				extraData: extractExtraEffectData(state),
			});
			total++;
			console.log(`[Timeline Slot]   ${side.id} slot ${slot}: ${id}, turnsLeft: ${state.duration ?? 'N/A'}`);
		}
	}

	if (total === 0) {
		console.log(`[Timeline Slot]   ${side.id} has no slot conditions`);
	}

	return result;
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
 * Deep-clones a PokemonSnapshot, including nested objects.
 */
function deepCloneSnapshot(p: PokemonSnapshot): PokemonSnapshot {
	return {
		...p,
		boosts: { ...p.boosts },
		volatiles: p.volatiles.map(v => ({ ...v, extraData: cloneExtraData(v.extraData) })),
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
 * Deep-clones extraData via JSON round-trip. extraData is already
 * JSON-safe (extractExtraEffectData guarantees that), so this is lossless.
 */
function cloneExtraData(extra: { [key: string]: any } | undefined): { [key: string]: any } | undefined {
	if (!extra) return undefined;
	return JSON.parse(JSON.stringify(extra));
}

/**
 * Deep-clones a FieldSnapshot.
 */
function deepCloneFieldSnapshot(field: FieldSnapshot): FieldSnapshot {
	return {
		weather: field.weather
			? { ...field.weather, extraData: cloneExtraData(field.weather.extraData) }
			: null,
		terrain: field.terrain
			? { ...field.terrain, extraData: cloneExtraData(field.terrain.extraData) }
			: null,
		pseudoWeather: field.pseudoWeather.map(pw => ({ ...pw, extraData: cloneExtraData(pw.extraData) })),
	};
}

/**
 * Deep-clones an array of SideConditionSnapshots.
 */
function deepCloneSideConditions(conditions: SideConditionSnapshot[]): SideConditionSnapshot[] {
	return conditions.map(c => ({ ...c, extraData: cloneExtraData(c.extraData) }));
}

/**
 * Deep-clones a slot-conditions object (sparse map of slot → condition list).
 */
function deepCloneSlotConditions(
	slotConds: { [slot: number]: SlotConditionSnapshot[] }
): { [slot: number]: SlotConditionSnapshot[] } {
	const out: { [slot: number]: SlotConditionSnapshot[] } = {};
	for (const slotStr in slotConds) {
		const slot = parseInt(slotStr, 10);
		out[slot] = slotConds[slot].map(c => ({ ...c, extraData: cloneExtraData(c.extraData) }));
	}
	return out;
}

function deepCloneSideSnapshotData(d: SideSnapshotData): SideSnapshotData {
	return {
		team: d.team.map(deepCloneSnapshot),
		sets: d.sets.map(deepCloneSet),
		sideConditions: deepCloneSideConditions(d.sideConditions),
		slotConditions: deepCloneSlotConditions(d.slotConditions),
	};
}

/**
 * Deep-clones a full turn snapshot entry.
 */
function deepCloneTurnSnapshot(snap: TurnSnapshotEntry): TurnSnapshotEntry {
	const sides: Partial<Record<BattleSideID, SideSnapshotData>> = {};
	for (const sideId of ALL_SIDE_IDS) {
		const data = snap.sides[sideId];
		if (data) sides[sideId] = deepCloneSideSnapshotData(data);
	}
	return {
		sides,
		field: deepCloneFieldSnapshot(snap.field),
		serializedBattle: snap.serializedBattle
			? JSON.parse(JSON.stringify(snap.serializedBattle))
			: null,
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

	private turnSnapshots: Map<string, Map<number, TurnSnapshotEntry>> = new Map();

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

	private captureSnapshot(timelineId: string, battle: any) {
		if (!battle || !battle.field) return;
		const currentTurn = battle.turn ?? 0;

		if (currentTurn < 1) return;
		const turn = currentTurn - 1;

		if (!this.turnSnapshots.has(timelineId)) {
			this.turnSnapshots.set(timelineId, new Map());
		}
		const history = this.turnSnapshots.get(timelineId)!;

		const sides: Partial<Record<BattleSideID, SideSnapshotData>> = {};
		let anyTeam = false;

		for (const battleSide of (battle.sides ?? [])) {
			if (!battleSide) continue;
			const sideId = battleSide.id as BattleSideID;

			const team = extractTeamSnapshot(battleSide);
			const sets = extractTeamSets(battleSide);
			const sideConditions = extractSideConditions(battleSide);
			const slotConditions = extractSlotConditions(battleSide);

			if (team.length > 0) anyTeam = true;

			sides[sideId] = { team, sets, sideConditions, slotConditions };

			console.log(`[Timeline Snapshot]   ${sideId} team: ${team.length}, conditions: [${sideConditions.map(c => c.id).join(', ')}]`);
		}

		const field = extractFieldSnapshot(battle);

		// Serialized state for completeness — failure here is non-fatal
		// since the surgical snapshot data above is sufficient for branching.
		let serializedBattle: AnyObject | null = null;
		try {
			serializedBattle = State.serializeBattle(battle);
			delete serializedBattle.log;
		} catch (e: any) {
			console.log(`[Timeline Snapshot] State.serializeBattle failed for turn ${turn}: ${e.message}`);
		}

		console.log(`[Timeline Snapshot] Capturing turn ${turn} for ${timelineId} (${Object.keys(sides).length} sides)`);
		console.log(`[Timeline Snapshot]   field: weather=${field.weather?.id || 'none'}, terrain=${field.terrain?.id || 'none'}`);

		if (anyTeam) {
			history.set(turn, { sides, field, serializedBattle });
		}
	}

	/**
	 * Returns the serialized battle state for the closest turn <= requested.
	 */
	getStoredSerializedState(timelineId: string, turn: number): AnyObject | null {
		const snap = this.lookupSnapshot(timelineId, turn);
		return snap?.serializedBattle ?? null;
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
		const stream = this;
		const customSend = function(sendType: string, data: any) {
			if (Array.isArray(data)) data = data.join('\n');
			stream.pushMessage(sendType, data);

			if (sendType === 'update') {
				stream.captureSnapshot(globalId, battle);
				if (stream.pendingTransfers.size > 0) {
					stream.turnJustResolved = true;
					console.log(`[TIMELINE DEBUG] Turn resolved with ${stream.pendingTransfers.size} pending transfers`);
				} else {
					stream.emitTimelineUpdate();
				}
			}
		};

		Object.defineProperty(battle, 'send', {
			value: customSend,
			writable: true,
			configurable: true,
		});
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
			throw new Error(`No battle found for transfer execution`);
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
				throw new Error(`Source battle not found for ${sideId} transfer`);
			}

			const side = sourceBattle[transfer.sideId as BattleSideID];
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

		// Errors propagate — the battle crashes on failure
		for (const [groupKey, groupTransfers] of groups) {
			console.log(`[TIMELINE DEBUG] Group "${groupKey}": ${groupTransfers.map(t => t.sideId).join(', ')}`);
			this.executeTransferGroup(groupTransfers);
		}

		this.switchToPresentIfNeeded();
		this.finalizeAfterTransfers(battle);
	}

	/**
	 * Executes one group of transfers that all share the same target
	 * (targetGlobalId + targetTurn).
	 *
	 * Restoration ordering:
	 *
	 *   1.  Capture transferred-Pokemon states (read live active slots)
	 *   2.  Remove transferred Pokemon from the live battle
	 *   3.  Snapshot the source timeline post-removal
	 *   4.  Restore FIELD from target turn (battle-scoped, once)
	 *   5.  Restore BOTH SIDES' side conditions from target turn
	 *       — must finish before any switchIn so entry hazards are correct
	 *   6.  Rebuild each side's team:
	 *       — transferring side: roster rebuilt, switchIn DEFERRED
	 *       — non-transferring side: roster rebuilt, active placed directly
	 *   7.  Reset battle engine state (queue, midTurn, request, etc.)
	 *       — ensures switchIn and makeRequest operate on clean state
	 *   8.  switchIn for each transferred Pokemon
	 *       — runs in clean battle context so hazards/abilities fire correctly
	 *   9.  Reconnect source refs on field + side conditions
	 *  10.  Restore slot conditions
	 *  11.  Register branch, snapshot its initial state
	 *
	 * Errors propagate — the battle crashes rather than limping forward
	 * with inconsistent state.
	 */
	private executeTransferGroup(transfers: PendingTransfer[]) {
		if (transfers.length === 0) return;

		const { targetGlobalId, targetTurn, sourceBattleId } = transfers[0];

		for (const t of transfers) {
			if (t.sourceBattleId !== sourceBattleId) {
				throw new Error(`Transfer group: mismatched source battles`);
			}
		}

		const resolvedTargetId = this.resolveManagerBattleId(targetGlobalId);
		if (!resolvedTargetId) {
			throw new Error(`Target battle "${targetGlobalId}" not found`);
		}

		const sourceBattle = this.manager.getBattle(sourceBattleId);
		if (!sourceBattle) throw new Error(`Source battle not found`);
		const allSides: BattleSideID[] = sourceBattle.sides
			.filter((s: any) => s)
			.map((s: any) => s.id as BattleSideID);

		const transferringSides = new Set<BattleSideID>(
			transfers.map(t => t.sideId as BattleSideID)
		);

		// ── Step 1: Capture ──
		const capturedStates = new Map<BattleSideID, PokemonTransferState>();
		for (const transfer of transfers) {
			const side = transfer.sideId as BattleSideID;
			const state = this.manager.getPokemonTransferState(sourceBattleId, side, 0);
			if (!state) throw new Error(`No active Pokemon to transfer for ${side}`);
			capturedStates.set(side, state);
		}

		// ── Step 2: Remove ──
		for (const side of transferringSides) {
			this.manager.removePokemonAfterCapture(sourceBattleId, side, 0);
		}

		// ── Step 3: Snapshot source post-removal ──
		const currentGlobalId = this.battle?.currentTimelineId || '';
		if (currentGlobalId) {
			const b = this.manager.getBattle(sourceBattleId);
			if (b) this.captureSnapshot(currentGlobalId, b);
		}

		// ── Step 4: Field ──
		const targetField = this.getStoredField(targetGlobalId, targetTurn);
		this.manager.restoreField(sourceBattleId, targetField);

		// ── Step 5: Side conditions ──
		const sideCondsBySide: Partial<Record<BattleSideID, SideConditionSnapshot[] | null>> = {};
		for (const side of allSides) {
			const sideConds = this.getStoredSideConditions(targetGlobalId, targetTurn, side);
			sideCondsBySide[side] = sideConds;
			this.manager.restoreSideConditions(sourceBattleId, side, sideConds);
		}

		// ── Step 6: Teams — transferring sides defer switchIn ──
		const deferredSwitchIns = new Map<BattleSideID, any>(); // Pokemon objects

		for (const side of allSides) {
			const snapshotSets = this.getStoredSets(targetGlobalId, targetTurn, side);
			const snapshotDisplays = this.getStoredSnapshots(targetGlobalId, targetTurn, side);

			if (transferringSides.has(side)) {
				const transferredState = capturedStates.get(side)!;
				const result = this.manager.replaceTeamFromSnapshot(
					sourceBattleId, side,
					snapshotSets || [], snapshotDisplays || [],
					transferredState,
					false // defer switchIn
				);
				if (!result.success) {
					throw new Error(`replaceTeamFromSnapshot failed for ${side}: ${result.error}`);
				}
				if (!result.pokemon) {
					throw new Error(`replaceTeamFromSnapshot did not return pokemon for ${side}`);
				}
				deferredSwitchIns.set(side, result.pokemon);
			} else {
				if (snapshotSets && snapshotSets.length > 0) {
					this.manager.restoreTeamFromSnapshot(
						sourceBattleId, side, snapshotSets, snapshotDisplays || []
					);
				}
			}
		}

		// ── Step 7: Reset battle engine state ──
		// The battle just finished resolving a turn and still has stale
		// midTurn/queue/request state. switchIn and makeRequest both expect
		// clean state — running switchIn on a battle whose queue still has
		// residual actions from the previous turn corrupts side references.
		this.resetBattleForBranch(sourceBattle);

		// ── Step 8: switchIn for transferred Pokemon ──
		// Runs on a clean battle: no stale queue entries, no stale request.
		// Entry hazards, Intimidate, weather abilities all fire correctly
		// because side conditions and field were restored in steps 4-5.
		for (const [side, pokemon] of deferredSwitchIns) {
			console.log(`[TIMELINE DEBUG] Deferred switchIn: ${pokemon.name} into ${side}`);
			sourceBattle.actions.switchIn(pokemon, 0);
			if (!sourceBattle[side].active[0] || sourceBattle[side].active[0].fainted) {
				throw new Error(
					`switchIn failed for ${pokemon.name} on ${side} — active slot is empty or fainted`
				);
			}
		}

		// ── Step 9: Reconnect sources ──
		this.manager.reconnectConditionSources(sourceBattleId, targetField, sideCondsBySide);

		// ── Step 10: Slot conditions ──
		for (const side of allSides) {
			const slotConds = this.getStoredSlotConditions(targetGlobalId, targetTurn, side);
			if (slotConds && Object.keys(slotConds).length > 0) {
				this.manager.restoreSlotConditions(sourceBattleId, side, slotConds);
			}
		}

		// ── Step 11: Register the branch timeline ──
		const branchGlobalId = this.registerBranch(sourceBattleId, targetGlobalId, targetTurn);
		const branchNum = this.timelineRegistry.get(branchGlobalId)!.num;

		// Snapshot the branch's initial state
		this.captureSnapshot(branchGlobalId, sourceBattle);

		// Announce
		const sideList = [...transferringSides].join(' and ');
		const coord = `Timeline ${targetGlobalId}, Turn ${targetTurn}`;
		this.pushMessage('update',
			`|-message|${sideList}'s Pokémon transferred to ${coord}! Branch #${branchNum} created at turn ${targetTurn + 1}.`
		);
	}

	/** Output handler for branch battles (mirrors handleBattleOutput). */
	private handleBattleOutputForBranch(
		battleId: string,
		type: string,
		data: string | string[]
	) {
		if (Array.isArray(data)) data = data.join('\n');
		this.pushMessage(type, data);
	}

	/**
	 * Resets transient battle-engine state so that switchIn and makeRequest
	 * operate on a clean slate.
	 *
	 * After surgical team/field restoration the battle still carries stale
	 * state from the turn that just resolved: midTurn is true, the action
	 * queue has residual entries, requestState points at the old request,
	 * and activeMove/activePokemon may reference Pokemon that no longer
	 * exist in the rebuilt roster. Running switchIn or makeRequest against
	 * this stale state causes null-reference crashes in side.clearChoice
	 * and toRef.
	 *
	 * This method zeroes out exactly the fields that need to be clean for
	 * switchIn → makeRequest to succeed. It does NOT touch field state,
	 * side conditions, or team rosters — those are the caller's
	 * responsibility.
	 */
	private resetBattleForBranch(battle: any): void {
		console.log(`[TIMELINE DEBUG] resetBattleForBranch: clearing engine state`);

		// ── Turn resolution state ──
		battle.midTurn = false;
		battle.activeMove = null;
		battle.activePokemon = null;
		battle.activeTarget = null;

		// ── Request state ──
		// makeRequest sets this itself, but a stale value can cause it
		// to take the wrong code path before it gets there.
		battle.requestState = '';

		// ── Action queue ──
		// Residual queue entries (end-of-turn weather, status damage, etc.)
		// reference Pokemon from the old roster. They must not execute.
		if (battle.queue?.list) {
			battle.queue.list = [];
		}

		// ── Move tracking ──
		// These reference the old roster's move objects / Pokemon.
		battle.lastMove = null;
		battle.lastSuccessfulMoveThisTurn = null;
		battle.lastMoveLine = 0;

		// ── Per-side state ──
		for (const side of battle.sides) {
			if (!side) continue;

			// Clear stale request — makeRequest will generate a fresh one
			side.activeRequest = null;

			// Clear choice state so makeRequest starts clean
			side.clearChoice();
		}

		console.log(`[TIMELINE DEBUG] resetBattleForBranch: done`);
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
	 * Post-transfer cleanup: issues a move request, flushes battle
	 * updates, and emits the timeline visualization.
	 *
	 * Errors propagate to the caller — if makeRequest or sendUpdates
	 * fails, the battle crashes rather than continuing with invalid state.
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

		// Validate battle state before issuing request
		for (const side of battle.sides) {
			if (!side) {
				throw new Error(`finalizeAfterTransfers: null side in battle.sides`);
			}
			if (!side.active[0] && side.pokemonLeft > 0) {
				throw new Error(
					`finalizeAfterTransfers: ${side.id} has ${side.pokemonLeft} Pokemon left but empty active slot`
				);
			}
		}

		// Reset engine state to ensure makeRequest operates cleanly
		this.resetBattleForBranch(battle);

		console.log(`[TIMELINE DEBUG] Issuing move request after transfers`);
		battle.makeRequest('move');
		battle.sendUpdates();

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
		if (globalId === this.battle?.currentTimelineId) {
			const entry = this.timelineRegistry.get(globalId);
			const b = entry ? this.manager.getBattle(entry.battleId) : null;
			if (b) return b.turn;
		}
		// Snapshot keys are now completed turns; add 1 to get the playing turn
		const history = this.turnSnapshots.get(globalId);
		if (history && history.size > 0) {
			let max = 0;
			for (const t of history.keys()) if (t > max) max = t;
			return max + 1;
		}
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
	 * Switch the active Battle to the present timeline, restoring field,
	 * side conditions, teams, and slot conditions from that timeline's
	 * snapshot. Returns true if a switch happened.
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

		// Snapshot outgoing timeline
		const outgoingId = this.battle.currentTimelineId;
		const outEntry = this.timelineRegistry.get(outgoingId);
		const outBattle = outEntry ? this.manager.getBattle(outEntry.battleId) : null;
		if (outBattle) this.captureSnapshot(outgoingId, outBattle);

		const allSides: BattleSideID[] = battle.sides
			.filter((s: any) => s)
			.map((s: any) => s.id as BattleSideID);

		// ── Field ──
		const presentField = this.getStoredField(presentId, presentTurn);
		this.manager.restoreField(entry.battleId, presentField);

		// ── Side conditions ──
		const sideCondsBySide: Partial<Record<BattleSideID, SideConditionSnapshot[] | null>> = {};
		for (const side of allSides) {
			const conds = this.getStoredSideConditions(presentId, presentTurn, side);
			sideCondsBySide[side] = conds;
			this.manager.restoreSideConditions(entry.battleId, side, conds);
		}

		// ── Teams (direct placement, no switchIn) ──
		for (const side of allSides) {
			const sets = this.getStoredSets(presentId, presentTurn, side);
			const displays = this.getStoredSnapshots(presentId, presentTurn, side);
			if (sets?.length && displays?.length) {
				this.manager.restoreTeamFromSnapshot(entry.battleId, side, sets, displays);
			}
		}

		// ── Reconnect ──
		this.manager.reconnectConditionSources(entry.battleId, presentField, sideCondsBySide);

		// ── Slot conditions ──
		for (const side of allSides) {
			const slotConds = this.getStoredSlotConditions(presentId, presentTurn, side);
			if (slotConds && Object.keys(slotConds).length > 0) {
				this.manager.restoreSlotConditions(entry.battleId, side, slotConds);
			}
		}

		// ── Reset engine state ──
		this.resetBattleForBranch(battle);

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
					const newHistory = new Map<number, TurnSnapshotEntry>();
					for (const [t, snap] of parentHistory) {
						if (t <= turn) {
							newHistory.set(t, deepCloneTurnSnapshot(snap));
						}
					}
					this.turnSnapshots.set(newTimeline.globalId, newHistory);
					console.log(`[Timeline Snapshot] Branch inherited ${newHistory.size} snapshots from parent (turns <= ${turn})`);
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
		const emptyField: FieldSnapshot = { weather: null, terrain: null, pseudoWeather: [] };

		for (const [globalId, entry] of this.timelineRegistry) {
			const battle = this.manager.getBattle(entry.battleId);
			const history = this.turnSnapshots.get(globalId);
			const ended = battle?.ended ?? false;
			const parentGlobalId = entry.parentNum ? this.findGlobalIdByNum(entry.parentNum) : null;

			if (!history || history.size === 0) {
				allNodes.push({
					timelineId: globalId,
					timelineNum: entry.num,
					turn: battle?.turn ?? 0,
					parentTimelineId: parentGlobalId,
					branchTurn: entry.fromTurn,
					isCurrent: computedCurrentId === globalId,
					ended,
					p1Team: [], p2Team: [],
					p1SideConditions: [], p2SideConditions: [],
					field: emptyField,
				});
				continue;
			}

			let maxTurn = 0;
			for (const t of history.keys()) if (t > maxTurn) maxTurn = t;

			for (const [turn, snap] of history) {
				const node: TimelineNodeData = {
					timelineId: globalId,
					timelineNum: entry.num,
					turn,
					parentTimelineId: parentGlobalId,
					branchTurn: entry.fromTurn,
					isCurrent: computedCurrentId === globalId && turn === maxTurn,
					ended,
					// p1/p2 always present; fall back to empty for robustness
					p1Team: (snap.sides.p1?.team ?? []).map(toClientSnapshot),
					p2Team: (snap.sides.p2?.team ?? []).map(toClientSnapshot),
					p1SideConditions: snap.sides.p1?.sideConditions ?? [],
					p2SideConditions: snap.sides.p2?.sideConditions ?? [],
					field: snap.field,
				};
				// Only attach p3/p4 if the snapshot has them — keeps 2-player
				// payloads small and lets clients use `'p3Team' in node` to
				// detect FFA.
				if (snap.sides.p3) {
					node.p3Team = snap.sides.p3.team.map(toClientSnapshot);
					node.p3SideConditions = snap.sides.p3.sideConditions;
				}
				if (snap.sides.p4) {
					node.p4Team = snap.sides.p4.team.map(toClientSnapshot);
					node.p4SideConditions = snap.sides.p4.sideConditions;
				}
				allNodes.push(node);
			}
		}

		return { nodes: allNodes };
	}

	private findGlobalIdByNum(num: number): string | null {
		for (const [globalId, entry] of this.timelineRegistry) {
			if (entry.num === num) return globalId;
		}
		return null;
	}

	/**
	 * Shared closest-turn lookup for all getStored* methods.
	 * Returns the snapshot entry at the nearest turn <= requested, or null.
	 */
	private lookupSnapshot(timelineId: string, turn: number): TurnSnapshotEntry | null {
		const history = this.turnSnapshots.get(timelineId);
		if (!history) return null;

		let closestTurn = -1;
		for (const t of history.keys()) {
			if (t <= turn && t > closestTurn) closestTurn = t;
		}
		if (closestTurn === -1) return null;

		return history.get(closestTurn)!;
	}

	getStoredSets(timelineId: string, turn: number, side: BattleSideID): PokemonSet[] | null {
		const snap = this.lookupSnapshot(timelineId, turn);
		const sets = snap?.sides[side]?.sets ?? null;
		console.log(`[Timeline Team] getStoredSets("${timelineId}", turn=${turn}, side=${side}) -> ${sets?.length ?? 0} sets`);
		return sets;
	}

	getStoredSnapshots(timelineId: string, turn: number, side: BattleSideID): PokemonSnapshot[] | null {
		const snap = this.lookupSnapshot(timelineId, turn);
		return snap?.sides[side]?.team ?? null;
	}

	getStoredSideConditions(timelineId: string, turn: number, side: BattleSideID): SideConditionSnapshot[] | null {
		const snap = this.lookupSnapshot(timelineId, turn);
		const conds = snap?.sides[side]?.sideConditions ?? null;
		console.log(`[Timeline Side] getStoredSideConditions("${timelineId}", turn=${turn}, side=${side}) -> ${conds?.length ?? 0} conditions`);
		return conds;
	}

	getStoredSlotConditions(
		timelineId: string, turn: number, side: BattleSideID
	): { [slot: number]: SlotConditionSnapshot[] } | null {
		const snap = this.lookupSnapshot(timelineId, turn);
		return snap?.sides[side]?.slotConditions ?? null;
	}

	getStoredField(timelineId: string, turn: number): FieldSnapshot | null {
		const snap = this.lookupSnapshot(timelineId, turn);
		if (!snap) return null;
		console.log(`[Timeline Field] getStoredField("${timelineId}", turn=${turn}) -> weather=${snap.field.weather?.id || 'none'}`);
		return snap.field;
	}
}