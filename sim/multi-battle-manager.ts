/**
 * Multi-Battle Manager
 *
 * A system for running multiple Pokemon battles that can affect each other.
 * Built on top of the Pokemon Showdown battle simulator.
 *
 * Key feature: Transfer Pokemon between battles while preserving their state.
 */

import { Battle } from './battle';
import { Dex } from './dex';
import { Teams, PokemonSet } from './teams';
import { PRNG, PRNGSeed } from './prng';
import { Pokemon, EffectState } from './pokemon';
import { Side } from './side';

// Re-export PokemonSet for convenience
export { PokemonSet };

// Types for battle options
export interface MultiBattleOptions {
	formatid?: string;
	seed?: PRNGSeed;
	p1?: PlayerOptions;
	p2?: PlayerOptions;
	debug?: boolean;
}

export interface PlayerOptions {
	name: string;
	team?: string | PokemonSet[];
	avatar?: string;
}

// Move slot state for transfer (matches MoveSlot from pokemon.ts)
interface MoveSlotState {
	id: string;
	move: string;
	pp: number;
	maxpp: number;
	target?: string;
	disabled: boolean | 'hidden';
	disabledSource?: string;
	used: boolean;
}

// Snapshot of a Pokemon's current state for transfer
export interface PokemonTransferState {
	// The original set (for recreating the Pokemon)
	set: PokemonSet;

	// Current battle state
	hp: number;
	maxhp: number;
	status: string;
	statusState: EffectState;

	// Stat boosts
	boosts: {
		atk: number;
		def: number;
		spa: number;
		spd: number;
		spe: number;
		accuracy: number;
		evasion: number;
	};

	// Volatile conditions
	volatiles: { [id: string]: EffectState };

	// Move PP and state
	moveSlots: MoveSlotState[];

	// Ability and item state
	ability: string;
	abilityState: EffectState;
	item: string;
	itemState: EffectState;
	lastItem: string;

	// Tracking stats
	timesAttacked: number;
	lastDamage: number;

	// Species info (in case of forme changes)
	species: string;

	// Types (in case of type changes)
	types: string[];
	addedType: string;

	// Transform state
	transformed: boolean;
}

/**
 * Snapshot of a single field-level condition (weather, terrain, or a
 * pseudo-weather entry like Trick Room).
 */
export interface FieldConditionSnapshot {
	id: string;
	turnsLeft?: number;
	source?: string;      // Pokemon name, not a reference
	sourceSlot?: string;  // e.g. "p1a"
	/**
	 * Condition-specific EffectState fields beyond the standard set.
	 * Most field conditions don't need this, but it keeps the schema
	 * uniform with side/slot conditions. Captured as JSON-safe values;
	 * game-object references are stripped at capture time.
	 */
	extraData?: { [key: string]: any };
}

/**
 * Snapshot of the entire battle field.
 */
export interface FieldSnapshot {
	weather: FieldConditionSnapshot | null;
	terrain: FieldConditionSnapshot | null;
	pseudoWeather: FieldConditionSnapshot[];
}

/**
 * Snapshot of a side condition (Stealth Rock, Reflect, Spikes, etc.).
 */
export interface SideConditionSnapshot {
	id: string;
	turnsLeft?: number;
	layers?: number;      // For stackable conditions (Spikes, Toxic Spikes)
	source?: string;      // Pokemon name
	sourceSlot?: string;
	/** See FieldConditionSnapshot.extraData. */
	extraData?: { [key: string]: any };
}

/**
 * Snapshot of a slot condition (Wish, Healing Wish, Future Sight, etc.).
 */
export interface SlotConditionSnapshot {
	id: string;
	turnsLeft?: number;
	source?: string;
	sourceSlot?: string;
	/**
	 * See FieldConditionSnapshot.extraData. Slot conditions are the main
	 * reason this field exists — Future Sight stores `move`/`moveData`,
	 * Wish stores `hp`, and those MUST survive restoration or the
	 * condition resolves into nothing when its countdown hits zero.
	 */
	extraData?: { [key: string]: any };
}


export interface BattleSnapshot {
	battleId: string;
	turn: number;
	ended: boolean;
	winner: string | undefined;
	p1: SideSnapshot;
	p2: SideSnapshot;
	field: FieldSnapshot;
}

export interface SideSnapshot {
	name: string;
	pokemonLeft: number;
	active: PokemonSnapshot[];
	team: PokemonSnapshot[];
	sideConditions: SideConditionSnapshot[];
	slotConditions: { [slot: number]: SlotConditionSnapshot[] };
}

/**
 * Snapshot of a volatile condition on an active Pokemon (Substitute,
 * Encore, Taunt, Leech Seed, Confusion, etc.).
 *
 * Same shape as the other condition snapshots so the same capture and
 * restore machinery can handle all of them. extraData is load-bearing
 * here: Substitute stores `hp`, Encore and Disable store `move`,
 * Stockpile stores `layers`, Confusion stores `time`. Without it the
 * volatile exists on the engine side but its mechanics resolve wrong.
 */
export interface VolatileSnapshot {
	id: string;
	turnsLeft?: number;
	source?: string;      // Pokemon name, for findPokemonByName reconnection
	sourceSlot?: string;
	/** See FieldConditionSnapshot.extraData. */
	extraData?: { [key: string]: any };
}

/**
 * Full Pokemon snapshot - stored internally for state restoration.
 * Contains all data needed to restore a Pokemon's state.
 */
export interface PokemonSnapshot {
	name: string;
	species: string;
	hp: number;           // Stored as percentage (0-100)
	maxhp: number;        // Actual max HP value
	status: string;
	fainted: boolean;
	isActive: boolean;
	boosts: { [stat: string]: number };
	item: string;
	ability: string;
	moves: string[];
	position: number;
	/**
	 * Full volatile EffectState data, not just IDs. The old string[]
	 * shape lost Substitute HP, Encore move, Taunt duration, etc.
	 */
	volatiles: VolatileSnapshot[];
}

/**
 * Minimal Pokemon snapshot - sent to client for UI display.
 * Reduces bandwidth by omitting fields not needed for visualization.
 */
export interface PokemonSnapshotClient {
	name: string;
	species: string;      // For sprite lookup
	hp: number;           // Percentage
	status?: string;      // Only included if not empty
	fainted: boolean;
	isActive: boolean;
}

/**
 * Converts a full PokemonSnapshot to the minimal client format
 */
export function toClientSnapshot(snap: PokemonSnapshot): PokemonSnapshotClient {
	const client: PokemonSnapshotClient = {
		name: snap.name,
		species: snap.species,
		hp: snap.hp,
		fainted: snap.fainted,
		isActive: snap.isActive,
	};
	// Only include status if present to save bytes
	if (snap.status) {
		client.status = snap.status;
	}
	return client;
}

export interface TransferResult {
	success: boolean;
	error?: string;
	transferredPokemon?: PokemonTransferState;
}

/**
 * Ensures a PokemonSet has all required fields with proper defaults
 */
