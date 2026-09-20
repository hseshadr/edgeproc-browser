/** One exact cosine result from an immutable packed matrix. */
export interface PackedVectorHit {
	readonly id: string;
	readonly similarity: number;
}

/**
 * Dependency-free synchronous cosine index for signed, immutable matrices.
 *
 * The constructor copies its inputs so a caller cannot mutate authenticated
 * bundle bytes after validation. Ties retain the producer's row order.
 */
export class PackedVectorIndex {
	public readonly dim: number;
	public readonly ntotal: number;
	readonly #matrix: Float32Array;
	readonly #ids: string[];
	readonly #rowById = new Map<string, number>();
	readonly #norms: Float64Array;
	#disposed = false;

	public constructor(
		matrix: Float32Array,
		ids: ReadonlyArray<string>,
		dimension: number,
	) {
		if (!Number.isInteger(dimension) || dimension < 1) {
			throw new RangeError("vector dimension must be an integer >= 1");
		}
		if (matrix.length !== ids.length * dimension) {
			throw new RangeError(
				`packed matrix has ${matrix.length} values; expected ${ids.length * dimension}`,
			);
		}
		this.#matrix = matrix.slice();
		this.#ids = [...ids];
		this.dim = dimension;
		this.ntotal = ids.length;
		this.#norms = new Float64Array(ids.length);
		for (let row = 0; row < ids.length; row += 1) {
			const id = ids[row];
			if (id === undefined || id.length === 0) {
				throw new TypeError("packed vector ids must not be empty");
			}
			if (this.#rowById.has(id)) {
				throw new TypeError(`duplicate packed vector id ${JSON.stringify(id)}`);
			}
			this.#rowById.set(id, row);
			this.#norms[row] = this.#rowNorm(row);
		}
	}

	public search(
		query: Float32Array,
		limit: number,
	): ReadonlyArray<PackedVectorHit> {
		this.#assertOpen();
		this.#assertQuery(query);
		if (!Number.isInteger(limit) || limit < 0) {
			throw new RangeError("search limit must be a non-negative integer");
		}
		if (limit === 0) return [];
		const queryNorm = norm(query, "query");
		return this.#ids
			.map((id, row) => ({
				id,
				row,
				similarity: this.#similarity(row, query, queryNorm),
			}))
			.sort(
				(left, right) =>
					right.similarity - left.similarity || left.row - right.row,
			)
			.slice(0, limit)
			.map(({ id, similarity }) => ({ id, similarity }));
	}

	public similarityOf(id: string, query: Float32Array): number {
		this.#assertOpen();
		this.#assertQuery(query);
		const row = this.#rowById.get(id);
		if (row === undefined) {
			throw new RangeError(
				`packed vector id ${JSON.stringify(id)} is not indexed`,
			);
		}
		return this.#similarity(row, query, norm(query, "query"));
	}

	public idAt(row: number): string {
		this.#assertOpen();
		this.#assertRow(row);
		return this.#ids[row] ?? "";
	}

	/** Return one producer row as a defensive copy. */
	public vectorAt(row: number): Float32Array {
		this.#assertOpen();
		this.#assertRow(row);
		const start = row * this.dim;
		return this.#matrix.slice(start, start + this.dim);
	}

	public dispose(): void {
		if (this.#disposed) return;
		this.#matrix.fill(0);
		this.#norms.fill(0);
		this.#rowById.clear();
		this.#disposed = true;
	}

	#rowNorm(row: number): number {
		let sum = 0;
		const start = row * this.dim;
		for (let offset = 0; offset < this.dim; offset += 1) {
			const value = this.#matrix[start + offset] ?? 0;
			if (!Number.isFinite(value)) {
				throw new TypeError(
					`packed matrix row ${row} contains a non-finite value`,
				);
			}
			sum += value * value;
		}
		return Math.sqrt(sum);
	}

	#similarity(row: number, query: Float32Array, queryNorm: number): number {
		const rowNorm = this.#norms[row] ?? 0;
		if (rowNorm === 0 || queryNorm === 0) return 0;
		let dot = 0;
		const start = row * this.dim;
		for (let offset = 0; offset < this.dim; offset += 1) {
			dot += (this.#matrix[start + offset] ?? 0) * (query[offset] ?? 0);
		}
		return Math.max(-1, Math.min(1, dot / (rowNorm * queryNorm)));
	}

	#assertQuery(query: Float32Array): void {
		if (query.length !== this.dim) {
			throw new RangeError(
				`query has dimension ${query.length}; expected ${this.dim}`,
			);
		}
		norm(query, "query");
	}

	#assertOpen(): void {
		if (this.#disposed) throw new Error("packed vector index is disposed");
	}

	#assertRow(row: number): void {
		if (!Number.isInteger(row) || row < 0 || row >= this.ntotal) {
			throw new RangeError(`packed vector row ${row} is out of bounds`);
		}
	}
}

function norm(vector: Float32Array, label: string): number {
	let sum = 0;
	for (const value of vector) {
		if (!Number.isFinite(value)) {
			throw new TypeError(`${label} contains a non-finite value`);
		}
		sum += value * value;
	}
	return Math.sqrt(sum);
}
