/**
 * Multi-Battle Manager with Timeline Branching
 *
 * Coordinates   Timeline X, Turn Y  →  displayed as "X-Y"
 * Global ID     "matchId:timelineNum"  →  opaque to the client, parsed server-side
 */

const crypto = require('crypto');
const { Battle } = require('../dist/sim/battle');
const { Dex }    = require('../dist/sim/dex');
const { Teams }  = require('../dist/sim/teams');
const { Match }  = require('./Match');
const { ensureSet, deepClone } = require('./helpers');

class MultiBattleManager {
	constructor() {
		this.matches = new Map();   // matchId → Match
	}

	// ── id helpers ──────────────────────────────────────────
	static _generateMatchId() {
		return crypto.randomBytes(4).toString('hex');   // 8 hex chars
	}

	/**
	 * "matchId:num"  →  { match, timeline }  |  null
	 */
	parseGlobalId(globalId) {
		if (!globalId || typeof globalId !== 'string') return null;

		const sep = globalId.lastIndexOf(':');
		if (sep === -1) return null;

		const matchId = globalId.slice(0, sep);
		const num     = parseInt(globalId.slice(sep + 1), 10);
		if (isNaN(num)) return null;

		const match    = this.matches.get(matchId);
		if (!match)    return null;

		const timeline = match.timelines.get(num);
		if (!timeline) return null;

		return { match, timeline };
	}

	// ── match + root timeline creation ──────────────────────
	/**
	 * Create a Match and wire its root Timeline (num = 1).
	 * Call  startTimeline(timeline)  afterwards to begin play.
	 */
	createMatch(opts) {
		const formatid = opts.formatid || 'gen9ou';
		const matchId  = MultiBattleManager._generateMatchId();

		const match = new Match(matchId, formatid, {
			p1: { name: opts.p1.name, team: opts.p1.team },
			p2: { name: opts.p2.name, team: opts.p2.team },
		});
		this.matches.set(matchId, match);

		const timeline = this._wireTimeline(match);   // root – no parent
		return { match, timeline };
	}

	// ── timeline wiring ─────────────────────────────────────
	/**
	 * Allocate a Timeline in *match*, create its Battle instance,
	 * and set both players from the match's stored teams.
	 * Caller is responsible for init / state-stamp / snapshot.
	 */
	_wireTimeline(match, parentNum = null, fromTurn = null) {
		const timeline = match.allocTimeline(parentNum, fromTurn);

		timeline.battle = new Battle({
			formatid: match.formatid,
			format  : Dex.formats.get(match.formatid),
			send    : (type, data) => {
				if (Array.isArray(data)) timeline.rawLogs.push(...data);
				else                     timeline.rawLogs.push(data);
			},
		});

		for (const sideId of ['p1', 'p2']) {
			let team = match.originalTeams[sideId].team;
			if (Array.isArray(team)) team = Teams.pack(team.map(ensureSet));
			timeline.battle.setPlayer(sideId, {
				name: match.originalTeams[sideId].name,
				team,
			});
		}

		return timeline;
	}

	// ── init helpers ────────────────────────────────────────
	/**
	 * Burn through Showdown's mandatory lead-select phase so the
	 * battle lands on  requestState === 'move'.
	 * Does NOT capture a snapshot – that is the caller's job.
	 */
	_initBattle(timeline) {
		const battle = timeline.battle;
		let safety = 0;
		while (battle.requestState && battle.requestState !== 'move' && !battle.ended) {
			if (safety++ > 10) throw new Error('_initBattle stuck');
			for (const side of battle.sides) {
				if (!side.isChoiceDone()) side.autoChoose();
			}
			if (battle.allChoicesDone()) battle.commitChoices();
		}
	}

	/**
	 * Full start for a freshly-created root timeline.
	 */
	startTimeline(timeline) {
		this._initBattle(timeline);
		this.captureTurnSnapshot(timeline);
	}

