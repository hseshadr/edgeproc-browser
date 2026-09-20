import { describe, expect, it } from "vitest";
import {
	cacheDatabaseName,
	runWithCacheLock,
	validatedNamespace,
} from "./cacheLock.js";

describe("consumer cache namespace", () => {
	it("uses stable default database and Web Lock names", async () => {
		const names: string[] = [];
		const request = <T>(
			name: string,
			operation: () => Promise<T>,
		): Promise<T> => {
			names.push(name);
			return operation();
		};
		await expect(
			runWithCacheLock({ request }, () => Promise.resolve(7)),
		).resolves.toBe(7);
		expect(names).toEqual(["edgeproc-browser-sync"]);
		expect(cacheDatabaseName()).toBe("edgeproc-browser-cache");
	});

	it("scopes locks and IndexedDB while rejecting unsafe namespace input", async () => {
		await expect(
			runWithCacheLock(undefined, () => Promise.resolve("ok"), "aml-filter"),
		).resolves.toBe("ok");
		expect(cacheDatabaseName("aml-filter")).toBe("aml-filter-cache");
		expect(validatedNamespace("consumer-2")).toBe("consumer-2");
		for (const invalid of ["", "UPPER", "../escape", "a".repeat(64)]) {
			expect(() => validatedNamespace(invalid)).toThrow(TypeError);
		}
	});
});
