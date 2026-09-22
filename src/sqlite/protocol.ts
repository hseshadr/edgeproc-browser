import type {
	SqliteStateBatchOptions,
	SqliteStateListOptions,
	SqliteStateMigration,
	SqliteStateMutation,
	SqliteStateStoreOptions,
} from "./database.js";

export type SqliteStateWorkerRequest =
	| {
			readonly id: number;
			readonly operation: "initialize";
			readonly options: SqliteStateStoreOptions;
	  }
	| {
			readonly id: number;
			readonly operation: "get";
			readonly namespace: string;
			readonly key: string;
	  }
	| {
			readonly id: number;
			readonly operation: "list";
			readonly options: SqliteStateListOptions;
	  }
	| {
			readonly id: number;
			readonly operation: "batch";
			readonly mutations: ReadonlyArray<SqliteStateMutation>;
			readonly options: SqliteStateBatchOptions;
	  }
	| {
			readonly id: number;
			readonly operation: "migrate";
			readonly migration: SqliteStateMigration;
	  }
	| { readonly id: number; readonly operation: "integrity-check" }
	| { readonly id: number; readonly operation: "export" }
	| {
			readonly id: number;
			readonly operation: "stage-import";
			readonly bytes: Uint8Array;
	  }
	| {
			readonly id: number;
			readonly operation: "discard-import";
			readonly stageId: string;
	  }
	| {
			readonly id: number;
			readonly operation: "commit-import";
			readonly stageId: string;
			readonly options: SqliteStateBatchOptions;
	  }
	| {
			readonly id: number;
			readonly operation: "reset";
			readonly options: SqliteStateBatchOptions;
	  }
	| { readonly id: number; readonly operation: "runtime-info" }
	| { readonly id: number; readonly operation: "dispose" };

export type SqliteStateWorkerResponse =
	| { readonly id: number; readonly ok: true; readonly value: unknown }
	| {
			readonly id: number;
			readonly ok: false;
			readonly error: { readonly name: string; readonly message: string };
	  };
