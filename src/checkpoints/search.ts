import type { CheckpointSummaryModel, EntireCheckpointCard, EntireSessionCard, SessionStatus } from "./models";
import { compareOptionalTimestampsDesc } from "./util";

/** Shared search and filter options for normalized checkpoint and session cards. */
export interface SearchFilterOptions {
	query?: string;
	agent?: string;
	status?: SessionStatus | "ALL";
}

/**
 * Filters and sorts checkpoint cards using precomputed `searchText` and status metadata.
 *
 * @param cards Checkpoint cards to filter.
 * @param options Search, agent, and status filters to apply.
 * @returns Filtered checkpoint cards in stable sorted order.
 */
// export function filterCheckpointCards(
// 	cards: Array<EntireCheckpointCard | CheckpointSummaryModel>,
// 	options: SearchFilterOptions = {},
// ): Array<EntireCheckpointCard | CheckpointSummaryModel> {
// 	return sortCheckpointCards(cards).filter((card) => matchesCard(card.displayHash, card.displayHash, card., options));
// }

/**
 * Filters and sorts session cards using precomputed `searchText` and status metadata.
 *
 * @param cards Session cards to filter.
 * @param options Search, agent, and status filters to apply.
 * @returns Filtered session cards in stable sorted order.
 */
export function filterSessionCards(
	cards: EntireSessionCard[],
	options: SearchFilterOptions = {},
): EntireSessionCard[] {
	return sortSessionCards(cards).filter((card) => matchesCard(card.searchText, card.agent, card.status, options));
}

/**
 * Sorts checkpoint cards by newest timestamp, then by display hash for stable ordering.
 *
 * @param cards Checkpoint cards to sort.
 * @returns A new array containing the sorted checkpoint cards.
 */
export function sortCheckpointCards<T extends { timestamp?: string; displayHash: string }>(cards: T[]): T[] {
	return [...cards].sort((left, right) => {
		const timestampComparison = compareOptionalTimestampsDesc(left.timestamp, right.timestamp);
		if (timestampComparison !== 0) {
			return timestampComparison;
		}

		return left.displayHash.localeCompare(right.displayHash);
	});
}

/**
 * Sorts session cards by latest activity, then by session ID for stable ordering.
 *
 * @param cards Session cards to sort.
 * @returns A new array containing the sorted session cards.
 */
export function sortSessionCards(cards: EntireSessionCard[]): EntireSessionCard[] {
	return [...cards].sort((left, right) => {
		const timestampComparison = compareOptionalTimestampsDesc(
			left.lastActivityAt ?? left.createdAt,
			right.lastActivityAt ?? right.createdAt,
		);
		if (timestampComparison !== 0) {
			return timestampComparison;
		}

		return left.sessionId.localeCompare(right.sessionId);
	});
}

function matchesCard(
	searchText: string,
	agent: string | undefined,
	status: SessionStatus,
	options: SearchFilterOptions,
): boolean {
	const query = options.query?.trim().toLowerCase();
	if (query && !searchText.toLowerCase().includes(query)) {
		return false;
	}

	if (options.agent && options.agent !== "ALL" && agent !== options.agent) {
		return false;
	}

	if (options.status && options.status !== "ALL" && status !== options.status) {
		return false;
	}

	return true;
}