function ensureCompletePokemonSet(partialSet: Partial<PokemonSet>): PokemonSet {
	const set: PokemonSet = {
		name: partialSet.name || partialSet.species || '',
		species: partialSet.species || partialSet.name || '',
		item: partialSet.item || '',
		ability: partialSet.ability || '',
		moves: partialSet.moves || [],
		nature: partialSet.nature || '',
		gender: partialSet.gender || '',
		evs: partialSet.evs || { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
		ivs: partialSet.ivs || { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
		level: partialSet.level || 100,
	};

	// Ensure EVs have all stats
	if (!set.evs.hp && set.evs.hp !== 0) set.evs.hp = 0;
	if (!set.evs.atk && set.evs.atk !== 0) set.evs.atk = 0;
	if (!set.evs.def && set.evs.def !== 0) set.evs.def = 0;
	if (!set.evs.spa && set.evs.spa !== 0) set.evs.spa = 0;
	if (!set.evs.spd && set.evs.spd !== 0) set.evs.spd = 0;
	if (!set.evs.spe && set.evs.spe !== 0) set.evs.spe = 0;

	// Ensure IVs have all stats
	if (!set.ivs.hp && set.ivs.hp !== 0) set.ivs.hp = 31;
	if (!set.ivs.atk && set.ivs.atk !== 0) set.ivs.atk = 31;
	if (!set.ivs.def && set.ivs.def !== 0) set.ivs.def = 31;
	if (!set.ivs.spa && set.ivs.spa !== 0) set.ivs.spa = 31;
	if (!set.ivs.spd && set.ivs.spd !== 0) set.ivs.spd = 31;
	if (!set.ivs.spe && set.ivs.spe !== 0) set.ivs.spe = 31;

	// Copy optional fields
	if (partialSet.shiny !== undefined) set.shiny = partialSet.shiny;
	if (partialSet.happiness !== undefined) set.happiness = partialSet.happiness;
	if (partialSet.pokeball !== undefined) set.pokeball = partialSet.pokeball;
	if (partialSet.hpType !== undefined) set.hpType = partialSet.hpType;
	if (partialSet.dynamaxLevel !== undefined) set.dynamaxLevel = partialSet.dynamaxLevel;
	if (partialSet.gigantamax !== undefined) set.gigantamax = partialSet.gigantamax;
	if (partialSet.teraType !== undefined) set.teraType = partialSet.teraType;

	return set;
}

/**
 * Manages multiple Pokemon battles and allows Pokemon transfers between them
 */
export class MultiBattleManager {
	battles: Map<string, Battle>;
	battleLogs: Map<string, string[]>;
	battleLinks: Map<string, string[]>;

	constructor() {
		this.battles = new Map();
		this.battleLogs = new Map();
		this.battleLinks = new Map();
		console.log(`[Timeline Team] MultiBattleManager initialized`);
	}

	/**
	 * Creates a new battle and adds it to the manager
	 */
	createBattle(battleId: string, options: MultiBattleOptions): Battle {
		console.log(`[Timeline Team] createBattle called with battleId: "${battleId}"`);
		console.log(`[Timeline Team] createBattle options:`, JSON.stringify({
			formatid: options.formatid,
			hasP1: !!options.p1,
			hasP2: !!options.p2,
			p1Name: options.p1?.name,
			p2Name: options.p2?.name,
			p1TeamType: options.p1?.team ? (typeof options.p1.team === 'string' ? 'packed' : 'array') : 'none',
			p2TeamType: options.p2?.team ? (typeof options.p2.team === 'string' ? 'packed' : 'array') : 'none',
		}));

		if (this.battles.has(battleId)) {
			throw new Error(`Battle with id "${battleId}" already exists`);
		}

		const formatid = options.formatid || 'gen9randombattle';
		const format = Dex.formats.get(formatid);

		const battleOptions: any = {
			formatid: formatid as any,
			format: format,
			seed: options.seed,
			debug: options.debug,
			send: (type: string, data: string | string[]) => {
				this.handleBattleOutput(battleId, type, data);
			},
		};

		const battle = new Battle(battleOptions);
		this.battles.set(battleId, battle);
		this.battleLogs.set(battleId, []);
		this.battleLinks.set(battleId, []);

		console.log(`[Timeline Team] Battle "${battleId}" created and stored. Total battles: ${this.battles.size}`);

		// Set up players if provided
		if (options.p1) {
			console.log(`[Timeline Team] Setting up p1 from createBattle options`);
			this.setPlayer(battleId, 'p1', options.p1);
		}
		if (options.p2) {
			console.log(`[Timeline Team] Setting up p2 from createBattle options`);
			this.setPlayer(battleId, 'p2', options.p2);
		}

		return battle;
	}

	/**
	 * Sets a player for a battle
	 */
	setPlayer(battleId: string, slot: 'p1' | 'p2' | 'p3' | 'p4', options: PlayerOptions): void {
		console.log(`[Timeline Team] setPlayer called - battleId: "${battleId}", slot: "${slot}", name: "${options.name}"`);

		const battle = this.getBattle(battleId);
		if (!battle) {
			throw new Error(`Battle "${battleId}" not found`);
		}

		let team = options.team;
		let teamInfo = 'none';

		if (typeof team === 'object' && Array.isArray(team)) {
			console.log(`[Timeline Team] setPlayer received array team with ${team.length} Pokemon:`);
			team.forEach((set, i) => {
				console.log(`[Timeline Team]   [${i}] ${set.name || set.species} - ${set.moves?.join(', ') || 'no moves'}`);
			});

			// Ensure all sets are complete before packing
			team = team.map(set => ensureCompletePokemonSet(set));
			const packedTeam = Teams.pack(team);
			console.log(`[Timeline Team] Packed team string (first 200 chars): "${packedTeam?.substring(0, 200)}..."`);
			team = packedTeam;
			teamInfo = `array(${options.team?.length || 0})`;
		} else if (typeof team === 'string') {
			console.log(`[Timeline Team] setPlayer received packed team string (first 200 chars): "${team.substring(0, 200)}..."`);
			teamInfo = `packed(length=${team.length})`;
		} else {
			console.log(`[Timeline Team] setPlayer received no team (will use random or format default)`);
		}

		console.log(`[Timeline Team] Calling battle.setPlayer for ${slot} with team type: ${teamInfo}`);

		battle.setPlayer(slot, {
			name: options.name,
			team: team as string | undefined,
			avatar: options.avatar,
		});

		// Log the resulting team in the battle
		const side = battle[slot];
		if (side && side.pokemon) {
			console.log(`[Timeline Team] After setPlayer, ${slot} has ${side.pokemon.length} Pokemon in battle:`);
			side.pokemon.forEach((pokemon: Pokemon, i: number) => {
				console.log(`[Timeline Team]   [${i}] ${pokemon.name} (${pokemon.species.name}) - HP: ${pokemon.hp}/${pokemon.maxhp}, Moves: ${pokemon.moveSlots.map((m: any) => m.id).join(', ')}`);
			});
		} else {
			console.log(`[Timeline Team] After setPlayer, ${slot} side not yet populated or no pokemon array`);
		}
	}

	/**
	 * Gets a battle by ID
	 */
	getBattle(battleId: string): Battle | undefined {
		const battle = this.battles.get(battleId);
		return battle;
	}

	/**
	 * Gets all battle IDs
	 */
	getBattleIds(): string[] {
		const ids = Array.from(this.battles.keys());
		console.log(`[Timeline Team] getBattleIds() -> [${ids.join(', ')}]`);
		return ids;
	}

	/**
	 * Links two battles (for organizational purposes)
	 */
	linkBattles(battleId1: string, battleId2: string, bidirectional: boolean = true): void {
		console.log(`[Timeline Team] linkBattles("${battleId1}", "${battleId2}", bidirectional=${bidirectional})`);

		const links1 = this.battleLinks.get(battleId1) || [];
		if (!links1.includes(battleId2)) {
			links1.push(battleId2);
			this.battleLinks.set(battleId1, links1);
		}

		if (bidirectional) {
			const links2 = this.battleLinks.get(battleId2) || [];
			if (!links2.includes(battleId1)) {
				links2.push(battleId1);
				this.battleLinks.set(battleId2, links2);
			}
		}

		console.log(`[Timeline Team] After linking - ${battleId1} links: [${this.battleLinks.get(battleId1)?.join(', ')}]`);
		console.log(`[Timeline Team] After linking - ${battleId2} links: [${this.battleLinks.get(battleId2)?.join(', ')}]`);
	}

	/**
	 * Gets battles linked to a specific battle
	 */
	getLinkedBattles(battleId: string): Battle[] {
		const linkedIds = this.battleLinks.get(battleId) || [];
		console.log(`[Timeline Team] getLinkedBattles("${battleId}") -> linkedIds: [${linkedIds.join(', ')}]`);
		return linkedIds
			.map(id => this.getBattle(id))
			.filter((b): b is Battle => b !== undefined);
	}

	/**
	 * Removes the active Pokémon from a side after its state has already been
	 * captured for transfer. Completely removes it from the team roster
	 * rather than marking it as fainted.
	 */
	removePokemonAfterCapture(battleId: string, side: 'p1' | 'p2', position: number = 0): boolean {
		const battle = this.getBattle(battleId);
		if (!battle) return false;
		const battleSide = battle[side];
		if (!battleSide) return false;

		const pokemon = battleSide.active[position];
		if (!pokemon || pokemon.fainted) return false;

		// Clear the active slot first
		pokemon.isActive = false;
		battleSide.active[position] = null as any;

		// Find and remove from the team roster entirely
		const teamIndex = battleSide.pokemon.indexOf(pokemon);
		if (teamIndex !== -1) {
			battleSide.pokemon.splice(teamIndex, 1);

			// Reindex positions for remaining Pokémon so the battle engine
			// doesn't reference stale slot numbers
			for (let i = 0; i < battleSide.pokemon.length; i++) {
				battleSide.pokemon[i].position = i;
			}
		}

		// Also remove from the packed team array if it exists,
		// so team preview / switch menus stay consistent
		if (battleSide.team && teamIndex !== -1) {
			battleSide.team.splice(teamIndex, 1);
		}

		// Decrement pokemonLeft — this Pokémon is gone, not fainted
		battleSide.pokemonLeft = Math.max(0, battleSide.pokemonLeft - 1);

		console.log(
			`[Timeline Team] removePokemonAfterCapture: ${pokemon.name} fully removed from ${side}, ` +
			`team size=${battleSide.pokemon.length}, pokemonLeft=${battleSide.pokemonLeft}`
		);
		return true;
	}

	/**
	 * Handles output from a battle
	 */
	private handleBattleOutput(battleId: string, type: string, data: string | string[]): void {
		const logs = this.battleLogs.get(battleId) || [];
		if (Array.isArray(data)) {
			logs.push(...data);
		} else {
			logs.push(data);
		}
		this.battleLogs.set(battleId, logs);

		// Log team-related messages
		const dataStr = Array.isArray(data) ? data.join('\n') : data;
		if (dataStr.includes('|switch|') || dataStr.includes('|drag|') || dataStr.includes('|poke|') || dataStr.includes('|teampreview|')) {
			console.log(`[Timeline Team] Battle output (${battleId}) - ${type}: ${dataStr.substring(0, 300)}${dataStr.length > 300 ? '...' : ''}`);
		}
	}

	/**
	 * Makes a choice for a player in a battle
	 */
	choose(battleId: string, side: 'p1' | 'p2' | 'p3' | 'p4', choice: string): boolean {
		console.log(`[Timeline Team] choose("${battleId}", "${side}", "${choice}")`);
		const battle = this.getBattle(battleId);
		if (!battle) {
			throw new Error(`Battle "${battleId}" not found`);
		}
		const result = battle.choose(side, choice);
		return result;
	}

	/**
	 * Makes choices for both players (convenience method)
	 */
	makeChoices(battleId: string, p1Choice: string, p2Choice: string): void {
		console.log(`[Timeline Team] makeChoices("${battleId}", "${p1Choice}", "${p2Choice}")`);
		const battle = this.getBattle(battleId);
		if (!battle) {
			throw new Error(`Battle "${battleId}" not found`);
		}
		battle.makeChoices(p1Choice, p2Choice);
	}

	/**
	 * Captures the complete current state of a Pokemon for transfer
	 */
	capturePokemonState(pokemon: Pokemon): PokemonTransferState {
		console.log(`[Timeline Team] capturePokemonState for ${pokemon.name} (${pokemon.species.name})`);
		console.log(`[Timeline Team]   HP: ${pokemon.hp}/${pokemon.maxhp}, Status: ${pokemon.status || 'none'}`);
		console.log(`[Timeline Team]   Moves: ${pokemon.moveSlots.map((m: any) => `${m.id}(${m.pp}/${m.maxpp})`).join(', ')}`);
		console.log(`[Timeline Team]   Item: ${pokemon.item || 'none'}, Ability: ${pokemon.ability}`);
		console.log(`[Timeline Team]   Boosts: ${JSON.stringify(pokemon.boosts)}`);
		console.log(`[Timeline Team]   Volatiles: [${Object.keys(pokemon.volatiles).join(', ')}]`);

		// Deep copy volatiles
		const volatiles: { [id: string]: EffectState } = {};
		for (const id in pokemon.volatiles) {
			volatiles[id] = { ...pokemon.volatiles[id] };
		}

		// Capture move slots with their current state
		const moveSlots: MoveSlotState[] = pokemon.moveSlots.map(slot => ({
			id: slot.id,
			move: slot.move,
			pp: slot.pp,
			maxpp: slot.maxpp,
			target: slot.target,
			disabled: slot.disabled,
			disabledSource: slot.disabledSource,
			used: slot.used,
		}));

		const state: PokemonTransferState = {
			set: { ...pokemon.set },

			hp: pokemon.hp,
			maxhp: pokemon.maxhp,
			status: pokemon.status,
			statusState: { ...pokemon.statusState },

			boosts: { ...pokemon.boosts },
			volatiles: volatiles,
			moveSlots: moveSlots,

			ability: pokemon.ability,
			abilityState: { ...pokemon.abilityState },
			item: pokemon.item,
			itemState: { ...pokemon.itemState },
			lastItem: pokemon.lastItem,

			timesAttacked: pokemon.timesAttacked,
			lastDamage: pokemon.lastDamage,

			species: pokemon.species.id,
			types: [...pokemon.types],
			addedType: pokemon.addedType,
			transformed: pokemon.transformed,
		};

		console.log(`[Timeline Team] Captured PokemonTransferState - set.species: ${state.set.species}, set.moves: [${state.set.moves?.join(', ')}]`);
		return state;
	}

	/**
	 * Sets a Pokemon's status WITHOUT triggering events or protocol emission.
	 *
	 * Status restoration must bypass pokemon.setStatus() because setStatus()
	 * emits `|-status|` protocol lines. If that reaches the client before the
	 * corresponding `|switch|` line, the client's active slot is still null
	 * and it crashes trying to set `.status` on null.
	 *
	 * The status reaches the client embedded in the |switch| line's
	 * condition string (e.g. "100/100 brn").
	 */
	private setStatusSilently(pokemon: Pokemon, status: string, battle: Battle, statusState?: EffectState): void {
		if (!status || status === '') {
			console.log(`[Timeline Status] setStatusSilently: empty status for ${pokemon.name}, skipping`);
			return;
		}

		const prevStatus = pokemon.status;
		console.log(`[Timeline Status] setStatusSilently: ${pokemon.name} ${prevStatus || 'none'} -> ${status}`);

		pokemon.status = status as any;

		if (statusState) {
			// Retarget to this Pokemon; drop cross-battle Pokemon references
			const cleanState: EffectState = { id: status as any, target: pokemon, effectOrder: 0 };
			for (const key in statusState) {
				if (key === 'target' || key === 'source') continue;
				cleanState[key] = statusState[key];
			}
			pokemon.statusState = cleanState;
			console.log(`[Timeline Status]   Restored statusState keys: [${Object.keys(cleanState).join(', ')}]`);
		} else {
			pokemon.statusState = battle.initEffectState({ id: status as any, target: pokemon });
			console.log(`[Timeline Status]   Initialized fresh statusState for ${status}`);
		}
	}

	/**
	 * Applies a captured state to a Pokemon after it's been created
	 */
	private applyPokemonState(pokemon: Pokemon, state: PokemonTransferState, battle: Battle): void {
		console.log(`[Timeline Team] applyPokemonState to ${pokemon.name}`);
		console.log(`[Timeline Team]   Incoming state - HP: ${state.hp}/${state.maxhp}, Status: ${state.status || 'none'}`);
		console.log(`[Timeline Team]   Incoming moveSlots: ${state.moveSlots.map(m => `${m.id}(${m.pp}/${m.maxpp})`).join(', ')}`);

		// Apply HP (capped at maxhp)
		pokemon.hp = Math.min(state.hp, pokemon.maxhp);
		console.log(`[Timeline Team]   Applied HP: ${pokemon.hp}/${pokemon.maxhp}`);

		// Silent status assignment: no events, no protocol until |switch|
		if (state.status && state.status !== '') {
			this.setStatusSilently(pokemon, state.status, battle, state.statusState);
		}

		// Apply boosts
		pokemon.boosts = { ...state.boosts };
		console.log(`[Timeline Team]   Applied boosts: ${JSON.stringify(pokemon.boosts)}`);

		// Apply volatiles (skip battle-specific ones that won't transfer well)
		const skipVolatiles = new Set([
			'mustrecharge', 'lockedmove', 'twoturnmove', 'choicelock',
			'flinch', 'destinybond', 'grudge', 'endure',
			'stall', 'gem', 'roost', 'protect', 'quickguard', 'wideguard'
		]);

		const appliedVolatiles: string[] = [];
		for (const id in state.volatiles) {
			if (skipVolatiles.has(id)) continue;
			pokemon.volatiles[id] = { ...state.volatiles[id] };
			// Update target reference
			pokemon.volatiles[id].target = pokemon;
			appliedVolatiles.push(id);
		}
		console.log(`[Timeline Team]   Applied volatiles: [${appliedVolatiles.join(', ')}]`);

		// Apply move PP - match by move id
		for (const stateSlot of state.moveSlots) {
			for (const pokemonSlot of pokemon.moveSlots) {
				if (pokemonSlot.id === stateSlot.id) {
					const oldPP = pokemonSlot.pp;
					pokemonSlot.pp = stateSlot.pp;
					pokemonSlot.used = stateSlot.used;
					console.log(`[Timeline Team]   Applied PP for ${stateSlot.id}: ${oldPP} -> ${pokemonSlot.pp}`);
					break;
				}
			}
		}

		// Apply tracking stats
		pokemon.timesAttacked = state.timesAttacked;
		pokemon.lastDamage = state.lastDamage;

		// Apply type changes if any
		if (state.addedType) {
			pokemon.addedType = state.addedType;
			console.log(`[Timeline Team]   Applied addedType: ${state.addedType}`);
		}

		console.log(`[Timeline Team]   Final Pokemon state - HP: ${pokemon.hp}/${pokemon.maxhp}, Status: ${pokemon.status || 'none'}, Moves: ${pokemon.moveSlots.map((m: any) => `${m.id}(${m.pp}/${m.maxpp})`).join(', ')}`);
	}

	/**
	 * Searches all sides of a battle for a Pokemon by name.
	 * Used to reconnect `source` references on restored EffectStates.
	 * Returns null if not found (common when called before team rebuild).
	 */
	private findPokemonByName(battle: Battle, name: string | undefined): Pokemon | null {
		if (!name) return null;
		const nameLower = name.toLowerCase();
		for (const side of battle.sides) {
			if (!side) continue;
			for (const pokemon of side.pokemon) {
				if (pokemon && pokemon.name.toLowerCase() === nameLower) {
					return pokemon;
				}
			}
		}
		return null;
	}

	/**
	 * Replaces the battle's field state (weather, terrain, pseudo-weather)
	 * with a snapshot.
	 *
	 * Engine events (onFieldStart/onFieldEnd/WeatherChange) are NOT fired —
	 * those would re-run duration callbacks and re-trigger ability
	 * interactions whose results are already baked into the snapshot.
	 *
	 * Protocol lines (|-weather|, |-fieldstart|, |-fieldend|) ARE emitted
	 * so the client's weather icon / terrain overlay updates to match.
	 * Emission is diffed against the prior state so unchanged weather
	 * doesn't produce spurious log lines.
	 *
	 * The `source` reference on each EffectState is left null here because
	 * this method runs BEFORE team rebuild (it has to — hazards need to be
	 * in place when switchIn fires). Call reconnectConditionSources() after
	 * teams are restored to patch the references against the rebuilt roster.
	 *
	 * Passing null clears the field entirely. Call this ONCE per restore
	 * operation (field is battle-scoped, not side-scoped).
	 */
	restoreField(battleId: string, snapshot: FieldSnapshot | null): boolean {
		const battle = this.getBattle(battleId);
		if (!battle) {
			console.log(`[Timeline Restore] restoreField: battle "${battleId}" not found`);
			return false;
		}

		const field = battle.field;
		const condName = (id: string) => battle.dex.conditions.getByID(id as any)?.name || id;

		console.log(`[Timeline Restore] restoreField("${battleId}")`);
		console.log(`[Timeline Restore]   Before: weather=${field.weather || 'none'}, terrain=${field.terrain || 'none'}, pseudoWeather=[${Object.keys(field.pseudoWeather).join(', ')}]`);

		const oldWeather = field.weather;
		const oldTerrain = field.terrain;
		const oldPseudo = new Set(Object.keys(field.pseudoWeather));

		const newWeather = snapshot?.weather?.id || '';
		const newTerrain = snapshot?.terrain?.id || '';
		const newPseudo = new Set((snapshot?.pseudoWeather || []).map(pw => pw.id).filter(Boolean));

		// ── Clear pseudo-weather in-place ──
		// Key deletion preserves the object reference in case anything
		// else holds a pointer to field.pseudoWeather.
		for (const id of oldPseudo) {
			if (!newPseudo.has(id)) {
				battle.add('-fieldend', 'move: ' + condName(id));
			}
			delete field.pseudoWeather[id];
		}

		// ── Clear weather/terrain state ──
		field.weather = '' as any;
		field.weatherState = battle.initEffectState({ id: '' });
		field.terrain = '' as any;
		field.terrainState = battle.initEffectState({ id: '' });

		if (!snapshot) {
			if (oldWeather) battle.add('-weather', 'none');
			if (oldTerrain) battle.add('-fieldend', 'move: ' + condName(oldTerrain));
			console.log(`[Timeline Restore]   Null snapshot: field cleared`);
			return true;
		}

		// ── Weather ──
		// source is left null; reconnectConditionSources patches it post-rebuild
		if (snapshot.weather && snapshot.weather.id) {
			field.weather = snapshot.weather.id as any;
			field.weatherState = battle.initEffectState({
				id: snapshot.weather.id as any,
				source: null,
				sourceSlot: snapshot.weather.sourceSlot,
				duration: snapshot.weather.turnsLeft,
			});
			if (snapshot.weather.extraData) {
				for (const key in snapshot.weather.extraData) {
					field.weatherState[key] = snapshot.weather.extraData[key];
				}
			}
			if (oldWeather !== snapshot.weather.id) {
				battle.add('-weather', condName(snapshot.weather.id));
			}
			console.log(`[Timeline Restore]   Weather restored: ${snapshot.weather.id}, duration=${snapshot.weather.turnsLeft ?? 'infinite'} (source deferred)`);
		} else if (oldWeather) {
			battle.add('-weather', 'none');
		}

		// ── Terrain ──
		if (snapshot.terrain && snapshot.terrain.id) {
			field.terrain = snapshot.terrain.id as any;
			field.terrainState = battle.initEffectState({
				id: snapshot.terrain.id as any,
				source: null,
				sourceSlot: snapshot.terrain.sourceSlot,
				duration: snapshot.terrain.turnsLeft,
			});
			if (snapshot.terrain.extraData) {
				for (const key in snapshot.terrain.extraData) {
					field.terrainState[key] = snapshot.terrain.extraData[key];
				}
			}
			if (oldTerrain !== snapshot.terrain.id) {
				battle.add('-fieldstart', 'move: ' + condName(snapshot.terrain.id));
			}
			console.log(`[Timeline Restore]   Terrain restored: ${snapshot.terrain.id}, duration=${snapshot.terrain.turnsLeft ?? 'infinite'} (source deferred)`);
		} else if (oldTerrain) {
			battle.add('-fieldend', 'move: ' + condName(oldTerrain));
		}

		// ── Pseudo-weather ──
		for (const pw of snapshot.pseudoWeather) {
			if (!pw.id) continue;
			const state = battle.initEffectState({
				id: pw.id as any,
				source: null,
				sourceSlot: pw.sourceSlot,
				duration: pw.turnsLeft,
			});
			if (pw.extraData) {
				for (const key in pw.extraData) {
					state[key] = pw.extraData[key];
				}
			}
			field.pseudoWeather[pw.id] = state;
			if (!oldPseudo.has(pw.id)) {
				battle.add('-fieldstart', 'move: ' + condName(pw.id));
			}
			console.log(`[Timeline Restore]   PseudoWeather restored: ${pw.id}, duration=${pw.turnsLeft ?? 'infinite'} (source deferred)`);
		}

		console.log(`[Timeline Restore]   After: weather=${field.weather || 'none'}, terrain=${field.terrain || 'none'}, pseudoWeather=[${Object.keys(field.pseudoWeather).join(', ')}]`);
		return true;
	}

	/**
	 * Replaces one side's sideConditions with a snapshot.
	 *
	 * Engine events (onSideStart/onSideEnd/SideConditionStart) are NOT
	 * fired — we don't want to re-run setup logic whose results are
	 * already in the snapshot.
	 *
	 * Protocol lines (|-sidestart|, |-sideend|) ARE emitted so the client's
	 * hazard/screen display updates. Emission is diffed against the prior
	 * state, so a Stealth Rock that was already up doesn't produce a
	 * redundant "pointed stones" message.
	 *
	 * Stale conditions are cleared by key deletion rather than object
	 * replacement, so that ally-side shared references in multi-battle
	 * formats stay valid (see Side.sideConditions comment).
	 *
	 * `source` references are left null; call reconnectConditionSources()
	 * after team rebuild. Passing null or an empty array clears all
	 * side conditions for this side.
	 */
	restoreSideConditions(
		battleId: string,
		sideId: 'p1' | 'p2',
		conditions: SideConditionSnapshot[] | null
	): boolean {
		const battle = this.getBattle(battleId);
		if (!battle) {
			console.log(`[Timeline Restore] restoreSideConditions: battle "${battleId}" not found`);
			return false;
		}

		const side = battle[sideId];
		if (!side) {
			console.log(`[Timeline Restore] restoreSideConditions: side "${sideId}" not found`);
			return false;
		}

		const condName = (id: string) => battle.dex.conditions.getByID(id as any)?.name || id;

		const before = Object.keys(side.sideConditions);
		const beforeSet = new Set(before);
		const afterSet = new Set((conditions || []).map(c => c.id).filter(Boolean));

		console.log(`[Timeline Restore] restoreSideConditions("${battleId}", "${sideId}")`);
		console.log(`[Timeline Restore]   Before: [${before.join(', ')}]`);

		// ── Clear in-place so ally-side shared refs stay valid ──
		// Emit -sideend only for conditions that aren't coming back,
		// to avoid a redundant remove/add flash for unchanged hazards.
		for (const id of before) {
			if (!afterSet.has(id)) {
				battle.add('-sideend', side, 'move: ' + condName(id));
			}
			delete side.sideConditions[id];
		}

		if (!conditions || conditions.length === 0) {
			console.log(`[Timeline Restore]   Empty snapshot: side conditions cleared`);
			return true;
		}

		// ── Rebuild from snapshot ──
		// source left null; reconnectConditionSources patches it post-rebuild
		for (const cond of conditions) {
			if (!cond.id) continue;

			const state = battle.initEffectState({
				id: cond.id as any,
				target: side,
				source: null,
				sourceSlot: cond.sourceSlot,
				duration: cond.turnsLeft,
			});

			if (cond.layers !== undefined) {
				state.layers = cond.layers;
			}
			if (cond.extraData) {
				for (const key in cond.extraData) {
					state[key] = cond.extraData[key];
				}
			}

			side.sideConditions[cond.id] = state;

			if (!beforeSet.has(cond.id)) {
				battle.add('-sidestart', side, 'move: ' + condName(cond.id));
			}
			console.log(`[Timeline Restore]   Restored ${cond.id}: duration=${cond.turnsLeft ?? 'N/A'}, layers=${cond.layers ?? 'N/A'}, extraKeys=[${Object.keys(cond.extraData || {}).join(', ')}] (source deferred)`);
		}

		console.log(`[Timeline Restore]   After: [${Object.keys(side.sideConditions).join(', ')}]`);
		return true;
	}

	/**
	 * Replaces one side's slotConditions with a snapshot, without firing
	 * onStart/onEnd events.
	 *
	 * Slot conditions (Wish, Future Sight, Healing Wish, Doom Desire)
	 * don't have a standard "condition active" protocol line — they only
	 * announce themselves when they resolve. No protocol emission here.
	 *
	 * Call this AFTER replaceTeamFromSnapshot / restoreTeamFromSnapshot,
	 * since those methods reset slotConditions to empty during team rebuild.
	 * Because this runs post-rebuild, `source` lookup works correctly here
	 * without needing a separate reconnect pass.
	 *
	 * Passing null or an empty object leaves the slots cleared.
	 */
	restoreSlotConditions(
		battleId: string,
		sideId: 'p1' | 'p2',
		slotConditions: { [slot: number]: SlotConditionSnapshot[] } | null
	): boolean {
		const battle = this.getBattle(battleId);
		if (!battle) {
			console.log(`[Timeline Restore] restoreSlotConditions: battle "${battleId}" not found`);
			return false;
		}

		const side = battle[sideId];
		if (!side) {
			console.log(`[Timeline Restore] restoreSlotConditions: side "${sideId}" not found`);
			return false;
		}

		console.log(`[Timeline Slot] restoreSlotConditions("${battleId}", "${sideId}")`);

		// Ensure the slotConditions array is at least as long as active slots
		if (!side.slotConditions) side.slotConditions = [];
		for (let i = 0; i < side.active.length; i++) {
			if (!side.slotConditions[i]) side.slotConditions[i] = {};
		}

		if (!slotConditions || Object.keys(slotConditions).length === 0) {
			console.log(`[Timeline Slot]   Empty snapshot: slot conditions left cleared`);
			return true;
		}

		let restored = 0;
		for (const slotStr in slotConditions) {
			const slot = parseInt(slotStr, 10);
			if (isNaN(slot)) continue;

			if (!side.slotConditions[slot]) side.slotConditions[slot] = {};

			const condsForSlot = slotConditions[slot];
			for (const cond of condsForSlot) {
				if (!cond.id) continue;
				// Runs post-rebuild, so this hits the rebuilt roster
				const src = this.findPokemonByName(battle, cond.source);

				const state = battle.initEffectState({
					id: cond.id as any,
					target: side,
					source: src,
					sourceSlot: cond.sourceSlot,
					isSlotCondition: true,
					duration: cond.turnsLeft,
				});
				if (cond.extraData) {
					for (const key in cond.extraData) {
						state[key] = cond.extraData[key];
					}
				}

				side.slotConditions[slot][cond.id] = state;
				restored++;
				console.log(`[Timeline Slot]   Restored slot ${slot}: ${cond.id}, duration=${cond.turnsLeft ?? 'N/A'}, source=${src?.name || `null(was "${cond.source}")`}, extraKeys=[${Object.keys(cond.extraData || {}).join(', ')}]`);
			}
		}

		console.log(`[Timeline Slot]   Total restored: ${restored} slot condition(s)`);
		return true;
	}

	/**
	 * Walks the field and side-condition EffectStates and re-resolves their
	 * `source` references against the CURRENT team roster.
	 *
	 * restoreField and restoreSideConditions must run before team rebuild
	 * (so entry hazards are in place when switchIn fires), which means
	 * findPokemonByName can't resolve source names at that point — the
	 * roster is the torn-down / pre-rebuild one. This method runs AFTER
	 * team rebuild to patch the references.
	 *
	 * Source names come from the snapshot passed in, not from the
	 * EffectState (which was deliberately left with source: null).
	 *
	 * Slot conditions don't need this — restoreSlotConditions already runs
	 * post-rebuild and resolves source correctly on its own.
	 */
	reconnectConditionSources(
		battleId: string,
		fieldSnap: FieldSnapshot | null,
		p1SideConds: SideConditionSnapshot[] | null,
		p2SideConds: SideConditionSnapshot[] | null,
	): void {
		const battle = this.getBattle(battleId);
		if (!battle) return;

		console.log(`[Timeline Restore] reconnectConditionSources("${battleId}")`);
		let patched = 0;

		// ── Field ──
		if (fieldSnap) {
			if (fieldSnap.weather?.source && battle.field.weather) {
				const src = this.findPokemonByName(battle, fieldSnap.weather.source);
				if (src) {
					battle.field.weatherState.source = src;
					patched++;
					console.log(`[Timeline Restore]   Weather source → ${src.name}`);
				} else {
					console.log(`[Timeline Restore]   Weather source "${fieldSnap.weather.source}" not in rebuilt roster`);
				}
			}
			if (fieldSnap.terrain?.source && battle.field.terrain) {
				const src = this.findPokemonByName(battle, fieldSnap.terrain.source);
				if (src) {
					battle.field.terrainState.source = src;
					patched++;
					console.log(`[Timeline Restore]   Terrain source → ${src.name}`);
				} else {
					console.log(`[Timeline Restore]   Terrain source "${fieldSnap.terrain.source}" not in rebuilt roster`);
				}
			}
			for (const pw of fieldSnap.pseudoWeather) {
				if (!pw.source || !battle.field.pseudoWeather[pw.id]) continue;
				const src = this.findPokemonByName(battle, pw.source);
				if (src) {
					battle.field.pseudoWeather[pw.id].source = src;
					patched++;
					console.log(`[Timeline Restore]   PseudoWeather ${pw.id} source → ${src.name}`);
				} else {
					console.log(`[Timeline Restore]   PseudoWeather ${pw.id} source "${pw.source}" not in rebuilt roster`);
				}
			}
		}

		// ── Side conditions ──
		const reconnectSide = (sideId: 'p1' | 'p2', conds: SideConditionSnapshot[] | null) => {
			if (!conds) return;
			const side = battle[sideId];
			if (!side) return;
			for (const cond of conds) {
				if (!cond.source || !side.sideConditions[cond.id]) continue;
				const src = this.findPokemonByName(battle, cond.source);
				if (src) {
					side.sideConditions[cond.id].source = src;
					patched++;
					console.log(`[Timeline Restore]   ${sideId} ${cond.id} source → ${src.name}`);
				} else {
					console.log(`[Timeline Restore]   ${sideId} ${cond.id} source "${cond.source}" not in rebuilt roster`);
				}
			}
		};
		reconnectSide('p1', p1SideConds);
		reconnectSide('p2', p2SideConds);

		console.log(`[Timeline Restore]   Reconnected ${patched} source reference(s)`);
	}

	/**
	 * Extracts a Pokemon from a battle (removes it and returns its state)
	 * The Pokemon is marked as fainted/unavailable in the source battle
	 */
	extractPokemon(
		battleId: string,
		side: 'p1' | 'p2',
		position: number = 0
	): { success: boolean; state?: PokemonTransferState; error?: string } {
		console.log(`[Timeline Team] extractPokemon("${battleId}", "${side}", ${position})`);

		const battle = this.getBattle(battleId);
		if (!battle) {
			console.log(`[Timeline Team] extractPokemon FAILED: Battle not found`);
			return { success: false, error: `Battle "${battleId}" not found` };
		}
		if (battle.ended) {
			console.log(`[Timeline Team] extractPokemon FAILED: Battle has ended`);
			return { success: false, error: `Battle has ended` };
		}

		const battleSide = battle[side];
		if (!battleSide) {
			console.log(`[Timeline Team] extractPokemon FAILED: Invalid side`);
			return { success: false, error: `Invalid side` };
		}

		console.log(`[Timeline Team] Side ${side} has ${battleSide.pokemon.length} Pokemon, ${battleSide.active.length} active slots`);
		console.log(`[Timeline Team] Side ${side} team: ${battleSide.pokemon.map((p: Pokemon) => `${p.name}(${p.hp}/${p.maxhp})`).join(', ')}`);

		const pokemon = battleSide.active[position];
		if (!pokemon) {
			console.log(`[Timeline Team] extractPokemon FAILED: No active Pokemon at position ${position}`);
			return { success: false, error: `No active Pokemon at position ${position}` };
		}
		if (pokemon.fainted) {
			console.log(`[Timeline Team] extractPokemon FAILED: Pokemon has fainted`);
			return { success: false, error: `Pokemon has fainted` };
		}

		console.log(`[Timeline Team] Extracting ${pokemon.name} from ${side} position ${position}`);

		// Capture state before removing
		const state = this.capturePokemonState(pokemon);

		// Mark the Pokemon as unavailable in this battle
		battle.add('', `${pokemon.name} was transferred out of the battle!`);

		pokemon.fainted = true;
		pokemon.faintQueued = true;
		pokemon.hp = 0;
		pokemon.isActive = false;
		pokemon.status = 'fnt' as any;
		battleSide.pokemonLeft--;

		// Clear from active slot
		battleSide.active[position] = null as any;

		console.log(`[Timeline Team] extractPokemon SUCCESS - ${pokemon.name} extracted, ${battleSide.pokemonLeft} Pokemon left on side`);
		return { success: true, state };
	}

	/**
	 * Receives a Pokemon into a battle using its transferred state
	 * Adds the Pokemon to the side's team and optionally switches it in
	 */
	receivePokemon(
		battleId: string,
		side: 'p1' | 'p2',
		state: PokemonTransferState,
		switchIn: boolean = true
	): TransferResult {
		console.log(`[Timeline Team] receivePokemon("${battleId}", "${side}", switchIn=${switchIn})`);
		console.log(`[Timeline Team]   Receiving: ${state.set.name || state.set.species} with HP ${state.hp}/${state.maxhp}`);

		const battle = this.getBattle(battleId);
		if (!battle) {
			console.log(`[Timeline Team] receivePokemon FAILED: Battle not found`);
			return { success: false, error: `Battle "${battleId}" not found` };
		}
		if (battle.ended) {
			console.log(`[Timeline Team] receivePokemon FAILED: Battle has ended`);
			return { success: false, error: `Battle has ended` };
		}

		const battleSide = battle[side];
		if (!battleSide) {
			console.log(`[Timeline Team] receivePokemon FAILED: Invalid side`);
			return { success: false, error: `Invalid side` };
		}

		console.log(`[Timeline Team] Side ${side} currently has ${battleSide.pokemon.length} Pokemon`);

		// Ensure the set is complete
		const completeSet = ensureCompletePokemonSet(state.set);
		console.log(`[Timeline Team] Complete set: ${completeSet.name} (${completeSet.species}), moves: [${completeSet.moves?.join(', ')}]`);

		// Use Side.addPokemon to create the Pokemon properly
		const pokemon = battleSide.addPokemon(completeSet);
		if (!pokemon) {
			console.log(`[Timeline Team] receivePokemon FAILED: addPokemon returned null (team may be full)`);
			return { success: false, error: `Failed to add Pokemon (team may be full)` };
		}

		console.log(`[Timeline Team] Pokemon added to team at position ${battleSide.pokemon.indexOf(pokemon)}`);

		// Apply the transferred state
		this.applyPokemonState(pokemon, state, battle);

		// Log the arrival
		battle.add('', `${pokemon.name} was transferred into the battle!`);

		const hpPercent = pokemon.maxhp > 0 ? Math.round((pokemon.hp / pokemon.maxhp) * 100) : 0;
		battle.add('-message', `${pokemon.name} arrived with ${hpPercent}% HP!`);

		// Show status if any
		if (pokemon.status) {
			battle.add('-message', `${pokemon.name} is ${pokemon.status}!`);
		}

		// Show significant boosts
		for (const stat in state.boosts) {
			const boost = state.boosts[stat as keyof typeof state.boosts];
			if (boost > 0) {
				battle.add('-message', `${pokemon.name} has +${boost} ${stat}!`);
			} else if (boost < 0) {
				battle.add('-message', `${pokemon.name} has ${boost} ${stat}!`);
			}
		}

		// Switch in if requested and there's an empty active slot
		if (switchIn) {
			const emptySlot = battleSide.active.findIndex(p => !p || p.fainted);
			console.log(`[Timeline Team] Looking for empty active slot, found: ${emptySlot}`);
			if (emptySlot >= 0) {
				console.log(`[Timeline Team] Switching in ${pokemon.name} to slot ${emptySlot}`);
				battle.actions.switchIn(pokemon, emptySlot);
			} else {
				console.log(`[Timeline Team] No empty active slot for switch-in`);
			}
		}

		console.log(`[Timeline Team] receivePokemon SUCCESS - ${pokemon.name} added to ${side}`);
		console.log(`[Timeline Team] Side ${side} now has ${battleSide.pokemon.length} Pokemon`);
		return { success: true, transferredPokemon: state };
	}

	/**
	 * Gets the Pokemon's transfer state without removing it from battle
	 * Useful for inspecting what would be transferred
	 */
	getPokemonTransferState(battleId: string, side: 'p1' | 'p2', position: number = 0): PokemonTransferState | null {
		console.log(`[Timeline Team] getPokemonTransferState("${battleId}", "${side}", ${position})`);

		const battle = this.getBattle(battleId);
		if (!battle) {
			console.log(`[Timeline Team] getPokemonTransferState: Battle not found`);
			return null;
		}

		const battleSide = battle[side];
		if (!battleSide) {
			console.log(`[Timeline Team] getPokemonTransferState: Side not found`);
			return null;
		}

		const pokemon = battleSide.active[position];
		if (!pokemon || pokemon.fainted) {
			console.log(`[Timeline Team] getPokemonTransferState: No valid active Pokemon at position`);
			return null;
		}

		return this.capturePokemonState(pokemon);
	}

	/**
	 * Full transfer: extracts from source and receives in destination
	 */
	transferPokemon(
		sourceBattleId: string,
		sourceSide: 'p1' | 'p2',
		sourcePosition: number,
		destBattleId: string,
		destSide: 'p1' | 'p2',
		switchIn: boolean = true
	): TransferResult {
		console.log(`[Timeline Team] transferPokemon START`);
		console.log(`[Timeline Team]   Source: "${sourceBattleId}" ${sourceSide} position ${sourcePosition}`);
		console.log(`[Timeline Team]   Dest: "${destBattleId}" ${destSide}, switchIn=${switchIn}`);

		// Extract from source
		const extractResult = this.extractPokemon(sourceBattleId, sourceSide, sourcePosition);
		if (!extractResult.success || !extractResult.state) {
			console.log(`[Timeline Team] transferPokemon FAILED at extraction: ${extractResult.error}`);
			return { success: false, error: extractResult.error || 'Failed to extract Pokemon' };
		}

		console.log(`[Timeline Team] Extraction successful, now receiving...`);

		// Receive in destination
		const receiveResult = this.receivePokemon(destBattleId, destSide, extractResult.state, switchIn);
		if (!receiveResult.success) {
			console.log(`[Timeline Team] transferPokemon FAILED at receive: ${receiveResult.error}`);
			// Note: The Pokemon is already extracted at this point
			// In a real implementation, you might want to handle this case
			return { success: false, error: receiveResult.error || 'Failed to receive Pokemon' };
		}

		console.log(`[Timeline Team] transferPokemon SUCCESS - ${extractResult.state.set.name || extractResult.state.set.species} transferred`);
		return { success: true, transferredPokemon: extractResult.state };
	}

	/**
	 * Forces a switch in a battle (useful after extracting a Pokemon)
	 */
	forceSwitch(battleId: string, side: 'p1' | 'p2', benchPosition: number): boolean {
		console.log(`[Timeline Team] forceSwitch("${battleId}", "${side}", ${benchPosition})`);

		const battle = this.getBattle(battleId);
		if (!battle) {
			console.log(`[Timeline Team] forceSwitch FAILED: Battle not found`);
			return false;
		}

		const battleSide = battle[side];
		if (!battleSide) {
			console.log(`[Timeline Team] forceSwitch FAILED: Side not found`);
			return false;
		}

		const benchPokemon = battleSide.pokemon[benchPosition];
		if (!benchPokemon || benchPokemon.fainted || benchPokemon.isActive) {
			console.log(`[Timeline Team] forceSwitch FAILED: Invalid bench Pokemon at position ${benchPosition}`);
			return false;
		}

		// Find empty active slot
		const emptySlot = battleSide.active.findIndex(p => !p || p.fainted);
		if (emptySlot < 0) {
			console.log(`[Timeline Team] forceSwitch FAILED: No empty active slot`);
			return false;
		}

		console.log(`[Timeline Team] Forcing switch: ${benchPokemon.name} to active slot ${emptySlot}`);
		battle.actions.switchIn(benchPokemon, emptySlot);
		console.log(`[Timeline Team] forceSwitch SUCCESS`);
		return true;
	}

	/**
	 * Builds a snapshot of the battle's field conditions.
	 */
	private getFieldSnapshot(battle: Battle): FieldSnapshot {
		const field = battle.field;
		console.log(`[Timeline Field] Capturing field snapshot - weather: ${field.weather || 'none'}, terrain: ${field.terrain || 'none'}`);

		let weatherSnapshot: FieldConditionSnapshot | null = null;
		if (field.weather) {
			const turnsLeft = field.weatherState.duration;
			const source = field.weatherState.source?.name;
			weatherSnapshot = {
				id: field.weather,
				turnsLeft: turnsLeft !== undefined ? turnsLeft : undefined,
				source: source,
				sourceSlot: field.weatherState.sourceSlot,
			};
			console.log(`[Timeline Field]   Weather: ${field.weather}, turnsLeft: ${turnsLeft ?? 'infinite'}, source: ${source || 'unknown'}`);
		}

		let terrainSnapshot: FieldConditionSnapshot | null = null;
		if (field.terrain) {
			const turnsLeft = field.terrainState.duration;
			const source = field.terrainState.source?.name;
			terrainSnapshot = {
				id: field.terrain,
				turnsLeft: turnsLeft !== undefined ? turnsLeft : undefined,
				source: source,
				sourceSlot: field.terrainState.sourceSlot,
			};
			console.log(`[Timeline Field]   Terrain: ${field.terrain}, turnsLeft: ${turnsLeft ?? 'infinite'}, source: ${source || 'unknown'}`);
		}

		const pseudoWeatherSnapshots: FieldConditionSnapshot[] = [];
		for (const id in field.pseudoWeather) {
			const state = field.pseudoWeather[id];
			const snapshot: FieldConditionSnapshot = {
				id: id,
				turnsLeft: state.duration !== undefined ? state.duration : undefined,
				source: state.source?.name,
				sourceSlot: state.sourceSlot,
			};
			pseudoWeatherSnapshots.push(snapshot);
			console.log(`[Timeline Field]   PseudoWeather: ${id}, turnsLeft: ${state.duration ?? 'infinite'}, source: ${state.source?.name || 'unknown'}`);
		}

		if (pseudoWeatherSnapshots.length === 0 && !weatherSnapshot && !terrainSnapshot) {
			console.log(`[Timeline Field]   No field conditions active`);
		}

		return {
			weather: weatherSnapshot,
			terrain: terrainSnapshot,
			pseudoWeather: pseudoWeatherSnapshots,
		};
	}

	/**
	 * Builds a snapshot of one side's side conditions.
	 */
	private getSideConditionsSnapshot(side: Side): SideConditionSnapshot[] {
		const conditions: SideConditionSnapshot[] = [];

		console.log(`[Timeline Side] Capturing side conditions for ${side.id}`);

		for (const id in side.sideConditions) {
			const state = side.sideConditions[id];
			const snapshot: SideConditionSnapshot = {
				id: id,
				turnsLeft: state.duration !== undefined ? state.duration : undefined,
				layers: state.layers !== undefined ? state.layers : undefined,
				source: state.source?.name,
				sourceSlot: state.sourceSlot,
			};
			conditions.push(snapshot);
			console.log(`[Timeline Side]   ${side.id} condition: ${id}, turnsLeft: ${state.duration ?? 'N/A'}, layers: ${state.layers ?? 'N/A'}, source: ${state.source?.name || 'unknown'}`);
		}

		if (conditions.length === 0) {
			console.log(`[Timeline Side]   ${side.id} has no side conditions`);
		}

		return conditions;
	}

	/**
	 * Builds a snapshot of one side's slot conditions.
	 */
	private getSlotConditionsSnapshot(side: Side): { [slot: number]: SlotConditionSnapshot[] } {
		const slotConditions: { [slot: number]: SlotConditionSnapshot[] } = {};

		console.log(`[Timeline Slot] Capturing slot conditions for ${side.id}`);

		if (side.slotConditions) {
			for (let slot = 0; slot < side.slotConditions.length; slot++) {
				const slotConds = side.slotConditions[slot];
				if (!slotConds || Object.keys(slotConds).length === 0) continue;

				slotConditions[slot] = [];
				for (const id in slotConds) {
					const state = slotConds[id];
					const snapshot: SlotConditionSnapshot = {
						id: id,
						turnsLeft: state.duration !== undefined ? state.duration : undefined,
						source: state.source?.name,
						sourceSlot: state.sourceSlot,
					};
					slotConditions[slot].push(snapshot);
					console.log(`[Timeline Slot]   ${side.id} slot ${slot} condition: ${id}, turnsLeft: ${state.duration ?? 'N/A'}, source: ${state.source?.name || 'unknown'}`);
				}
			}
		}

		const totalSlotConditions = Object.values(slotConditions).reduce((sum, arr) => sum + arr.length, 0);
		if (totalSlotConditions === 0) {
			console.log(`[Timeline Slot]   ${side.id} has no slot conditions`);
		}

		return slotConditions;
	}

	/**
	 * Gets a snapshot of a battle's current state
	 */
	getSnapshot(battleId: string): BattleSnapshot | null {
		console.log(`[Timeline Team] getSnapshot("${battleId}")`);

		const battle = this.getBattle(battleId);
		if (!battle) {
			console.log(`[Timeline Team] getSnapshot: Battle not found`);
			return null;
		}

		const getSideSnapshot = (side: Side): SideSnapshot => {
			const teamSnapshot = side.pokemon
				.map(p => this.getPokemonSnapshot(p))
				.filter((p): p is PokemonSnapshot => p !== null);

			const sideConditions = this.getSideConditionsSnapshot(side);
			const slotConditions = this.getSlotConditionsSnapshot(side);

			console.log(`[Timeline Team] getSnapshot side ${side.id}: ${teamSnapshot.length} Pokemon, ${side.pokemonLeft} left, ${sideConditions.length} side conditions`);

			return {
				name: side.name,
				pokemonLeft: side.pokemonLeft,
				active: side.active
					.filter(p => p != null)
					.map(p => this.getPokemonSnapshot(p))
					.filter((p): p is PokemonSnapshot => p !== null),
				team: teamSnapshot,
				sideConditions: sideConditions,
				slotConditions: slotConditions,
			};
		};

		const fieldSnapshot = this.getFieldSnapshot(battle);

		const snapshot = {
			battleId,
			turn: battle.turn,
			ended: battle.ended,
			winner: battle.winner,
			p1: getSideSnapshot(battle.p1),
			p2: getSideSnapshot(battle.p2),
			field: fieldSnapshot,
		};

		console.log(`[Timeline Team] getSnapshot result - turn ${snapshot.turn}, ended: ${snapshot.ended}`);
		console.log(`[Timeline Team]   p1 team: [${snapshot.p1.team.map(p => `${p.name}(${p.hp}%)`).join(', ')}]`);
		console.log(`[Timeline Team]   p2 team: [${snapshot.p2.team.map(p => `${p.name}(${p.hp}%)`).join(', ')}]`);
		console.log(`[Timeline Team]   field: weather=${snapshot.field.weather?.id || 'none'}, terrain=${snapshot.field.terrain?.id || 'none'}, pseudoWeather=[${snapshot.field.pseudoWeather.map(pw => pw.id).join(', ')}]`);
		console.log(`[Timeline Team]   p1 conditions: [${snapshot.p1.sideConditions.map(c => c.id).join(', ')}]`);
		console.log(`[Timeline Team]   p2 conditions: [${snapshot.p2.sideConditions.map(c => c.id).join(', ')}]`);

		return snapshot;
	}

	/**
	 * Gets a snapshot of a Pokemon's current state
	 */
	private getPokemonSnapshot(pokemon: Pokemon | null): PokemonSnapshot | null {
		if (!pokemon) return null;

		const fainted = pokemon.fainted || pokemon.hp <= 0;
		const maxhp = pokemon.maxhp || 100;
		const hpPercent = fainted ? 0 : (maxhp > 0 ? Math.round((pokemon.hp / maxhp) * 100) : 0);

		// Volatiles: basic fields only. This path is inspection-only (external
		// getSnapshot() API), not restoration, so extraData is left off.
		const volatiles: VolatileSnapshot[] = [];
		for (const id in pokemon.volatiles) {
			const state = pokemon.volatiles[id];
			volatiles.push({
				id,
				turnsLeft: state.duration,
				source: state.source?.name,
				sourceSlot: state.sourceSlot,
			});
		}

		return {
			name: pokemon.name,
			species: pokemon.species.name,
			hp: hpPercent,
			maxhp: maxhp,
			status: pokemon.status || '',
			fainted: fainted,
			isActive: pokemon.isActive,
			boosts: { ...pokemon.boosts },
			item: pokemon.item,
			ability: pokemon.ability,
			moves: pokemon.moveSlots.map(m => m.id),
			position: pokemon.position,
			volatiles,
		};
	}

	/**
	 * Gets a Pokemon from a battle's team
	 */
	getPokemon(battleId: string, side: 'p1' | 'p2', position: number): Pokemon | null {
		console.log(`[Timeline Team] getPokemon("${battleId}", "${side}", ${position})`);

		const battle = this.getBattle(battleId);
		if (!battle) return null;

		const battleSide = battle[side];
		if (!battleSide || position >= battleSide.pokemon.length) return null;

		const pokemon = battleSide.pokemon[position];
		console.log(`[Timeline Team] getPokemon result: ${pokemon?.name || 'null'}`);
		return pokemon;
	}

	/**
	 * Gets the active Pokemon from a battle
	 */
	getActivePokemon(battleId: string, side: 'p1' | 'p2', slot: number = 0): Pokemon | null {
		console.log(`[Timeline Team] getActivePokemon("${battleId}", "${side}", ${slot})`);

		const battle = this.getBattle(battleId);
		if (!battle) return null;

		const battleSide = battle[side];
		if (!battleSide || slot >= battleSide.active.length) return null;

		const pokemon = battleSide.active[slot];
		console.log(`[Timeline Team] getActivePokemon result: ${pokemon?.name || 'null'}`);
		return pokemon;
	}

	/**
	 * Replaces a side's team with a stored team snapshot from a timeline node,
	 * then adds the transferred Pokemon as the new active Pokemon.
	 *
	 * The transferred Pokemon is a genuine new arrival to this battle state,
	 * so battle.actions.switchIn is used and entry hazards / on-entry abilities
	 * trigger normally. Callers must restore side conditions BEFORE calling
	 * this so those hazards reflect the target turn.
	 *
	 * NOTE: This method does NOT call makeRequest() or sendUpdates().
	 * The caller (MultiTimeBattleStream) is responsible for triggering
	 * new requests and flushing updates after all transfers are complete.
	 */
	replaceTeamFromSnapshot(
		battleId: string,
		side: 'p1' | 'p2',
		snapshotSets: PokemonSet[],
		snapshotDisplays: PokemonSnapshot[],
		transferredState: PokemonTransferState
	): TransferResult {
		console.log(`[Timeline Team] replaceTeamFromSnapshot("${battleId}", "${side}")`);
		console.log(`[Timeline Team]   Snapshot sets: ${snapshotSets.length}, displays: ${snapshotDisplays.length}`);
		console.log(`[Timeline Team]   Transferred: ${transferredState.set.name || transferredState.set.species}`);

		const battle = this.getBattle(battleId);
		if (!battle) return { success: false, error: `Battle "${battleId}" not found` };
		if (battle.ended) return { success: false, error: `Battle has ended` };

		const battleSide = battle[side];
		if (!battleSide) return { success: false, error: `Invalid side "${side}"` };

		// Build a display lookup by name/species for HP/status
		const displayByName = new Map<string, PokemonSnapshot>();
		for (const d of snapshotDisplays) {
			displayByName.set(d.name.toLowerCase(), d);
			displayByName.set(d.species.toLowerCase(), d);
		}

		const oldActiveName = battleSide.active[0]?.name || 'unknown';
		console.log(`[Timeline Team] Old active: ${oldActiveName}`);

		// ── STEP 1: Faint all existing Pokemon ──
		for (const pokemon of battleSide.pokemon) {
			pokemon.fainted = true;
			pokemon.faintQueued = false;
			pokemon.hp = 0;
			pokemon.isActive = false;
			pokemon.status = 'fnt' as any;
		}
		battleSide.active[0] = null as any;

		// ── STEP 2: Clear team arrays ──
		battleSide.pokemon = [];
		battleSide.team = [];
		battleSide.pokemonLeft = 0;

		// ── STEP 3: Reset slotConditions for all active slots ──
		// Slot conditions are restored separately AFTER this method returns
		// (they don't affect switchIn, and this rebuild would wipe them).
		battleSide.slotConditions = [];
		for (let i = 0; i < battleSide.active.length; i++) {
			battleSide.slotConditions[i] = {};
		}
		console.log(`[Timeline Team] Team cleared, slotConditions reset (${battleSide.active.length} slots)`);

		// ── STEP 4: Add the transferred Pokemon FIRST (position 0) ──
		// This ensures it's at position 0 which the battle engine considers
		// the active slot for singles.
		const completeTransferSet = ensureCompletePokemonSet(transferredState.set);
		const transferredPokemon = battleSide.addPokemon(completeTransferSet);
		if (!transferredPokemon) {
			return { success: false, error: `Failed to add transferred Pokemon` };
		}
		this.applyPokemonState(transferredPokemon, transferredState, battle);
		console.log(`[Timeline Team] Transferred Pokemon added at position 0: ${transferredPokemon.name} HP ${transferredPokemon.hp}/${transferredPokemon.maxhp}`);

		// ── STEP 5: Rebuild bench from snapshot sets ──
		for (const set of snapshotSets) {
			const completeSet = ensureCompletePokemonSet(set);
			const pokemon = battleSide.addPokemon(completeSet);
			if (!pokemon) {
				console.log(`[Timeline Team]   addPokemon returned null for ${set.name}`);
				continue;
			}

			// Find matching display data for HP/status
			const display = displayByName.get(pokemon.name.toLowerCase())
				|| displayByName.get(pokemon.species.name.toLowerCase());

			if (display) {
				if (display.fainted || display.hp <= 0) {
					pokemon.fainted = true;
					pokemon.hp = 0;
					pokemon.status = 'fnt' as any;
					battleSide.pokemonLeft--;
					console.log(`[Timeline Team]   ${pokemon.name} - fainted (from snapshot)`);
				} else {
					pokemon.hp = Math.max(1, Math.round((display.hp / 100) * pokemon.maxhp));
					if (display.status) {
						this.setStatusSilently(pokemon, display.status, battle);
					}
					console.log(`[Timeline Team]   ${pokemon.name} HP: ${pokemon.hp}/${pokemon.maxhp} (${display.hp}%), status: ${display.status || 'none'}`);
				}
			} else {
				console.log(`[Timeline Team]   ${pokemon.name} - no display data, keeping full HP`);
			}
		}

		// ── STEP 6: Switch in the transferred Pokemon (position 0) ──
		// Full switchIn path: entry hazards, Intimidate, weather abilities
		// all fire. Side conditions must have been restored by the caller
		// beforehand for hazards to be correct.
		try {
			battle.actions.switchIn(transferredPokemon, 0);
			console.log(`[Timeline Team] Switched in ${transferredPokemon.name} via battle.actions.switchIn`);
		} catch (e: any) {
			console.log(`[Timeline Team] switchIn threw: ${e.message}, using manual fallback`);
			battleSide.active[0] = transferredPokemon;
			transferredPokemon.isActive = true;
			transferredPokemon.activeTurns = 0;
			transferredPokemon.activeMoveActions = 0;
			transferredPokemon.position = 0;
		}

		// ── STEP 7: Verify positions are correct ──
		if (!battleSide.active[0] || battleSide.active[0].fainted) {
			console.log(`[Timeline Team] Active slot still empty after switchIn, forcing manually`);
			battleSide.active[0] = transferredPokemon;
			transferredPokemon.isActive = true;
			transferredPokemon.position = 0;
		}

		// Ensure slotConditions has entries for all active positions
		for (let i = 0; i < battleSide.active.length; i++) {
			if (!battleSide.slotConditions[i]) {
				battleSide.slotConditions[i] = {};
			}
		}

		// ── STEP 8: Reset choice state ──
		battleSide.choice = {
			cantUndo: false,
			error: '',
			actions: [],
			forcedSwitchesLeft: 0,
			forcedPassesLeft: 0,
			switchIns: new Set(),
			zMove: false,
			mega: false,
			ultra: false,
			dynamax: false,
			terastallize: false,
		};

		console.log(`[Timeline Team] Final team state for ${side}:`);
		for (let i = 0; i < battleSide.pokemon.length; i++) {
			const pokemon = battleSide.pokemon[i];
			console.log(`[Timeline Team]   [${i}] pos=${pokemon.position} ${pokemon.name} | HP: ${pokemon.hp}/${pokemon.maxhp} | Active: ${pokemon.isActive} | Fainted: ${pokemon.fainted}`);
		}
		console.log(`[Timeline Team]   active[0]: ${battleSide.active[0]?.name || 'EMPTY'}`);
		console.log(`[Timeline Team]   pokemonLeft: ${battleSide.pokemonLeft}`);

		return { success: true, transferredPokemon: transferredState };
	}

	/**
	 * Restores a side's team to a snapshot state WITHOUT adding a transferred Pokemon.
	 * Used for the non-transferring side when a branch is created, and for both
	 * sides during a present-shift.
	 *
	 * The active Pokemon in the snapshot was already present at the target turn —
	 * its HP already reflects any entry hazard damage, and any Intimidate / weather
	 * ability effects are already baked into the snapshot data. Running it through
	 * battle.actions.switchIn would double-apply those effects. Instead this
	 * method uses direct active-slot assignment and emits a raw |switch| protocol
	 * line so the client stays in sync.
	 */
	restoreTeamFromSnapshot(
		battleId: string,
		side: 'p1' | 'p2',
		snapshotSets: PokemonSet[],
		snapshotDisplays: PokemonSnapshot[]
	): TransferResult {
		console.log(`[Timeline Team] restoreTeamFromSnapshot("${battleId}", "${side}")`);
		console.log(`[Timeline Team]   Snapshot sets: ${snapshotSets.length}, displays: ${snapshotDisplays.length}`);

		const battle = this.getBattle(battleId);
		if (!battle) return { success: false, error: `Battle "${battleId}" not found` };
		if (battle.ended) return { success: false, error: `Battle has ended` };

		const battleSide = battle[side];
		if (!battleSide) return { success: false, error: `Invalid side "${side}"` };

		// Build a display lookup by name/species for HP/status/boosts
		const displayByName = new Map<string, PokemonSnapshot>();
		for (const d of snapshotDisplays) {
			displayByName.set(d.name.toLowerCase(), d);
			displayByName.set(d.species.toLowerCase(), d);
		}

		// Find which Pokemon was active in the snapshot
		const activeDisplay = snapshotDisplays.find(d => d.isActive && !d.fainted);
		console.log(`[Timeline Team] Active Pokemon in snapshot: ${activeDisplay?.name || 'none'}`);

		// ── STEP 1: Faint all existing Pokemon ──
		for (const pokemon of battleSide.pokemon) {
			pokemon.fainted = true;
			pokemon.faintQueued = false;
			pokemon.hp = 0;
			pokemon.isActive = false;
			pokemon.status = 'fnt' as any;
		}
		battleSide.active[0] = null as any;

		// ── STEP 2: Clear team arrays ──
		battleSide.pokemon = [];
		battleSide.team = [];
		battleSide.pokemonLeft = 0;

		// ── STEP 3: Reset slotConditions ──
		// Slot conditions are restored separately AFTER this method returns.
		battleSide.slotConditions = [];
		for (let i = 0; i < battleSide.active.length; i++) {
			battleSide.slotConditions[i] = {};
		}
		console.log(`[Timeline Team] Team cleared for ${side}`);

		// ── STEP 4: Rebuild team from snapshot sets ──
		let activePokemon: Pokemon | null = null;
		let activeDisplayData: PokemonSnapshot | null = null;

		for (const set of snapshotSets) {
			const completeSet = ensureCompletePokemonSet(set);
			const pokemon = battleSide.addPokemon(completeSet);
			if (!pokemon) {
				console.log(`[Timeline Team]   addPokemon returned null for ${set.name}`);
				continue;
			}

			// Find matching display data
			const display = displayByName.get(pokemon.name.toLowerCase())
				|| displayByName.get(pokemon.species.name.toLowerCase());

			if (display) {
				if (display.fainted || display.hp <= 0) {
					pokemon.fainted = true;
					pokemon.hp = 0;
					pokemon.status = 'fnt' as any;
					battleSide.pokemonLeft--;
					console.log(`[Timeline Team]   ${pokemon.name} - fainted (from snapshot)`);
				} else {
					// Apply HP (stored as percentage)
					pokemon.hp = Math.max(1, Math.round((display.hp / 100) * pokemon.maxhp));

					// Silent status: no events, no protocol before |switch|
					if (display.status && display.status !== '') {
						this.setStatusSilently(pokemon, display.status, battle);
					}

					console.log(`[Timeline Team]   ${pokemon.name} HP: ${pokemon.hp}/${pokemon.maxhp} (${display.hp}%), status: ${display.status || 'none'}`);

					// Track if this is the active Pokemon - we'll apply boosts after placement
					if (display.isActive) {
						activePokemon = pokemon;
						activeDisplayData = display;
					}
				}
			} else {
				console.log(`[Timeline Team]   ${pokemon.name} - no display data, keeping full HP`);
			}
		}

		// ── STEP 5: Place the active Pokemon directly (no switchIn events) ──
		// This Pokemon was ALREADY active at the target turn. Its snapshot HP
		// already accounts for any Stealth Rock damage it took on its original
		// entry. Running switchIn would re-trigger hazards and re-fire abilities
		// like Intimidate whose results are already in the snapshot.
		const placeMon = activePokemon ?? battleSide.pokemon.find(p => !p.fainted && p.hp > 0) ?? null;

		if (placeMon) {
			// Swap into index 0 so position matches active slot (singles assumption)
			const currentIdx = battleSide.pokemon.indexOf(placeMon);
			if (currentIdx > 0) {
				const swapWith = battleSide.pokemon[0];
				battleSide.pokemon[0] = placeMon;
				battleSide.pokemon[currentIdx] = swapWith;
				placeMon.position = 0;
				if (swapWith) swapWith.position = currentIdx;
				console.log(`[Timeline Team]   Swapped ${placeMon.name} to index 0 (was ${currentIdx})`);
			}

			battleSide.active[0] = placeMon;
			placeMon.isActive = true;
			placeMon.activeTurns = 0;
			placeMon.activeMoveActions = 0;

			// Emit a |switch| line so the client can place the sprite and HP bar.
			// Protocol format: |switch|POKEMON|DETAILS|HP STATUS
			try {
				const details = (placeMon as any).details || `${placeMon.species.name}, L${placeMon.level}`;
				const healthStr = placeMon.fainted
					? '0 fnt'
					: `${placeMon.hp}/${placeMon.maxhp}${placeMon.status ? ` ${placeMon.status}` : ''}`;
				battle.add('switch', placeMon, details, healthStr);
				console.log(`[Timeline Team]   Emitted |switch| for ${placeMon.name}: ${healthStr}`);
			} catch (e: any) {
				console.log(`[Timeline Team]   Failed to emit |switch| for ${placeMon.name}: ${e.message}`);
			}
		} else {
			console.log(`[Timeline Team]   No Pokemon available to place as active for ${side}`);
		}

		// ── STEP 6: Apply boosts and volatiles to the placed Pokemon ──
		// Applied AFTER the |switch| line above so the client has a Pokemon
		// in the slot to attach them to. A real switchIn would have cleared
		// both; here we're restoring a snapshot where they were already
		// present on this Pokemon at the target turn.
		//
		// Protocol lines (|-setboost|, |-start|) are emitted with [silent]
		// so the client updates its stat-arrow and volatile-icon trackers
		// without narrating each one into the battle log.
		if (placeMon && activeDisplayData) {
			// ── Boosts ──
			if (activeDisplayData.boosts) {
				const boostKeys = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'] as const;
				for (const stat of boostKeys) {
					const boost = activeDisplayData.boosts[stat];
					if (boost !== undefined && boost !== 0) {
						placeMon.boosts[stat] = boost;
						// |-setboost| is an absolute value, unlike the
						// delta-based |-boost| / |-unboost|. Matches what
						// Belly Drum and Anger Point emit.
						battle.add('-setboost', placeMon, stat, boost, '[silent]');
					}
				}
				console.log(`[Timeline Team]   Applied boosts: ${JSON.stringify(activeDisplayData.boosts)}`);
			}

			// ── Volatiles ──
			// Denylist instead of whitelist: skip only single-turn flags
			// and mid-move state that would desync the move-resolution
			// state machine if restored out of sequence. Everything else
			// is restored with its full captured EffectState payload.
			if (activeDisplayData.volatiles && activeDisplayData.volatiles.length > 0) {
				const skipVolatiles = new Set([
					// Single-turn flags the engine clears at turn boundaries
					'flinch', 'endure', 'protect', 'quickguard', 'wideguard',
					'destinybond', 'grudge', 'roost', 'gem', 'stall',
					// Mid-move state — restoring these out of sequence
					// corrupts the action-resolution state machine
					'mustrecharge', 'twoturnmove', 'lockedmove',
				]);

				const appliedVolatiles: string[] = [];
				const skippedVolatiles: string[] = [];

				for (const vol of activeDisplayData.volatiles) {
					if (!vol.id) continue;
					if (skipVolatiles.has(vol.id)) {
						skippedVolatiles.push(vol.id);
						continue;
					}

					// This runs post-rebuild (placeMon was just created and
					// placed), so source lookup hits the correct roster.
					const src = this.findPokemonByName(battle, vol.source);

					const state = battle.initEffectState({
						id: vol.id as any,
						target: placeMon,
						source: src,
						sourceSlot: vol.sourceSlot,
						duration: vol.turnsLeft,
					});
					if (vol.extraData) {
						for (const key in vol.extraData) {
							state[key] = vol.extraData[key];
						}
					}
					placeMon.volatiles[vol.id] = state;
					appliedVolatiles.push(vol.id);

					// |-start| updates the client's volatile tracker.
					// [silent] keeps it out of the log; most clients still
					// draw the icon / overlay on silent starts.
					const condName = battle.dex.conditions.getByID(vol.id as any)?.name || vol.id;
					battle.add('-start', placeMon, condName, '[silent]');
				}

				if (appliedVolatiles.length > 0) {
					console.log(`[Timeline Team]   Applied volatiles: [${appliedVolatiles.join(', ')}]`);
				}
				if (skippedVolatiles.length > 0) {
					console.log(`[Timeline Team]   Skipped single-turn/mid-move volatiles: [${skippedVolatiles.join(', ')}]`);
				}
			}
		}

		// ── STEP 7: Reset choice state ──
		battleSide.choice = {
			cantUndo: false,
			error: '',
			actions: [],
			forcedSwitchesLeft: 0,
			forcedPassesLeft: 0,
			switchIns: new Set(),
			zMove: false,
			mega: false,
			ultra: false,
			dynamax: false,
			terastallize: false,
		};

		console.log(`[Timeline Team] Final restored team state for ${side}:`);
		for (let i = 0; i < battleSide.pokemon.length; i++) {
			const pokemon = battleSide.pokemon[i];
			console.log(`[Timeline Team]   [${i}] ${pokemon.name} | HP: ${pokemon.hp}/${pokemon.maxhp} | Active: ${pokemon.isActive} | Fainted: ${pokemon.fainted} | Boosts: ${JSON.stringify(pokemon.boosts)}`);
		}
		console.log(`[Timeline Team]   active[0]: ${battleSide.active[0]?.name || 'EMPTY'}`);
		console.log(`[Timeline Team]   pokemonLeft: ${battleSide.pokemonLeft}`);

		return { success: true };
	}

	/**
	 * Gets the battle log
	 */
	getLog(battleId: string): string[] {
		return this.battleLogs.get(battleId) || [];
	}

	/**
	 * Checks if a battle has ended
	 */
	hasEnded(battleId: string): boolean {
		const battle = this.getBattle(battleId);
		return battle ? battle.ended : true;
	}

	/**
	 * Gets the winner of a battle
	 */
	getWinner(battleId: string): string | undefined {
		const battle = this.getBattle(battleId);
		return battle?.winner;
	}

	/**
	 * Gets all snapshots
	 */
	getAllSnapshots(): BattleSnapshot[] {
		console.log(`[Timeline Team] getAllSnapshots()`);
		const snapshots = this.getBattleIds()
			.map(id => this.getSnapshot(id))
			.filter((s): s is BattleSnapshot => s !== null);
		console.log(`[Timeline Team] getAllSnapshots returned ${snapshots.length} snapshots`);
		return snapshots;
	}

	/**
	 * Destroys a battle and removes it from the manager
	 */
	destroyBattle(battleId: string): void {
		console.log(`[Timeline Team] destroyBattle("${battleId}")`);

		const battle = this.getBattle(battleId);
		if (battle) {
			battle.destroy();
			this.battles.delete(battleId);
			this.battleLogs.delete(battleId);
			this.battleLinks.delete(battleId);

			// Remove from other battles' links
			for (const [id, links] of this.battleLinks) {
				const index = links.indexOf(battleId);
				if (index > -1) {
					links.splice(index, 1);
				}
			}
			console.log(`[Timeline Team] Battle "${battleId}" destroyed. Total battles remaining: ${this.battles.size}`);
		}
	}

	/**
	 * Destroys all battles
	 */
	destroyAll(): void {
		console.log(`[Timeline Team] destroyAll() - destroying ${this.battles.size} battles`);
		for (const battleId of [...this.battles.keys()]) {
			this.destroyBattle(battleId);
		}
	}
}

// Export a singleton instance for convenience
export const battleManager = new MultiBattleManager();

export default MultiBattleManager;