	// ── snapshots ───────────────────────────────────────────
	captureTurnSnapshot(timeline) {
		const battle = timeline.battle;
		if (!battle || timeline.snapshots.has(battle.turn)) return;

		timeline.snapshots.set(battle.turn, {
			turn      : battle.turn,
			timestamp : Date.now(),
			formatid  : battle.format?.id || 'gen9ou',
			sides     : {
				p1: this._captureSideSnapshot(battle.p1),
				p2: this._captureSideSnapshot(battle.p2),
			},
			field     : this._captureFieldSnapshot(battle),
		});
	}

	_captureSideSnapshot(side) {
		if (!side) return null;
		return {
			name           : side.name,
			pokemon        : side.pokemon.map(p => this._capturePokemonState(p)),
			pokemonLeft    : side.pokemonLeft,
			sideConditions : deepClone(side.sideConditions || {}),
			activeIndices  : side.active.map(p => p ? side.pokemon.indexOf(p) : -1),
		};
	}

	_captureFieldSnapshot(battle) {
		if (!battle.field) return {};
		return {
			weather       : battle.field.weather       || '',
			weatherState  : deepClone(battle.field.weatherState  || {}),
			terrain       : battle.field.terrain       || '',
			terrainState  : deepClone(battle.field.terrainState  || {}),
			pseudoWeather : deepClone(battle.field.pseudoWeather || {}),
		};
	}

	_capturePokemonState(pokemon) {
		if (!pokemon) return null;
		const volatiles = {};
		for (const vid in pokemon.volatiles) {
			volatiles[vid] = { ...pokemon.volatiles[vid] };
			delete volatiles[vid].target;
		}
		return {
			set           : deepClone(pokemon.set),
			hp            : pokemon.hp,
			maxhp         : pokemon.maxhp,
			status        : pokemon.status,
			statusState   : deepClone(pokemon.statusState   || {}),
			boosts        : { ...pokemon.boosts },
			volatiles,
			moveSlots     : pokemon.moveSlots.map(s => ({
				id: s.id, move: s.move, pp: s.pp, maxpp: s.maxpp,
				target: s.target, disabled: s.disabled, used: s.used,
			})),
			ability       : pokemon.ability,
			abilityState  : deepClone(pokemon.abilityState  || {}),
			item          : pokemon.item,
			itemState     : deepClone(pokemon.itemState     || {}),
			lastItem      : pokemon.lastItem,
			timesAttacked : pokemon.timesAttacked,
			lastDamage    : pokemon.lastDamage,
			species       : pokemon.species?.id,
			types         : [...(pokemon.types || [])],
			addedType     : pokemon.addedType,
			transformed   : pokemon.transformed,
			isActive      : pokemon.isActive,
			fainted       : pokemon.fainted,
		};
	}

	_applyPokemonState(pokemon, state) {
		if (!pokemon || !state) return;
		pokemon.hp = Math.min(state.hp, pokemon.maxhp);

		if (state.status && state.status !== '') {
			pokemon.setStatus(state.status);
			for (const k in state.statusState) {
				if (k !== 'id' && k !== 'target')
					pokemon.statusState[k] = state.statusState[k];
			}
		}

		pokemon.boosts = { ...state.boosts };

		const skipV = new Set([
			'mustrecharge','lockedmove','twoturnmove','choicelock',
			'flinch','destinybond','grudge','endure','stall','gem',
			'roost','protect','quickguard','wideguard',
		]);
		for (const vid in state.volatiles) {
			if (skipV.has(vid)) continue;
			pokemon.volatiles[vid] = { ...state.volatiles[vid], target: pokemon };
		}

		for (const ss of state.moveSlots) {
			for (const ps of pokemon.moveSlots) {
				if (ps.id === ss.id) { ps.pp = ss.pp; ps.used = ss.used; break; }
			}
		}

		pokemon.timesAttacked = state.timesAttacked;
		pokemon.lastDamage    = state.lastDamage;
		if (state.addedType)  pokemon.addedType = state.addedType;
	}

