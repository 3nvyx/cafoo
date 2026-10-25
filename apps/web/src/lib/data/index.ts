// The single place the app picks its data source. PUBLIC_DATA_SOURCE=spacetime
// selects the live ledger database; anything else runs Demo mode on the mock.
import { PUBLIC_AGENT_GATEWAY, PUBLIC_DATA_SOURCE, PUBLIC_STDB_DATABASE, PUBLIC_STDB_URI } from '$app/env/public';
import { MockDataSource } from './mock/mock-source.svelte';
import { SpacetimeDataSource } from './spacetime/spacetime-source.svelte';
import type { DataSource } from './source';

export const db: DataSource =
	PUBLIC_DATA_SOURCE === 'spacetime'
		? new SpacetimeDataSource({ uri: PUBLIC_STDB_URI, database: PUBLIC_STDB_DATABASE, gateway: PUBLIC_AGENT_GATEWAY })
		: new MockDataSource();

export type { CfoSeat, DataSet, DataSource, ConnectionState } from './source';
export * from './types';
