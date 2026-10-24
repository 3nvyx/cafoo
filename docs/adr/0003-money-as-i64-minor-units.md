# Money is stored as 64-bit integers in minor units

SpacetimeDB has no decimal type, and floating point is unacceptable for a ledger, so every amount is an i64 of minor units (cents, pence) and every FX rate is an i64 scaled by 1e6. The pure accounting engine uses bigint throughout and rounds deterministically (remainders go to the last period of a schedule), so the module, the tests, and the agents compute identical results.
