import { defineEnvVars } from '@sveltejs/kit/env';

const orDefault = (fallback: string) => (v: string | undefined) => (v && v.trim() ? v.trim() : fallback);

export const variables = defineEnvVars({
	PUBLIC_DATA_SOURCE: {
		public: true,
		static: true,
		description: "'spacetime' talks to the live ledger database; anything else runs Demo mode on the in-browser mock.",
		schema: (v: string | undefined) => (v === 'spacetime' ? 'spacetime' : 'mock')
	},
	PUBLIC_STDB_URI: { public: true, static: true, description: 'Ledger database websocket URI.', schema: orDefault('ws://localhost:3000') },
	PUBLIC_STDB_DATABASE: { public: true, static: true, description: 'Ledger database name.', schema: orDefault('cafoo') },
	PUBLIC_AGENT_GATEWAY: { public: true, static: true, description: 'Agent gateway base URL (POST /close starts a close).', schema: orDefault('http://localhost:8787') }
});
