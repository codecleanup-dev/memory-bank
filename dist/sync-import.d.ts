export declare function importFromSync(): Promise<{
    newFacts: number;
    newDomains: number;
    newCategories: number;
    newRelations: number;
    /** Peer edges not re-inserted because this machine already judged them away (resolve delete/retype). */
    skippedTombstoned: number;
}>;