	// ── transfer targets ────────────────────────────────────
	/**
	 * All valid past-turn coordinates a pokemon can travel to.
	 * Pass matchId to restrict to one match (multiplayer view);
	 * omit for the global manager view.
	 */
	getTransferTargets(matchId = null) {
		const targets = [];

		const matchList = (matchId && this.matches.has(matchId))
			? [this.matches.get(matchId)]
			: [...this.matches.values()];

		for (const match of matchList) {
			for (const [, timeline] of match.timelines) {
				if (timeline.battle.ended) continue;

				for (const [turn, snapshot] of timeline.snapshots) {
					if (turn >= timeline.battle.turn) continue;

					const p1s = snapshot.sides.p1;
					const p2s = snapshot.sides.p2;
					const p1Active = p1s?.pokemon[p1s?.activeIndices?.[0] ?? 0] || null;
					const p2Active = p2s?.pokemon[p2s?.activeIndices?.[0] ?? 0] || null;

					targets.push({
						timelineId  : timeline.globalId,
						timelineNum : timeline.num,
						turn,
						coordinate  : `${timeline.num}-${turn}`,
						p1Active: p1Active ? {
							name    : p1Active.set?.name || p1Active.set?.species,
							species : p1Active.species,
							hp      : p1Active.hp,
							maxhp   : p1Active.maxhp,
						} : null,
						p2Active: p2Active ? {
							name    : p2Active.set?.name || p2Active.set?.species,
							species : p2Active.species,
							hp      : p2Active.hp,
							maxhp   : p2Active.maxhp,
						} : null,
					});
				}
			}
		}

		targets.sort((a, b) =>
			a.timelineNum !== b.timelineNum
				? a.timelineNum - b.timelineNum
				: a.turn - b.turn
		);
		return targets;
	}

	// ── queue a transfer ────────────────────────────────────
	queueTransfer(sourceGlobalId, side, targetGlobalId, targetTurn) {
		const src = this.parseGlobalId(sourceGlobalId);
		if (!src) return { success: false, error: 'Source timeline not found' };

		const srcTL  = src.timeline;
		const battle = srcTL.battle;

		if (battle.ended)
			return { success: false, error: 'Battle ended' };
		if (battle.requestState !== 'move')
			return { success: false, error: 'Can only transfer during move phase' };

		// target must exist and belong to the same match
		const tgt = this.parseGlobalId(targetGlobalId);
		if (!tgt)
			return { success: false, error: 'Target timeline not found' };
		if (tgt.match.id !== src.match.id)
			return { success: false, error: 'Cannot transfer between different matches' };

		const tgtTL = tgt.timeline;
		if (!tgtTL.snapshots.has(targetTurn))
			return { success: false, error: 'Target turn snapshot not found' };
		if (targetTurn >= tgtTL.battle.turn)
			return { success: false, error: 'Can only transfer to past turns' };

		const sideObj = battle[side];
		const pokemon = sideObj.active[0];
		if (!pokemon || pokemon.fainted)
			return { success: false, error: 'No active Pokémon to transfer' };

		const pokemonState = this._capturePokemonState(pokemon);
		pokemonState.sourceTurn        = battle.turn;
		pokemonState.sourceTimelineNum = srcTL.num;

		srcTL.pendingTransfers[side] = {
			targetGlobalId,
			targetTurn,
			pokemonState,
			side,
			targetCoord: `${tgtTL.num}-${targetTurn}`,
		};

		return {
			success     : true,
			queued      : true,
			pokemonName : pokemon.name,
			targetCoord : `${tgtTL.num}-${targetTurn}`,
		};
	}

	// ── choice submission ───────────────────────────────────
	submitChoice(globalId, sideId, choiceStr) {
		const parsed = this.parseGlobalId(globalId);
		if (!parsed) return 'Timeline not found';

		const timeline = parsed.timeline;
		const battle   = timeline.battle;

		if (battle.ended)     return 'Battle ended';

		const side = battle.getSide(sideId);
		if (!side.requestState)  return `${sideId} has no pending request`;
		if (side.isChoiceDone()) return `${sideId} already chose`;

		const ok = side.choose(choiceStr);
		if (!ok) return side.choice.error || 'Invalid choice';

		if (battle.allChoicesDone()) {
			const turnBefore = battle.turn;
			battle.commitChoices();
			this._autoHandleForcedSwitches(timeline);

			if (battle.turn !== turnBefore || battle.ended) {
				this.captureTurnSnapshot(timeline);
				this._flushPendingTransfers(timeline);
			}
		}
		return true;
	}

