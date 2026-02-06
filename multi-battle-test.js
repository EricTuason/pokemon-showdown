/**
 * Multi-Battle Interactive Test
 * 
 * Run AFTER building: npm run build
 * Then run with: node multi-battle-test.js
 */

const readline = require('readline');
const { Battle } = require('./dist/sim/battle');
const { Dex } = require('./dist/sim/dex');
const { Teams } = require('./dist/sim/teams');

// ============== HELPER FUNCTIONS ==============

function ensureCompletePokemonSet(partialSet) {
	return {
		name: partialSet.name || partialSet.species || '',
		species: partialSet.species || partialSet.name || '',
		item: partialSet.item || '',
		ability: partialSet.ability || '',
		moves: partialSet.moves || [],
		nature: partialSet.nature || '',
		gender: partialSet.gender || '',
		evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...(partialSet.evs || {}) },
		ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31, ...(partialSet.ivs || {}) },
		level: partialSet.level || 100,
		shiny: partialSet.shiny,
		happiness: partialSet.happiness,
		teraType: partialSet.teraType,
	};
}

// ============== MULTI-BATTLE MANAGER ==============

class MultiBattleManager {
	constructor() {
		this.battles = new Map();
		this.battleLogs = new Map();
	}

	createBattle(battleId, options) {
		if (this.battles.has(battleId)) {
			throw new Error(`Battle "${battleId}" already exists`);
		}

		const formatid = options.formatid || 'gen9ou';
		const format = Dex.formats.get(formatid);

		const battle = new Battle({
			formatid,
			format,
			seed: options.seed,
			debug: options.debug,
			send: (type, data) => {
				const logs = this.battleLogs.get(battleId) || [];
				if (Array.isArray(data)) logs.push(...data);
				else logs.push(data);
				this.battleLogs.set(battleId, logs);
			},
		});

		this.battles.set(battleId, battle);
		this.battleLogs.set(battleId, []);

		if (options.p1) this.setPlayer(battleId, 'p1', options.p1);
		if (options.p2) this.setPlayer(battleId, 'p2', options.p2);

		return battle;
	}

	setPlayer(battleId, slot, options) {
		const battle = this.getBattle(battleId);
		let team = options.team;
		if (Array.isArray(team)) {
			team = Teams.pack(team.map(ensureCompletePokemonSet));
		}
		battle.setPlayer(slot, { name: options.name, team, avatar: options.avatar });
	}

	getBattle(battleId) {
		const battle = this.battles.get(battleId);
		if (!battle) throw new Error(`Battle "${battleId}" not found`);
		return battle;
	}

	startBattle(battleId) {
		const battle = this.getBattle(battleId);
		let safety = 0;
		while (battle.requestState && battle.requestState !== 'move' && !battle.ended) {
			if (safety++ > 10) throw new Error(`startBattle stuck, state: ${battle.requestState}`);
			for (const side of battle.sides) {
				if (!side.isChoiceDone()) side.autoChoose();
			}
			if (battle.allChoicesDone()) battle.commitChoices();
		}
	}

	/**
	 * Submit a choice for one side. Returns true on success, error string on failure.
	 */
	submitChoice(battleId, sideId, choiceStr) {
		const battle = this.getBattle(battleId);
		if (battle.ended) return 'Battle has ended';
		
		const side = battle.getSide(sideId);
		if (!side.requestState) return `${sideId} has no pending request`;

		const result = side.choose(choiceStr);
		if (!result) {
			return side.choice.error || 'Invalid choice';
		}

		// If all choices are done, commit
		if (battle.allChoicesDone()) {
			battle.commitChoices();

			// Auto-handle forced switches after the turn
			let switchSafety = 0;
			while (battle.requestState === 'switch' && !battle.ended && switchSafety++ < 20) {
				// Don't auto-handle - let the user choose switches
				break;
			}
		}

		return true;
	}

