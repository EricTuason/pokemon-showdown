/**
 * Match – an independent game; owns all its timelines
 */

const { Timeline } = require('./Timeline');

class Match {
	/**
	 * @param {string} id             short random hex id
	 * @param {string} formatid       e.g. 'gen9ou'
	 * @param {{ p1: { name, team }, p2: { name, team } }} originalTeams
	 */
	constructor(id, formatid, originalTeams) {
		this.id              = id;
		this.formatid        = formatid;
		this.originalTeams   = originalTeams;   // stored once; never mutated
		this.timelines       = new Map();       // num → Timeline
		this.nextTimelineNum = 1;
	}

	/**
	 * Allocate the next Timeline shell.  Does NOT create a Battle —
	 * that is the manager's job so it can wire the log callback.
	 */
	allocTimeline(parentNum = null, fromTurn = null) {
		const num = this.nextTimelineNum++;
		const tl  = new Timeline(this, num, parentNum, fromTurn);
		this.timelines.set(num, tl);
		return tl;
	}
}

module.exports = { Match };