	_autoHandleForcedSwitches(timeline) {
		const battle = timeline.battle;
		if (!battle || battle.requestState !== 'switch' || battle.ended) return;

		for (const side of battle.sides) {
			if (side.requestState !== 'switch') continue;
			if (!side.isChoiceDone()) side.autoChoose();
		}
		if (battle.allChoicesDone()) {
			battle.commitChoices();
			this._autoHandleForcedSwitches(timeline);   // chained switches
		}
	}

	// ── flush pending transfers ─────────────────────────────
	_flushPendingTransfers(timeline) {
		const pending = timeline.pendingTransfers;

		const transfers = [];
		for (const side of ['p1', 'p2']) {
			if (pending[side]) { transfers.push(pending[side]); pending[side] = null; }
		}
		if (!transfers.length) return;

		const battle = timeline.battle;

		// group by destination – same target = one branch
		const byTarget = new Map();
		for (const t of transfers) {
			const key = `${t.targetGlobalId}:${t.targetTurn}`;
			if (!byTarget.has(key)) byTarget.set(key, []);
			byTarget.get(key).push(t);
		}

		for (const [, group] of byTarget) {
			// remove each pokemon from the source timeline
			for (const t of group) {
				const sideObj = battle[t.side];
				const pokemon = sideObj.active[0];
				if (!pokemon || pokemon.fainted) continue;

				battle.add('-message', `${pokemon.name} traveled to ${t.targetCoord}!`);
				pokemon.fainted     = true;
				pokemon.faintQueued = true;
				pokemon.hp          = 0;
				pokemon.isActive    = false;
				pokemon.status      = 'fnt';
				sideObj.pokemonLeft--;
				sideObj.active[0]   = null;

				const bench = sideObj.pokemon.find(p => !p.isActive && !p.fainted);
				if (bench) {
					sideObj.pokemon.splice(sideObj.pokemon.indexOf(bench), 1);
					sideObj.pokemon.unshift(bench);
					bench.isActive    = true;
					bench.position    = 0;
					sideObj.active[0] = bench;
					battle.add('-message', `${bench.name} was sent out!`);
				} else if (sideObj.pokemonLeft <= 0) {
					battle.add('-message', `${sideObj.name} has no Pokémon left!`);
					battle.win(sideObj.foe);
				}
			}

			// create the branch
			const tgt = this.parseGlobalId(group[0].targetGlobalId);
			if (tgt) this._createBranch(tgt.timeline, group[0].targetTurn, group);
		}
	}

