import type {
	Metadata,
	Scalar,
	VectorHit,
	VectorIndex,
	VectorIndexCapabilities,
	VectorIndexOptions,
	VectorRecord,
	VectorStats,
} from "./types.js";

interface StoredRecord {
	readonly id: string;
	readonly vector: Float32Array;
	readonly metadata: Metadata;
	readonly norm: number;
}

const CAPABILITIES: VectorIndexCapabilities = Object.freeze({
	metrics: Object.freeze(["cosine"] as const),
	exact: true,
	persistent: false,
	metadataFiltering: true,
	scopedDelete: true,
});

/** Dependency-free, exact cosine-distance index for bounded browser datasets. */
export class FlatVectorIndex implements VectorIndex {
	public readonly name: string;
	public readonly dimension: number;
	public readonly capabilities = CAPABILITIES;
	readonly #records = new Map<string, StoredRecord>();
	#disposed = false;

	public constructor(options: VectorIndexOptions) {
		if (!Number.isInteger(options.dimension) || options.dimension < 1) {
			throw new RangeError("vector dimension must be an integer >= 1");
		}
		if (options.name.length === 0) {
			throw new TypeError("vector index name must not be empty");
		}
		this.name = options.name;
		this.dimension = options.dimension;
	}

	public async insert(records: ReadonlyArray<VectorRecord>): Promise<void> {
		this.#assertOpen();
		// Validate and copy the full batch before publishing any row. A bad final
		// vector therefore cannot leave a partially applied insert behind.
		const accepted = records.map((record) => this.#copyForStorage(record));
		for (const record of accepted) {
			this.#records.set(record.id, record);
		}
	}

	public async read(id: string): Promise<VectorRecord | undefined> {
		this.#assertOpen();
		const record = this.#records.get(id);
		return record === undefined ? undefined : publicRecord(record);
	}

	public async search(
		query: Float32Array,
		limit: number,
		filters?: Metadata,
	): Promise<ReadonlyArray<VectorHit>> {
		this.#assertOpen();
		this.#assertVector(query, "query");
		if (!Number.isInteger(limit) || limit < 0) {
			throw new RangeError("search limit must be a non-negative integer");
		}
		validateMetadata(filters, "filters");
		if (limit === 0) {
			return [];
		}

		const queryNorm = l2Norm(query);
		const hits: VectorHit[] = [];
		for (const record of this.#records.values()) {
			if (!matches(record.metadata, filters)) {
				continue;
			}
			hits.push({
				id: record.id,
				distance: cosineDistance(query, queryNorm, record),
				metadata: { ...record.metadata },
			});
		}
		hits.sort(
			(a, b) => a.distance - b.distance || compareCodeUnits(a.id, b.id),
		);
		return hits.slice(0, limit);
	}

	public async searchByIds(
		query: Float32Array,
		ids: ReadonlyArray<string>,
	): Promise<ReadonlyArray<VectorHit>> {
		this.#assertOpen();
		this.#assertVector(query, "query");
		const unique = uniqueIds(ids);
		if (unique.length === 0) {
			return [];
		}
		const queryNorm = l2Norm(query);
		const hits: VectorHit[] = [];
		for (const id of unique) {
			const record = this.#records.get(id);
			if (record !== undefined) {
				hits.push({
					id: record.id,
					distance: cosineDistance(query, queryNorm, record),
					metadata: { ...record.metadata },
				});
			}
		}
		hits.sort(
			(a, b) => a.distance - b.distance || compareCodeUnits(a.id, b.id),
		);
		return hits;
	}

	public async delete(
		ids: ReadonlyArray<string>,
		filters?: Metadata,
	): Promise<number> {
		this.#assertOpen();
		validateMetadata(filters, "filters");
		let deleted = 0;
		for (const id of new Set(ids)) {
			const record = this.#records.get(id);
			if (record !== undefined && matches(record.metadata, filters)) {
				this.#records.delete(id);
				deleted += 1;
			}
		}
		return deleted;
	}

	public async deleteWhere(filters: Metadata): Promise<number> {
		this.#assertOpen();
		validateRequiredMetadata(filters, "filters");
		let deleted = 0;
		for (const [id, record] of this.#records) {
			if (matches(record.metadata, filters)) {
				this.#records.delete(id);
				deleted += 1;
			}
		}
		return deleted;
	}

	public async clear(): Promise<number> {
		this.#assertOpen();
		const deleted = this.#records.size;
		this.#records.clear();
		return deleted;
	}

	public async stats(filters?: Metadata): Promise<VectorStats> {
		this.#assertOpen();
		validateMetadata(filters, "filters");
		let vectorCount = 0;
		for (const record of this.#records.values()) {
			if (matches(record.metadata, filters)) {
				vectorCount += 1;
			}
		}
		return {
			name: this.name,
			dimension: this.dimension,
			vectorCount,
			vectorBytes:
				vectorCount * this.dimension * Float32Array.BYTES_PER_ELEMENT,
		};
	}

	public async dispose(): Promise<void> {
		if (this.#disposed) {
			return;
		}
		this.#records.clear();
		this.#disposed = true;
	}

	#copyForStorage(record: VectorRecord): StoredRecord {
		if (record.id.length === 0) {
			throw new TypeError("vector record id must not be empty");
		}
		this.#assertVector(record.vector, `record ${JSON.stringify(record.id)}`);
		validateMetadata(
			record.metadata,
			`record ${JSON.stringify(record.id)} metadata`,
		);
		const vector = record.vector.slice();
		return {
			id: record.id,
			vector,
			metadata: { ...record.metadata },
			norm: l2Norm(vector),
		};
	}

