/**
 * Timeline – one branch inside a Match
 */

class Timeline {
	/**
	 * @param {Match}       match      owning Match
	 * @param {number}      num        1-based index, local to match
	 * @param {number|null} parentNum  num of the timeline this branched from
	 * @param {number|null} fromTurn   turn in the parent at the branch point
	 */
	constructor(match, num, parentNum, fromTurn) {
		this.match            = match;
		this.num              = num;
		this.parentNum        = parentNum;
		this.fromTurn         = fromTurn;
		this.createdAt        = Date.now();

		// set by the manager after construction
		this.battle           = null;            // Battle instance

		this.snapshots        = new Map();       // turn  → snapshot
		this.rawLogs          = [];              // raw protocol lines
		this.pendingTransfers = { p1: null, p2: null };
	}

	/** Opaque string used in every API call that references this timeline. */
	get globalId() { return `${this.match.id}:${this.num}`; }
}

module.exports = { Timeline };