	// ── branch creation ─────────────────────────────────────
	_createBranch(sourceTimeline, sourceTurn, transferGroup) {
		const match    = sourceTimeline.match;
		const snapshot = sourceTimeline.snapshots.get(sourceTurn);
		if (!snapshot) throw new Error(
			`No snapshot: timeline ${sourceTimeline.num} turn ${sourceTurn}`);

		// 1.  wire a new timeline (allocates num, creates Battle, sets players)
		const newTL  = this._wireTimeline(match, sourceTimeline.num, sourceTurn);
		const battle = newTL.battle;

		// 2.  push past lead-selection
		this._initBattle(newTL);

		// 3.  stamp snapshot state onto the fresh battle
		for (const sideId of ['p1', 'p2']) {
			const sideSnap = snapshot.sides[sideId];
			const side     = battle[sideId];
			if (!sideSnap || !side) continue;

			for (let i = 0; i < Math.min(sideSnap.pokemon.length, side.pokemon.length); i++) {
				const ps = sideSnap.pokemon[i];
				const p  = side.pokemon[i];
				if (p && ps) {
					this._applyPokemonState(p, ps);
					if (ps.fainted) { p.fainted = true; p.hp = 0; p.status = 'fnt'; }
				}
			}

			if (sideSnap.sideConditions) {
				for (const [c, d] of Object.entries(sideSnap.sideConditions))
					side.sideConditions[c] = deepClone(d);
			}
			side.pokemonLeft = sideSnap.pokemonLeft;
		}

		// 4.  field
		if (snapshot.field) {
			if (snapshot.field.weather) {
				battle.field.weather      = snapshot.field.weather;
				battle.field.weatherState = deepClone(snapshot.field.weatherState);
			}
			if (snapshot.field.terrain) {
				battle.field.terrain      = snapshot.field.terrain;
				battle.field.terrainState = deepClone(snapshot.field.terrainState);
			}
			if (snapshot.field.pseudoWeather)
				battle.field.pseudoWeather = deepClone(snapshot.field.pseudoWeather);
		}

		// 5.  rewind turn counter to the branch point
		battle.turn = sourceTurn;

		// 6.  insert transferred Pokémon
		for (const t of transferGroup) {
			const dstSide = battle[t.side];
			const newMon  = dstSide.addPokemon(ensureSet(t.pokemonState.set));
			if (newMon) {
				this._applyPokemonState(newMon, t.pokemonState);
				dstSide.pokemonLeft++;
				const hpPct     = newMon.maxhp > 0
					? Math.round((newMon.hp / newMon.maxhp) * 100) : 0;
				const fromCoord = `${t.pokemonState.sourceTimelineNum}-${t.pokemonState.sourceTurn}`;
				battle.add('-message',
					`${newMon.name} arrived from ${fromCoord} with ${hpPct}% HP!`);
			}
		}

		battle.add('-message',
			`Timeline ${newTL.num} branched from ${sourceTimeline.num}-${sourceTurn}`);

		this.captureTurnSnapshot(newTL);
		console.log(`[Match ${match.id}] Timeline ${newTL.num} ← ${sourceTimeline.num}-${sourceTurn}`);
		return newTL;
	}

	// ── serialisation ───────────────────────────────────────

	/**
	 * Full state for the manager (no filter) or for one match
	 * (multiplayer).  Pass any globalId to restrict to its match.
	 */
	getFullState(filterGlobalId = null) {
		const result = { battles: {} };

		let matchList;
		if (filterGlobalId) {
			const p = this.parseGlobalId(filterGlobalId);
			matchList = p ? [p.match] : [];
		} else {
			matchList = [...this.matches.values()];
		}

		for (const match of matchList) {
			for (const [, timeline] of match.timelines) {
				result.battles[timeline.globalId] = this._serializeTimeline(timeline);
			}
		}
		return result;
	}

	_serializeTimeline(timeline) {
		const battle = timeline.battle;
		const match  = timeline.match;

		const data = {
			id              : timeline.globalId,
			timelineNum     : timeline.num,
			turn            : battle.turn,
			currentCoord    : `${timeline.num}-${battle.turn}`,
			requestState    : battle.requestState || '',
			ended           : battle.ended,
			winner          : battle.winner || null,
			sides           : {},
			lineage         : timeline.parentNum !== null ? {
				parentId          : `${match.id}:${timeline.parentNum}`,
				parentTimelineNum : timeline.parentNum,
				fromTurn          : timeline.fromTurn,
				fromCoord         : `${timeline.parentNum}-${timeline.fromTurn}`,
			} : null,
			turnHistory     : [],
			pendingTransfers: {
				p1: timeline.pendingTransfers.p1
					? { targetCoord: timeline.pendingTransfers.p1.targetCoord } : null,
				p2: timeline.pendingTransfers.p2
					? { targetCoord: timeline.pendingTransfers.p2.targetCoord } : null,
			},
		};

		// turn history from snapshots
		for (const [turn, snap] of timeline.snapshots) {
			const info = {
				turn,
				coord     : `${timeline.num}-${turn}`,
				timestamp : snap.timestamp,
				p1Active  : null,
				p2Active  : null,
			};
			for (const sid of ['p1', 'p2']) {
				const ss = snap.sides[sid];
				if (!ss) continue;
				const ap = ss.pokemon[ss.activeIndices?.[0] ?? 0];
				if (ap) info[sid + 'Active'] = {
					name   : ap.set?.name || ap.set?.species,
					species: ap.species,
					hp     : ap.hp,
					maxhp  : ap.maxhp,
					status : ap.status,
				};
			}
			data.turnHistory.push(info);
		}
		data.turnHistory.sort((a, b) => a.turn - b.turn);

		// live side data
		for (const sideId of ['p1', 'p2']) {
			const side = battle[sideId];
			if (!side) continue;
			data.sides[sideId] = {
				name        : side.name,
				pokemonLeft : side.pokemonLeft,
				requestState: side.requestState,
				choiceDone  : side.isChoiceDone(),
				active      : side.active.filter(p => p)
					.map(p => this._serializePokemon(p, side)),
				bench       : side.pokemon.filter(p => !p.isActive && !p.fainted)
					.map(p => this._serializePokemon(p, side)),
				fainted     : side.pokemon.filter(p => p.fainted).map(p => ({
					name      : p.name,
					species   : p.species.name,
					speciesId : p.species.id,
					teamIndex : side.pokemon.indexOf(p) + 1,
				})),
			};
		}

		data.log = timeline.rawLogs.slice(-100);
		return data;
	}

