import Database from 'better-sqlite3';
import { ConversationExchange } from './types.js';
export type VecDtype = 'float32' | 'int8';
export declare const VEC_INT8_SCALE = 127;
/**
 * Authoritative vector dtype for vec_exchanges.
 *
 * Derived from the ACTUAL table schema in sqlite_master — not a metadata flag.
 * A flag can diverge from the real schema (missing/corrupt flag on an int8
 * table would silently send float32 params against int8 storage); parsing the
 * declared column type cannot. Absent table ⇒ 'int8' (that is what
 * initDatabase creates for fresh DBs).
 */
export declare function getVecDtype(db: Database.Database): VecDtype;
/** Convert a float embedding to the blob matching the table dtype. */
export declare function embeddingToVecBlob(embedding: number[], dtype: VecDtype): Buffer;
/** SQL placeholder for a vec_exchanges MATCH/INSERT param under the dtype. */
export declare function vecParamSql(dtype: VecDtype): string;
/** Normalize a vec KNN distance back to float32 scale (int8 distances are ×127). */
export declare function normalizeVecDistance(distance: number, dtype: VecDtype): number;
export declare function migrateSchema(db: Database.Database): void;
export declare function migrateRelationTypeVocabulary(db: Database.Database): void;
export declare function migrateFactsCategoryVocabulary(db: Database.Database): void;
export declare function initDatabase(): Database.Database;
export declare function insertExchange(db: Database.Database, exchange: ConversationExchange, embedding: number[], _toolNames?: string[]): void;
export declare function getAllExchanges(db: Database.Database): Array<{
    id: string;
    archivePath: string;
}>;
export declare function getFileLastIndexed(db: Database.Database, archivePath: string): number | null;
export declare function deleteExchange(db: Database.Database, id: string): void;