	#assertVector(vector: Float32Array, at: string): void {
		if (vector.length !== this.dimension) {
			throw new RangeError(
				`${at} has dimension ${vector.length}; expected ${this.dimension}`,
			);
		}
		for (const value of vector) {
			if (!Number.isFinite(value)) {
				throw new TypeError(`${at} contains a non-finite value`);
			}
		}
	}

	#assertOpen(): void {
		if (this.#disposed) {
			throw new Error(`vector index ${JSON.stringify(this.name)} is disposed`);
		}
	}
}

function publicRecord(record: StoredRecord): VectorRecord {
	return {
		id: record.id,
		vector: record.vector.slice(),
		metadata: { ...record.metadata },
	};
}

function validateMetadata(metadata: Metadata | undefined, at: string): void {
	if (metadata === undefined) {
		return;
	}
	for (const [key, value] of Object.entries(metadata)) {
		if (key.length === 0) {
			throw new TypeError(`${at} contains an empty key`);
		}
		if (
			value !== null &&
			typeof value !== "string" &&
			typeof value !== "number" &&
			typeof value !== "boolean"
		) {
			throw new TypeError(`${at}.${key} must be a scalar value`);
		}
		if (typeof value === "number" && !Number.isFinite(value)) {
			throw new TypeError(`${at}.${key} must be finite`);
		}
	}
}

function validateRequiredMetadata(metadata: Metadata, at: string): void {
	validateMetadata(metadata, at);
	if (Object.keys(metadata).length === 0) {
		throw new TypeError(`${at} must contain at least one filter`);
	}
}

function uniqueIds(ids: ReadonlyArray<string>): ReadonlyArray<string> {
	const unique = new Set<string>();
	for (const id of ids) {
		if (typeof id !== "string" || id.length === 0) {
			throw new TypeError("vector record id must not be empty");
		}
		unique.add(id);
	}
	return [...unique];
}

function matches(metadata: Metadata, filters: Metadata | undefined): boolean {
	if (filters === undefined || Object.keys(filters).length === 0) {
		return true;
	}
	return Object.entries(filters).every(
		([key, value]) => metadata[key] === (value as Scalar),
	);
}

function l2Norm(vector: Float32Array): number {
	let sumSquares = 0;
	for (const value of vector) {
		sumSquares += value * value;
	}
	return Math.sqrt(sumSquares);
}

function cosineDistance(
	query: Float32Array,
	queryNorm: number,
	record: StoredRecord,
): number {
	if (queryNorm === 0 || record.norm === 0) {
		return 1;
	}
	let dot = 0;
	for (let i = 0; i < query.length; i += 1) {
		dot += (query[i] ?? 0) * (record.vector[i] ?? 0);
	}
	const similarity = Math.max(-1, Math.min(1, dot / (queryNorm * record.norm)));
	return 1 - similarity;
}

function compareCodeUnits(left: string, right: string): number {
	if (left === right) {
		return 0;
	}
	return left < right ? -1 : 1;
}