	_serializePokemon(pokemon, side) {
		return {
			name        : pokemon.name,
			species     : pokemon.species.name,
			speciesId   : pokemon.species.id,
			level       : pokemon.level,
			gender      : pokemon.gender,
			hp          : pokemon.hp,
			maxhp       : pokemon.maxhp,
			hpPct       : pokemon.maxhp > 0
				? Math.round((pokemon.hp / pokemon.maxhp) * 100) : 0,
			status      : pokemon.status || '',
			fainted     : pokemon.fainted,
			isActive    : pokemon.isActive,
			boosts      : { ...pokemon.boosts },
			item        : pokemon.item,
			itemName    : pokemon.item ? Dex.items.get(pokemon.item).name : '',
			ability     : pokemon.ability,
			abilityName : Dex.abilities.get(pokemon.ability).name,
			types       : pokemon.types,
			volatiles   : Object.keys(pokemon.volatiles),
			teamIndex   : side.pokemon.indexOf(pokemon) + 1,
			moves       : pokemon.moveSlots.map(m => {
				const md = Dex.moves.get(m.id);
				return {
					id       : m.id,
					name     : m.move,
					pp       : m.pp,
					maxpp    : m.maxpp,
					disabled : !!m.disabled,
					type     : md.type || 'Normal',
					category : md.category,
					basePower: md.basePower,
				};
			}),
		};
	}

	/**
	 * State for a single timeline, optionally hiding opponent
	 * internals.  Replaces the old /api/battle-state route logic.
	 */
	getBattleState(globalId, playerSide) {
		const parsed = this.parseGlobalId(globalId);
		if (!parsed) return { error: 'Battle not found' };

		const full = this._serializeTimeline(parsed.timeline);

		const out = {
			...full,
			playerSide  : playerSide || null,
			isSpectator : !playerSide,
			sides       : {},
		};

		for (const sideId of ['p1', 'p2']) {
			const sd = full.sides[sideId];
			if (!sd) continue;
			const isOwn = playerSide === sideId;

			out.sides[sideId] = {
				...sd,
				active: sd.active.map(p => ({
					...p,
					moves: isOwn ? p.moves : p.moves.map(() => ({
						id: '???', name: '???', pp: '?', maxpp: '?',
						disabled: false, type: 'Normal', category: 'Physical', basePower: 0,
					})),
					item     : isOwn ? p.item     : (p.item ? 'unknown'      : ''),
					itemName : isOwn ? p.itemName : (p.item ? 'Unknown Item' : ''),
				})),
				bench: isOwn ? sd.bench : sd.bench.map(p => ({
					name: p.name, species: p.species, speciesId: p.speciesId,
					level: p.level, hp: p.hp, maxhp: p.maxhp,
					hpPct: p.hpPct, status: p.status, fainted: p.fainted,
					moves: [], item: '', itemName: '', ability: '', abilityName: '',
				})),
			};
		}
		return out;
	}

	// ── cleanup ─────────────────────────────────────────────
	destroyAll() {
		for (const match of this.matches.values())
			for (const tl of match.timelines.values())
				if (tl.battle) tl.battle.destroy();
		this.matches.clear();
	}
}

module.exports = { MultiBattleManager };