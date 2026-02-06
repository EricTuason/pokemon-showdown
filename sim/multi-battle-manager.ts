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

export interface PokemonSnapshot {
	name: string;
	species: string;
	hp: number;
	maxhp: number;
	hpPercent: number;
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
	}

	/**
	 * Creates a new battle and adds it to the manager
	 */
	createBattle(battleId: string, options: MultiBattleOptions): Battle {
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

		// Set up players if provided
		if (options.p1) {
			this.setPlayer(battleId, 'p1', options.p1);
		}
		if (options.p2) {
			this.setPlayer(battleId, 'p2', options.p2);
		}

		return battle;
	}

	/**
	 * Sets a player for a battle
	 */
	setPlayer(battleId: string, slot: 'p1' | 'p2' | 'p3' | 'p4', options: PlayerOptions): void {
		const battle = this.getBattle(battleId);
		if (!battle) {
			throw new Error(`Battle "${battleId}" not found`);
		}

		let team = options.team;
		if (typeof team === 'object' && Array.isArray(team)) {
			// Ensure all sets are complete before packing
			team = team.map(set => ensureCompletePokemonSet(set));
			team = Teams.pack(team);
		}

		battle.setPlayer(slot, {
			name: options.name,
			team: team as string | undefined,
			avatar: options.avatar,
		});
	}

	/**
	 * Gets a battle by ID
	 */
	getBattle(battleId: string): Battle | undefined {
		return this.battles.get(battleId);
	}

	/**
	 * Gets all battle IDs
	 */
	getBattleIds(): string[] {
		return Array.from(this.battles.keys());
	}

	/**
	 * Links two battles (for organizational purposes)
	 */
	linkBattles(battleId1: string, battleId2: string, bidirectional: boolean = true): void {
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
	}

	/**
	 * Gets battles linked to a specific battle
	 */
	getLinkedBattles(battleId: string): Battle[] {
		const linkedIds = this.battleLinks.get(battleId) || [];
		return linkedIds
			.map(id => this.getBattle(id))
			.filter((b): b is Battle => b !== undefined);
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
	}

	/**
	 * Makes a choice for a player in a battle
	 */
	choose(battleId: string, side: 'p1' | 'p2' | 'p3' | 'p4', choice: string): boolean {
		const battle = this.getBattle(battleId);
		if (!battle) {
			throw new Error(`Battle "${battleId}" not found`);
		}
		return battle.choose(side, choice);
	}

	/**
	 * Makes choices for both players (convenience method)
	 */
	makeChoices(battleId: string, p1Choice: string, p2Choice: string): void {
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

		return {
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
	}

	/**
	 * Applies a captured state to a Pokemon after it's been created
	 */
	private applyPokemonState(pokemon: Pokemon, state: PokemonTransferState, battle: Battle): void {
		// Apply HP (capped at maxhp)
		pokemon.hp = Math.min(state.hp, pokemon.maxhp);
		
		// Apply status
		if (state.status && state.status !== '') {
			pokemon.setStatus(state.status as any);
			// Copy status state properties
			for (const key in state.statusState) {
				if (key !== 'id' && key !== 'target') {
					pokemon.statusState[key] = state.statusState[key];
				}
			}
		}
		
		// Apply boosts
		pokemon.boosts = { ...state.boosts };
		
		// Apply volatiles (skip battle-specific ones that won't transfer well)
		const skipVolatiles = new Set([
			'mustrecharge', 'lockedmove', 'twoturnmove', 'choicelock',
			'flinch', 'destinybond', 'grudge', 'endure',
			'stall', 'gem', 'roost', 'protect', 'quickguard', 'wideguard'
		]);
		
		for (const id in state.volatiles) {
			if (skipVolatiles.has(id)) continue;
			pokemon.volatiles[id] = { ...state.volatiles[id] };
			// Update target reference
			pokemon.volatiles[id].target = pokemon;
		}
		
		// Apply move PP - match by move id
		for (const stateSlot of state.moveSlots) {
			for (const pokemonSlot of pokemon.moveSlots) {
				if (pokemonSlot.id === stateSlot.id) {
					pokemonSlot.pp = stateSlot.pp;
					pokemonSlot.used = stateSlot.used;
					// Note: disabled state is usually battle-specific, so we don't copy it
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
		}
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
		const battle = this.getBattle(battleId);
		if (!battle) {
			return { success: false, error: `Battle "${battleId}" not found` };
		}
		if (battle.ended) {
			return { success: false, error: `Battle has ended` };
		}

		const battleSide = battle[side];
		if (!battleSide) {
			return { success: false, error: `Invalid side` };
		}

		const pokemon = battleSide.active[position];
		if (!pokemon) {
			return { success: false, error: `No active Pokemon at position ${position}` };
		}
		if (pokemon.fainted) {
			return { success: false, error: `Pokemon has fainted` };
		}

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
		const battle = this.getBattle(battleId);
		if (!battle) {
			return { success: false, error: `Battle "${battleId}" not found` };
		}
		if (battle.ended) {
			return { success: false, error: `Battle has ended` };
		}

		const battleSide = battle[side];
		if (!battleSide) {
			return { success: false, error: `Invalid side` };
		}

		// Ensure the set is complete
		const completeSet = ensureCompletePokemonSet(state.set);
		
		// Use Side.addPokemon to create the Pokemon properly
		const pokemon = battleSide.addPokemon(completeSet);
		if (!pokemon) {
			return { success: false, error: `Failed to add Pokemon (team may be full)` };
		}

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
			if (emptySlot >= 0) {
				battle.actions.switchIn(pokemon, emptySlot);
			}
		}

		return { success: true, transferredPokemon: state };
	}

	/**
	 * Gets the Pokemon's transfer state without removing it from battle
	 * Useful for inspecting what would be transferred
	 */
	getPokemonTransferState(battleId: string, side: 'p1' | 'p2', position: number = 0): PokemonTransferState | null {
		const battle = this.getBattle(battleId);
		if (!battle) return null;

		const battleSide = battle[side];
		if (!battleSide) return null;

		const pokemon = battleSide.active[position];
		if (!pokemon || pokemon.fainted) return null;

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
		// Extract from source
		const extractResult = this.extractPokemon(sourceBattleId, sourceSide, sourcePosition);
		if (!extractResult.success || !extractResult.state) {
			return { success: false, error: extractResult.error || 'Failed to extract Pokemon' };
		}

		// Receive in destination
		const receiveResult = this.receivePokemon(destBattleId, destSide, extractResult.state, switchIn);
		if (!receiveResult.success) {
			// Note: The Pokemon is already extracted at this point
			// In a real implementation, you might want to handle this case
			return { success: false, error: receiveResult.error || 'Failed to receive Pokemon' };
		}

		return { success: true, transferredPokemon: extractResult.state };
	}

	/**
	 * Forces a switch in a battle (useful after extracting a Pokemon)
	 */
	forceSwitch(battleId: string, side: 'p1' | 'p2', benchPosition: number): boolean {
		const battle = this.getBattle(battleId);
		if (!battle) return false;

		const battleSide = battle[side];
		if (!battleSide) return false;

		const benchPokemon = battleSide.pokemon[benchPosition];
		if (!benchPokemon || benchPokemon.fainted || benchPokemon.isActive) return false;

		// Find empty active slot
		const emptySlot = battleSide.active.findIndex(p => !p || p.fainted);
		if (emptySlot < 0) return false;

		battle.actions.switchIn(benchPokemon, emptySlot);
		return true;
	}

	/**
	 * Gets a snapshot of a battle's current state
	 */
	getSnapshot(battleId: string): BattleSnapshot | null {
		const battle = this.getBattle(battleId);
		if (!battle) return null;

		const getSideSnapshot = (side: Side): SideSnapshot => {
			return {
				name: side.name,
				pokemonLeft: side.pokemonLeft,
				active: side.active
					.filter(p => p != null)
					.map(p => this.getPokemonSnapshot(p))
					.filter((p): p is PokemonSnapshot => p !== null),
				team: side.pokemon
					.map(p => this.getPokemonSnapshot(p))
					.filter((p): p is PokemonSnapshot => p !== null),
			};
		};

		return {
			battleId,
			turn: battle.turn,
			ended: battle.ended,
			winner: battle.winner,
			p1: getSideSnapshot(battle.p1),
			p2: getSideSnapshot(battle.p2),
		};
	}

	/**
	 * Gets a snapshot of a Pokemon's current state
	 */
	private getPokemonSnapshot(pokemon: Pokemon | null): PokemonSnapshot | null {
		if (!pokemon) return null;

		return {
			name: pokemon.name,
			species: pokemon.species.name,
			hp: pokemon.hp,
			maxhp: pokemon.maxhp,
			hpPercent: pokemon.maxhp > 0 ? Math.round((pokemon.hp / pokemon.maxhp) * 100) : 0,
			status: pokemon.status || '',
			fainted: pokemon.fainted,
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
		const battle = this.getBattle(battleId);
		if (!battle) return null;

		const battleSide = battle[side];
		if (!battleSide || position >= battleSide.pokemon.length) return null;

		return battleSide.pokemon[position];
	}

	/**
	 * Gets the active Pokemon from a battle
	 */
	getActivePokemon(battleId: string, side: 'p1' | 'p2', slot: number = 0): Pokemon | null {
		const battle = this.getBattle(battleId);
		if (!battle) return null;

		const battleSide = battle[side];
		if (!battleSide || slot >= battleSide.active.length) return null;

		return battleSide.active[slot];
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
		return this.getBattleIds()
			.map(id => this.getSnapshot(id))
			.filter((s): s is BattleSnapshot => s !== null);
	}

	/**
	 * Destroys a battle and removes it from the manager
	 */
	destroyBattle(battleId: string): void {
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
		}
	}

	/**
	 * Destroys all battles
	 */
	destroyAll(): void {
		for (const battleId of [...this.battles.keys()]) {
			this.destroyBattle(battleId);
		}
	}
}

// Export a singleton instance for convenience
export const battleManager = new MultiBattleManager();

export default MultiBattleManager;