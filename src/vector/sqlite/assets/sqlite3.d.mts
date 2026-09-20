interface SqliteOo1Database {
	exec(options: { sql: string; bind?: unknown[] }): unknown;
	selectObjects(sql: string, bind?: unknown[]): Array<Record<string, unknown>>;
	transaction<T>(callback: () => T): T;
	close(): void;
}

interface SqliteSahPool {
	readonly OpfsSAHPoolDb: new (filename: string) => SqliteOo1Database;
}

interface SqliteModule {
	readonly oo1: {
		readonly DB: new (filename: string) => SqliteOo1Database;
	};
	installOpfsSAHPoolVfs(options: {
		name: string;
		forceReinitIfPreviouslyFailed?: boolean;
	}): Promise<SqliteSahPool>;
}

export default function sqlite3InitModule(options?: {
	locateFile?: (filename: string) => string;
	print?: (...args: unknown[]) => void;
	printErr?: (...args: unknown[]) => void;
	wasmBinary?: Uint8Array;
}): Promise<SqliteModule>;