	capturePokemonState(pokemon) {
		const volatiles = {};
		for (const id in pokemon.volatiles) {
			volatiles[id] = { ...pokemon.volatiles[id] };
		}
		return {
			set: { ...pokemon.set },
			hp: pokemon.hp,
			maxhp: pokemon.maxhp,
			status: pokemon.status,
			statusState: { ...pokemon.statusState },
			boosts: { ...pokemon.boosts },
			volatiles,
			moveSlots: pokemon.moveSlots.map(s => ({
				id: s.id, move: s.move, pp: s.pp, maxpp: s.maxpp,
				target: s.target, disabled: s.disabled,
				disabledSource: s.disabledSource, used: s.used,
			})),
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

	applyPokemonState(pokemon, state) {
		pokemon.hp = Math.min(state.hp, pokemon.maxhp);

		if (state.status && state.status !== '') {
			pokemon.setStatus(state.status);
			for (const key in state.statusState) {
				if (key !== 'id' && key !== 'target') {
					pokemon.statusState[key] = state.statusState[key];
				}
			}
		}

		pokemon.boosts = { ...state.boosts };

		const skipVolatiles = new Set([
			'mustrecharge', 'lockedmove', 'twoturnmove', 'choicelock',
			'flinch', 'destinybond', 'grudge', 'endure',
			'stall', 'gem', 'roost', 'protect', 'quickguard', 'wideguard',
		]);
		for (const id in state.volatiles) {
			if (skipVolatiles.has(id)) continue;
			pokemon.volatiles[id] = { ...state.volatiles[id] };
			pokemon.volatiles[id].target = pokemon;
		}

		for (const stateSlot of state.moveSlots) {
			for (const pokemonSlot of pokemon.moveSlots) {
				if (pokemonSlot.id === stateSlot.id) {
					pokemonSlot.pp = stateSlot.pp;
					pokemonSlot.used = stateSlot.used;
					break;
				}
			}
		}

		pokemon.timesAttacked = state.timesAttacked;
		pokemon.lastDamage = state.lastDamage;
		if (state.addedType) pokemon.addedType = state.addedType;
	}

	extractPokemon(battleId, side, position = 0) {
		const battle = this.getBattle(battleId);
		if (battle.ended) return { success: false, error: 'Battle has ended' };

		const battleSide = battle[side];
		if (!battleSide) return { success: false, error: 'Invalid side' };

		const pokemon = battleSide.active[position];
		if (!pokemon) return { success: false, error: `No active Pokemon at position ${position}` };
		if (pokemon.fainted) return { success: false, error: 'Pokemon has fainted' };

		const state = this.capturePokemonState(pokemon);

		battle.add('-message', `${pokemon.name} was transferred out of the battle!`);
		pokemon.fainted = true;
		pokemon.faintQueued = true;
		pokemon.hp = 0;
		pokemon.isActive = false;
		pokemon.status = 'fnt';
		battleSide.pokemonLeft--;
		battleSide.active[position] = null;

		return { success: true, state };
	}

	receivePokemon(battleId, side, state, switchIn = false) {
		const battle = this.getBattle(battleId);
		if (battle.ended) return { success: false, error: 'Battle has ended' };

		const battleSide = battle[side];
		if (!battleSide) return { success: false, error: 'Invalid side' };

		const completeSet = ensureCompletePokemonSet(state.set);
		const pokemon = battleSide.addPokemon(completeSet);
		if (!pokemon) return { success: false, error: 'Failed to add Pokemon (team full, max 24)' };

		this.applyPokemonState(pokemon, state);

		const hpPct = pokemon.maxhp > 0 ? Math.round((pokemon.hp / pokemon.maxhp) * 100) : 0;
		battle.add('-message', `${pokemon.name} was transferred in with ${hpPct}% HP!`);

		if (switchIn) {
			const emptySlot = battleSide.active.findIndex(p => !p || p.fainted);
			if (emptySlot >= 0) battle.actions.switchIn(pokemon, emptySlot);
		}

		return { success: true, transferredPokemon: state };
	}

	forceSwitch(battleId, side, benchPosition) {
		const battle = this.getBattle(battleId);
		const battleSide = battle[side];
		if (!battleSide) return false;

		const benchPokemon = battleSide.pokemon[benchPosition];
		if (!benchPokemon || benchPokemon.fainted || benchPokemon.isActive) return false;

		const emptySlot = battleSide.active.findIndex(p => !p || p.fainted);
		if (emptySlot < 0) return false;

		battle.actions.switchIn(benchPokemon, emptySlot);
		return true;
	}

	hasEnded(battleId) {
		return this.battles.get(battleId)?.ended ?? true;
	}

	getWinner(battleId) {
		return this.battles.get(battleId)?.winner;
	}

	destroyAll() {
		for (const [id, battle] of this.battles) {
			battle.destroy();
		}
		this.battles.clear();
		this.battleLogs.clear();
	}
}

// ============== DISPLAY FUNCTIONS ==============

function displayBattleState(manager, battleId) {
	const battle = manager.battles.get(battleId);
	if (!battle) {
		console.log(`  Battle "${battleId}" not found.`);
		return;
	}

	const state = battle.requestState || 'none';
	const turnLabel = battle.ended
		? `ENDED (Winner: ${battle.winner || 'Tie'})`
		: `Turn ${battle.turn} [${state}]`;

	console.log(`\n╔══════════════════════════════════════╗`);
	console.log(`║  ${battleId.toUpperCase().padEnd(15)} ${turnLabel.padEnd(20)} ║`);
	console.log(`╠══════════════════════════════════════╣`);

	for (const sideId of ['p1', 'p2']) {
		const side = battle[sideId];
		if (!side) continue;

		console.log(`║  ${sideId.toUpperCase()} - ${side.name} (${side.pokemonLeft} alive)`);

		// Active Pokemon
		for (let i = 0; i < side.active.length; i++) {
			const pokemon = side.active[i];
			if (!pokemon) {
				console.log(`║    Active: (empty slot)`);
				continue;
			}
			if (pokemon.fainted) {
				console.log(`║    Active: ${pokemon.name} - FAINTED`);
				continue;
			}

			const hpBar = makeHPBar(pokemon.hp, pokemon.maxhp);
			const statusStr = pokemon.status ? ` [${pokemon.status.toUpperCase()}]` : '';
			const boosts = formatBoosts(pokemon.boosts);
			const boostStr = boosts ? ` ${boosts}` : '';
			const volStr = Object.keys(pokemon.volatiles).length > 0
				? ` {${Object.keys(pokemon.volatiles).join(',')}}`
				: '';

			console.log(`║  ► ${pokemon.name} (${pokemon.species.name}) Lv${pokemon.level}`);
			console.log(`║    HP: ${hpBar} ${pokemon.hp}/${pokemon.maxhp}${statusStr}${boostStr}${volStr}`);

			// Show moves with PP
			const moveStr = pokemon.moveSlots
				.map((m, idx) => `${idx + 1}:${m.move}(${m.pp}/${m.maxpp})`)
				.join('  ');
			console.log(`║    Moves: ${moveStr}`);
			console.log(`║    Item: ${pokemon.item || 'none'} | Ability: ${pokemon.ability}`);
		}

		// Bench Pokemon
		const bench = side.pokemon.filter(p => !p.isActive && !p.fainted);
		for (const [i, pokemon] of bench.entries()) {
			const hpPct = Math.round((pokemon.hp / pokemon.maxhp) * 100);
			const teamIdx = side.pokemon.indexOf(pokemon) + 1;
			console.log(`║    Bench [${teamIdx}]: ${pokemon.name} (${pokemon.species.name}) ${hpPct}% HP`);
		}

		// Fainted Pokemon
		const fainted = side.pokemon.filter(p => p.fainted);
		for (const pokemon of fainted) {
			const teamIdx = side.pokemon.indexOf(pokemon) + 1;
			console.log(`║    Dead  [${teamIdx}]: ${pokemon.name} (${pokemon.species.name})`);
		}

		console.log(`║`);
	}
	console.log(`╚══════════════════════════════════════╝`);
}

function makeHPBar(hp, maxhp) {
	const width = 20;
	const filled = Math.round((hp / maxhp) * width);
	const pct = Math.round((hp / maxhp) * 100);
	const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
	return `[${bar}] ${pct}%`;
}

function formatBoosts(boosts) {
	const parts = [];
	for (const [stat, val] of Object.entries(boosts)) {
		if (val !== 0) parts.push(`${stat}:${val > 0 ? '+' : ''}${val}`);
	}
	return parts.length > 0 ? `(${parts.join(' ')})` : '';
}

function displayTransferState(state) {
	console.log(`\n  Transfer State: ${state.set.name || state.species}`);
	console.log(`  HP: ${state.hp}/${state.maxhp} (${Math.round((state.hp / state.maxhp) * 100)}%)`);
	console.log(`  Status: ${state.status || 'none'}`);
	const boosts = formatBoosts(state.boosts);
	if (boosts) console.log(`  Boosts: ${boosts}`);
	const vols = Object.keys(state.volatiles);
	if (vols.length) console.log(`  Volatiles: ${vols.join(', ')}`);
	console.log(`  Moves: ${state.moveSlots.map(m => `${m.move}(${m.pp}/${m.maxpp})`).join(', ')}`);
}

function displayHelp() {
	console.log(`
╔══════════════════════════════════════════════════════════════╗
║                     AVAILABLE COMMANDS                       ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  BATTLE MANAGEMENT                                           ║
║    list                  - List all battles                   ║
║    show <battle>         - Show battle state                  ║
║    show all              - Show all battle states              ║
║    create <id> <format>  - Create a battle (e.g. gen9ou)      ║
║    start <battle>        - Start a battle (handle team preview)║
║                                                              ║
║  MAKING MOVES                                                ║
║    <battle> <side> move <name|number>                        ║
║    <battle> <side> switch <number>                           ║
║    <battle> <side> auto                                      ║
║      Examples:                                               ║
║        battle1 p1 move thunderbolt                           ║
║        battle1 p1 move 1                                     ║
║        battle1 p2 switch 2                                   ║
║        battle1 p1 auto                                       ║
║                                                              ║
║  POKEMON TRANSFER                                            ║
║    inspect <battle> <side>       - View active Pokemon state  ║
║    extract <battle> <side>       - Remove active Pokemon      ║
║    receive <battle> <side>       - Add last extracted Pokemon  ║
║    transfer <from> <side> <to> <side>  - Extract + Receive    ║
║    forcesw <battle> <side> <pos> - Force switch-in from bench ║
║                                                              ║
║  OTHER                                                       ║
║    help                  - Show this help                     ║
║    quit / exit           - Exit                               ║
╚══════════════════════════════════════════════════════════════╝
`);
}

// ============== SAMPLE TEAMS ==============

const TEAMS = {
	electric: [
		{
			name: 'Sparky', species: 'Pikachu', ability: 'Static', item: 'Light Ball',
			moves: ['Thunderbolt', 'Volt Tackle', 'Iron Tail', 'Quick Attack'],
			nature: 'Jolly', gender: 'M', level: 50,
			evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
		},
		{
			name: 'Sparks', species: 'Jolteon', ability: 'Volt Absorb', item: 'Choice Specs',
			moves: ['Thunderbolt', 'Shadow Ball', 'Volt Switch', 'Hidden Power Ice'],
			nature: 'Timid', gender: 'M', level: 50,
			evs: { hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 },
		},
	],
	fire: [
		{
			name: 'Blaze', species: 'Charizard', ability: 'Blaze', item: 'Charcoal',
			moves: ['Flamethrower', 'Air Slash', 'Dragon Pulse', 'Roost'],
			nature: 'Timid', gender: 'M', level: 50,
			evs: { hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 },
		},
		{
			name: 'Growler', species: 'Arcanine', ability: 'Intimidate', item: 'Leftovers',
			moves: ['Flare Blitz', 'Wild Charge', 'Extreme Speed', 'Close Combat'],
			nature: 'Adamant', gender: 'M', level: 50,
			evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
		},
	],
	grass: [
		{
			name: 'Leafy', species: 'Venusaur', ability: 'Overgrow', item: 'Black Sludge',
			moves: ['Giga Drain', 'Sludge Bomb', 'Sleep Powder', 'Leech Seed'],
			nature: 'Bold', gender: 'F', level: 50,
			evs: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 },
		},
		{
			name: 'Sandy', species: 'Sandslash', ability: 'Sand Rush', item: 'Focus Sash',
			moves: ['Earthquake', 'Stone Edge', 'Swords Dance', 'Rapid Spin'],
			nature: 'Adamant', gender: 'M', level: 50,
			evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
		},
	],
	water: [
		{
			name: 'Shell', species: 'Blastoise', ability: 'Torrent', item: 'Leftovers',
			moves: ['Hydro Pump', 'Ice Beam', 'Rapid Spin', 'Aura Sphere'],
			nature: 'Modest', gender: 'M', level: 50,
			evs: { hp: 252, atk: 0, def: 4, spa: 252, spd: 0, spe: 0 },
		},
		{
			name: 'Fang', species: 'Gyarados', ability: 'Intimidate', item: 'Sitrus Berry',
			moves: ['Waterfall', 'Earthquake', 'Dragon Dance', 'Ice Fang'],
			nature: 'Adamant', gender: 'M', level: 50,
			evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
		},
	],
};

// ============== INTERACTIVE CLI ==============

async function main() {
	const manager = new MultiBattleManager();
	let lastExtractedState = null;

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	const prompt = () => new Promise(resolve => rl.question('\n> ', resolve));

	console.log('========================================');
	console.log('  MULTI-BATTLE INTERACTIVE TEST');
	console.log('========================================');
	console.log('\nAvailable team names: electric, fire, grass, water');

	// Auto-create two starter battles
	console.log('\nSetting up two default battles...');

	manager.createBattle('b1', {
		formatid: 'gen9ou',
		p1: { name: 'Alice', team: TEAMS.electric },
		p2: { name: 'Bob', team: TEAMS.grass },
	});
	manager.startBattle('b1');

	manager.createBattle('b2', {
		formatid: 'gen9ou',
		p1: { name: 'Charlie', team: TEAMS.fire },
		p2: { name: 'Diana', team: TEAMS.water },
	});
	manager.startBattle('b2');

	console.log('\nBattles "b1" and "b2" created and started!');
	displayHelp();
	displayBattleState(manager, 'b1');
	displayBattleState(manager, 'b2');

	// Main loop
	while (true) {
		const input = (await prompt()).trim();
		if (!input) continue;

		const parts = input.split(/\s+/);
		const cmd = parts[0].toLowerCase();

		try {
			// ---- QUIT ----
			if (cmd === 'quit' || cmd === 'exit') {
				console.log('Cleaning up...');
				manager.destroyAll();
				rl.close();
				break;
			}

			// ---- HELP ----
			if (cmd === 'help') {
				displayHelp();
				continue;
			}

			// ---- LIST ----
			if (cmd === 'list') {
				console.log('\nBattles:');
				for (const [id, battle] of manager.battles) {
					const status = battle.ended
						? `ENDED (Winner: ${battle.winner || 'Tie'})`
						: `Turn ${battle.turn} [${battle.requestState || 'none'}]`;
					console.log(`  ${id}: ${battle.p1.name} vs ${battle.p2.name} - ${status}`);
				}
				continue;
			}

			// ---- SHOW ----
			if (cmd === 'show') {
				if (parts[1] === 'all') {
					for (const id of manager.battles.keys()) {
						displayBattleState(manager, id);
					}
				} else if (parts[1]) {
					displayBattleState(manager, parts[1]);
				} else {
					console.log('  Usage: show <battleId> | show all');
				}
				continue;
			}

			// ---- CREATE ----
			if (cmd === 'create') {
				const id = parts[1];
				const format = parts[2] || 'gen9ou';
				if (!id) {
					console.log('  Usage: create <id> <format>');
					console.log('  Then use: setplayer <id> p1 <name> <teamname>');
					continue;
				}
				manager.createBattle(id, { formatid: format });
				console.log(`  Created battle "${id}" with format ${format}`);
				console.log(`  Set players with: setplayer ${id} p1 <name> <teamname>`);
				continue;
			}

			// ---- SETPLAYER ----
			if (cmd === 'setplayer') {
				const [, battleId, sideId, name, teamName] = parts;
				if (!battleId || !sideId || !name || !teamName) {
					console.log('  Usage: setplayer <battle> <p1|p2> <name> <teamname>');
					console.log('  Teams: electric, fire, grass, water');
					continue;
				}
				const team = TEAMS[teamName];
				if (!team) {
					console.log(`  Unknown team "${teamName}". Available: ${Object.keys(TEAMS).join(', ')}`);
					continue;
				}
				manager.setPlayer(battleId, sideId, { name, team });
				console.log(`  Set ${sideId} to ${name} with ${teamName} team`);
				continue;
			}

			// ---- START ----
			if (cmd === 'start') {
				const battleId = parts[1];
				if (!battleId) {
					console.log('  Usage: start <battle>');
					continue;
				}
				manager.startBattle(battleId);
				console.log(`  Battle "${battleId}" started!`);
				displayBattleState(manager, battleId);
				continue;
			}

			// ---- INSPECT ----
			if (cmd === 'inspect') {
				const [, battleId, sideId] = parts;
				if (!battleId || !sideId) {
					console.log('  Usage: inspect <battle> <p1|p2>');
					continue;
				}
				const battle = manager.getBattle(battleId);
				const side = battle[sideId];
				if (!side) {
					console.log(`  Invalid side "${sideId}"`);
					continue;
				}
				const pokemon = side.active[0];
				if (!pokemon || pokemon.fainted) {
					console.log(`  No active (alive) Pokemon on ${sideId}`);
					continue;
				}
				const state = manager.capturePokemonState(pokemon);
				displayTransferState(state);
				continue;
			}

			// ---- EXTRACT ----
			if (cmd === 'extract') {
				const [, battleId, sideId] = parts;
				if (!battleId || !sideId) {
					console.log('  Usage: extract <battle> <p1|p2>');
					continue;
				}
				const result = manager.extractPokemon(battleId, sideId, 0);
				if (result.success) {
					lastExtractedState = result.state;
					console.log(`  Extracted ${result.state.set.name}!`);
					displayTransferState(result.state);
					console.log('\n  Use "receive <battle> <side>" to place it, or "transfer" for one step.');
				} else {
					console.log(`  Failed: ${result.error}`);
				}
				displayBattleState(manager, battleId);
				continue;
			}

			// ---- RECEIVE ----
			if (cmd === 'receive') {
				const [, battleId, sideId] = parts;
				if (!battleId || !sideId) {
					console.log('  Usage: receive <battle> <p1|p2>');
					continue;
				}
				if (!lastExtractedState) {
					console.log('  No Pokemon has been extracted yet. Use "extract" first.');
					continue;
				}
				const result = manager.receivePokemon(battleId, sideId, lastExtractedState, false);
				if (result.success) {
					const battle = manager.getBattle(battleId);
					const side = battle[sideId];
					const teamIdx = side.pokemon.length;
					console.log(`  Received ${lastExtractedState.set.name} onto ${sideId}'s bench!`);
					console.log(`  Team position: ${teamIdx}. Use "switch ${teamIdx}" to send it out.`);
					lastExtractedState = null;
				} else {
					console.log(`  Failed: ${result.error}`);
				}
				displayBattleState(manager, battleId);
				continue;
			}

			// ---- TRANSFER (one-step) ----
			if (cmd === 'transfer') {
				const [, fromBattle, fromSide, toBattle, toSide] = parts;
				if (!fromBattle || !fromSide || !toBattle || !toSide) {
					console.log('  Usage: transfer <fromBattle> <fromSide> <toBattle> <toSide>');
					console.log('  Example: transfer b1 p1 b2 p2');
					continue;
				}

				const extractResult = manager.extractPokemon(fromBattle, fromSide, 0);
				if (!extractResult.success) {
					console.log(`  Extract failed: ${extractResult.error}`);
					continue;
				}

				console.log(`  Extracted ${extractResult.state.set.name} from ${fromBattle} ${fromSide}`);

				const receiveResult = manager.receivePokemon(toBattle, toSide, extractResult.state, false);
				if (receiveResult.success) {
					const battle = manager.getBattle(toBattle);
					const side = battle[toSide];
					console.log(`  Received onto ${toBattle} ${toSide}'s bench (position ${side.pokemon.length})`);
					displayTransferState(extractResult.state);
				} else {
					console.log(`  Receive failed: ${receiveResult.error}`);
					lastExtractedState = extractResult.state;
					console.log(`  Pokemon saved. Use "receive" to try again.`);
				}

				displayBattleState(manager, fromBattle);
				displayBattleState(manager, toBattle);
				continue;
			}

			// ---- FORCESW ----
			if (cmd === 'forcesw') {
				const [, battleId, sideId, posStr] = parts;
				if (!battleId || !sideId || !posStr) {
					console.log('  Usage: forcesw <battle> <side> <teamPosition>');
					console.log('  Position is 1-based team index shown in brackets.');
					continue;
				}
				const pos = parseInt(posStr) - 1;
				const result = manager.forceSwitch(battleId, sideId, pos);
				console.log(`  Force switch: ${result ? 'Success' : 'Failed'}`);
				displayBattleState(manager, battleId);
				continue;
			}

			// ---- BATTLE CHOICES (battleId sideId move/switch/auto ...) ----
			const battleId = parts[0];
			const sideId = parts[1];
			const choiceType = parts[2];

			if (!manager.battles.has(battleId)) {
				console.log(`  Unknown command or battle "${battleId}". Type "help" for commands.`);
				continue;
			}

			if (!sideId || !choiceType) {
				console.log(`  Usage: ${battleId} <p1|p2> <move|switch|auto> [args]`);
				console.log(`  Examples:`);
				console.log(`    ${battleId} p1 move thunderbolt`);
				console.log(`    ${battleId} p1 move 1`);
				console.log(`    ${battleId} p2 switch 2`);
				console.log(`    ${battleId} p1 auto`);
				continue;
			}

			// Build the choice string
			let choiceStr;
			if (choiceType === 'auto') {
				const battle = manager.getBattle(battleId);
				const side = battle.getSide(sideId);
				side.autoChoose();
				if (battle.allChoicesDone()) {
					battle.commitChoices();
					// Handle post-turn forced switches
					let safety = 0;
					while (battle.requestState === 'switch' && !battle.ended && safety++ < 10) {
						break; // Let user handle switches
					}
				}
				console.log(`  ${sideId} auto-chose.`);
				displayBattleState(manager, battleId);
				continue;
			} else {
				const rest = parts.slice(3).join(' ');
				choiceStr = `${choiceType}${rest ? ' ' + rest : ''}`;
			}

			const result = manager.submitChoice(battleId, sideId, choiceStr);
			if (result === true) {
				const battle = manager.getBattle(battleId);
				// Check if we need the other side's choice still
				const otherSide = sideId === 'p1' ? 'p2' : 'p1';
				const otherSideObj = battle.getSide(otherSide);
				if (otherSideObj.requestState && !otherSideObj.isChoiceDone()) {
					console.log(`  ${sideId} choice accepted. Waiting for ${otherSide}...`);
				} else {
					console.log(`  Turn resolved!`);
				}
				displayBattleState(manager, battleId);
			} else {
				console.log(`  Choice failed: ${result}`);
				// Show what moves/switches are available
				const battle = manager.getBattle(battleId);
				const side = battle.getSide(sideId);
				if (side.requestState === 'move') {
					const pokemon = side.active[0];
					if (pokemon && !pokemon.fainted) {
						console.log(`  Available moves for ${pokemon.name}:`);
						pokemon.moveSlots.forEach((m, i) => {
							const dis = m.disabled ? ' (DISABLED)' : '';
							console.log(`    ${i + 1}: ${m.move} (${m.pp}/${m.maxpp} PP)${dis}`);
						});
					}
				}
				if (side.requestState === 'switch') {
					console.log(`  Available switches:`);
					side.pokemon.forEach((p, i) => {
						if (!p.isActive && !p.fainted) {
							console.log(`    ${i + 1}: ${p.name} (${Math.round((p.hp / p.maxhp) * 100)}% HP)`);
						}
					});
				}
			}
		} catch (e) {
			console.log(`  Error: ${e.message}`);
		}
	}
}

main().catch(console.error);