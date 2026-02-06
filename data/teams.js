/**
 * Sample team definitions
 */

const TEAMS = {
	electric: [
		{ name:'Sparky', species:'Pikachu', ability:'Static', item:'Light Ball',
		  moves:['Thunderbolt','Volt Tackle','Iron Tail','Quick Attack'],
		  nature:'Jolly', gender:'M', level:50,
		  evs:{ hp:4, atk:252, spe:252 } },
		{ name:'Sparks', species:'Jolteon', ability:'Volt Absorb', item:'Choice Specs',
		  moves:['Thunderbolt','Shadow Ball','Volt Switch','Hidden Power'],
		  nature:'Timid', gender:'M', level:50,
		  evs:{ hp:4, spa:252, spe:252 } },
	],
	fire: [
		{ name:'Blaze', species:'Charizard', ability:'Blaze', item:'Charcoal',
		  moves:['Flamethrower','Air Slash','Dragon Pulse','Roost'],
		  nature:'Timid', gender:'M', level:50,
		  evs:{ hp:4, spa:252, spe:252 } },
		{ name:'Growler', species:'Arcanine', ability:'Intimidate', item:'Leftovers',
		  moves:['Flare Blitz','Wild Charge','Extreme Speed','Close Combat'],
		  nature:'Adamant', gender:'M', level:50,
		  evs:{ hp:4, atk:252, spe:252 } },
	],
	grass: [
		{ name:'Leafy', species:'Venusaur', ability:'Overgrow', item:'Black Sludge',
		  moves:['Giga Drain','Sludge Bomb','Sleep Powder','Leech Seed'],
		  nature:'Bold', gender:'F', level:50,
		  evs:{ hp:252, def:252, spd:4 } },
		{ name:'Sandy', species:'Sandslash', ability:'Sand Rush', item:'Focus Sash',
		  moves:['Earthquake','Stone Edge','Swords Dance','Rapid Spin'],
		  nature:'Adamant', gender:'M', level:50,
		  evs:{ hp:4, atk:252, spe:252 } },
	],
	water: [
		{ name:'Shell', species:'Blastoise', ability:'Torrent', item:'Leftovers',
		  moves:['Hydro Pump','Ice Beam','Rapid Spin','Aura Sphere'],
		  nature:'Modest', gender:'M', level:50,
		  evs:{ hp:252, spa:252, def:4 } },
		{ name:'Fang', species:'Gyarados', ability:'Intimidate', item:'Sitrus Berry',
		  moves:['Waterfall','Earthquake','Dragon Dance','Ice Fang'],
		  nature:'Adamant', gender:'M', level:50,
		  evs:{ hp:4, atk:252, spe:252 } },
	],
};

module.exports = { TEAMS };