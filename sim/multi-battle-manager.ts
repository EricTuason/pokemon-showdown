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

export interface BattleSnapshot {
	battleId: string;
	turn: number;
	ended: boolean;
	winner: string | undefined;
	p1: SideSnapshot;
	p2: SideSnapshot;
}

export interface SideSnapshot {
	name: string;
	pokemonLeft: number;
	active: PokemonSnapshot[];
	team: PokemonSnapshot[];
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
	volatiles: string[];
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
	 * Applies a captured state to a Pokemon after it's been created
	 */
	private applyPokemonState(pokemon: Pokemon, state: PokemonTransferState, battle: Battle): void {
		console.log(`[Timeline Team] applyPokemonState to ${pokemon.name}`);
		console.log(`[Timeline Team]   Incoming state - HP: ${state.hp}/${state.maxhp}, Status: ${state.status || 'none'}`);
		console.log(`[Timeline Team]   Incoming moveSlots: ${state.moveSlots.map(m => `${m.id}(${m.pp}/${m.maxpp})`).join(', ')}`);

		// Apply HP (capped at maxhp)
		pokemon.hp = Math.min(state.hp, pokemon.maxhp);
		console.log(`[Timeline Team]   Applied HP: ${pokemon.hp}/${pokemon.maxhp}`);
		
		// Apply status
		if (state.status && state.status !== '') {
			pokemon.setStatus(state.status as any);
			// Copy status state properties
			for (const key in state.statusState) {
				if (key !== 'id' && key !== 'target') {
					pokemon.statusState[key] = state.statusState[key];
				}
			}
			console.log(`[Timeline Team]   Applied status: ${state.status}`);
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

		console.log(`[Timeline Team]   Final Pokemon state - HP: ${pokemon.hp}/${pokemon.maxhp}, Moves: ${pokemon.moveSlots.map((m: any) => `${m.id}(${m.pp}/${m.maxpp})`).join(', ')}`);
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
			
			console.log(`[Timeline Team] getSnapshot side ${side.id}: ${teamSnapshot.length} Pokemon, ${side.pokemonLeft} left`);
			
			return {
				name: side.name,
				pokemonLeft: side.pokemonLeft,
				active: side.active
					.filter(p => p != null)
					.map(p => this.getPokemonSnapshot(p))
					.filter((p): p is PokemonSnapshot => p !== null),
				team: teamSnapshot,
			};
		};

		const snapshot = {
			battleId,
			turn: battle.turn,
			ended: battle.ended,
			winner: battle.winner,
			p1: getSideSnapshot(battle.p1),
			p2: getSideSnapshot(battle.p2),
		};

		console.log(`[Timeline Team] getSnapshot result - turn ${snapshot.turn}, ended: ${snapshot.ended}`);
		console.log(`[Timeline Team]   p1 team: [${snapshot.p1.team.map(p => `${p.name}(${p.hp}%)`).join(', ')}]`);
		console.log(`[Timeline Team]   p2 team: [${snapshot.p2.team.map(p => `${p.name}(${p.hp}%)`).join(', ')}]`);

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
			volatiles: Object.keys(pokemon.volatiles),
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
		// This prevents the revivalblessing crash in getSwitchRequestData
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
					if (display.status) pokemon.setStatus(display.status as any);
					console.log(`[Timeline Team]   ${pokemon.name} HP: ${pokemon.hp}/${pokemon.maxhp} (${display.hp}%)`);
				}
			} else {
				console.log(`[Timeline Team]   ${pokemon.name} - no display data, keeping full HP`);
			}
		}

		// ── STEP 6: Switch in the transferred Pokemon (position 0) ──
		// The transferred Pokemon is at index 0 in the pokemon array.
		// We need to properly set it as the active Pokemon.
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
		// addPokemon sets position = pokemon.length at time of add.
		// Position 0 = transferred mon (active), positions 1+ = bench.
		// Make sure active[0] is set correctly.
		if (!battleSide.active[0] || battleSide.active[0].fainted) {
			console.log(`[Timeline Team] Active slot still empty after switchIn, forcing manually`);
			battleSide.active[0] = transferredPokemon;
			transferredPokemon.isActive = true;
			transferredPokemon.position = 0;
		}

		// Ensure slotConditions has entries for all active positions
		// (should already be done in step 3 but double-check)
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
	 * Used for the non-transferring side when a branch is created.
	 * This ensures both sides reflect the target turn's state.
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

					// Apply status
					if (display.status && display.status !== '') {
						pokemon.setStatus(display.status as any);
					}

					console.log(`[Timeline Team]   ${pokemon.name} HP: ${pokemon.hp}/${pokemon.maxhp} (${display.hp}%), status: ${display.status || 'none'}`);

					// Track if this is the active Pokemon - we'll apply boosts after switch-in
					if (display.isActive) {
						activePokemon = pokemon;
						activeDisplayData = display;
					}
				}
			} else {
				console.log(`[Timeline Team]   ${pokemon.name} - no display data, keeping full HP`);
			}
		}

		// ── STEP 5: Switch in the active Pokemon ──
		if (activePokemon && !activePokemon.fainted) {
			try {
				battle.actions.switchIn(activePokemon, 0);
				console.log(`[Timeline Team] Switched in ${activePokemon.name} as active`);
			} catch (e: any) {
				console.log(`[Timeline Team] switchIn threw: ${e.message}, using manual fallback`);
				battleSide.active[0] = activePokemon;
				activePokemon.isActive = true;
				activePokemon.activeTurns = 0;
				activePokemon.activeMoveActions = 0;
				activePokemon.position = 0;
			}

			// ── STEP 6: Apply boosts and volatiles to the active Pokemon ──
			// This must happen AFTER switch-in since switching clears boosts
			if (activeDisplayData) {
				// Apply stat boosts
				if (activeDisplayData.boosts) {
					const boostKeys = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'] as const;
					for (const stat of boostKeys) {
						const boost = activeDisplayData.boosts[stat];
						if (boost !== undefined && boost !== 0) {
							activePokemon.boosts[stat] = boost;
						}
					}
					console.log(`[Timeline Team]   Applied boosts: ${JSON.stringify(activeDisplayData.boosts)}`);
				}

				// Apply volatiles (only safe ones that can be restored as flags)
				if (activeDisplayData.volatiles && activeDisplayData.volatiles.length > 0) {
					const safeVolatiles = new Set([
						'substitute', 'confusion', 'leechseed', 'curse',
						'embargo', 'healblock', 'partiallytrapped',
						'taunt', 'torment', 'encore', 'disable', 'attract',
						'focusenergy', 'magnetrise', 'aquaring', 'ingrain',
						'flashfire', 'slowstart', 'truant', 'unburden',
						'charge', 'defensecurl', 'lockon', 'minimize',
						'stockpile', 'stockpile1', 'stockpile2', 'stockpile3',
					]);

					const appliedVolatiles: string[] = [];
					for (const vol of activeDisplayData.volatiles) {
						if (safeVolatiles.has(vol)) {
							activePokemon.volatiles[vol] = {
								id: vol as ID,
								target: activePokemon,
								effectOrder: 0,
							};
							appliedVolatiles.push(vol);
						}
					}
					if (appliedVolatiles.length > 0) {
						console.log(`[Timeline Team]   Applied volatiles: [${appliedVolatiles.join(', ')}]`);
					}
				}
			}
		} else {
			// Find any non-fainted Pokemon to make active
			const available = battleSide.pokemon.find(p => !p.fainted && p.hp > 0);
			if (available) {
				try {
					battle.actions.switchIn(available, 0);
					console.log(`[Timeline Team] Switched in ${available.name} as fallback active`);
				} catch (e: any) {
					battleSide.active[0] = available;
					available.isActive = true;
				}
			} else {
				console.log(`[Timeline Team] No Pokemon available to switch in for ${side}`);
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