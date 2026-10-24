import { agentsLive, providers } from './env';
import { startGateway } from './gateway';
import { Cast } from './stdb';

async function main() {
  console.log('providers:');
  for (const p of providers()) console.log(`  ${p.mode.padEnd(4)} ${p.name}: ${p.detail}`);
  const cast = await Cast.connectAll();
  console.log(`connected: advisor ${cast.advisor.hex}, bookkeeper ${cast.bookkeeper.hex}, revenue ${cast.revenue.hex}, credit ${cast.credit.hex}, redteam ${cast.redteam.hex}`);
  let liveClose: ((periodYm: string, onStep: (m: string) => void) => Promise<unknown>) | undefined;
  if (agentsLive()) {
    const { runLiveClose } = await import('./live/orchestrator');
    liveClose = (ym, onStep) => runLiveClose(cast, ym, onStep);
  }
  startGateway(cast, liveClose);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
