/**
 * Helper utilities for game state management
 */

function ensureSet(s) {
	return {
		name: s.name || s.species || '',
		species: s.species || s.name || '',
		item: s.item || '',
		ability: s.ability || '',
		moves: s.moves || [],
		nature: s.nature || '',
		gender: s.gender || '',
		evs: { hp:0, atk:0, def:0, spa:0, spd:0, spe:0, ...(s.evs || {}) },
		ivs: { hp:31, atk:31, def:31, spa:31, spd:31, spe:31, ...(s.ivs || {}) },
		level: s.level || 100,
		shiny: s.shiny,
		happiness: s.happiness,
		teraType: s.teraType,
	};
}

function parseBody(req) {
	return new Promise((resolve, reject) => {
		let body = '';
		req.on('data', c => body += c);
		req.on('end', () => {
			try { resolve(JSON.parse(body)); }
			catch (e) { reject(e); }
		});
	});
}

function deepClone(obj) { 
	return JSON.parse(JSON.stringify(obj)); 
}

module.exports = {
	ensureSet,
	parseBody,
	deepClone,
};