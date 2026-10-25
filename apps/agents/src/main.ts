import { agentProvider, agentsLive, FEED_DEBOUNCE_MS, FEED_INTERVAL_MS, providers } from './env';
import { startGateway, type CloseState } from './gateway';
import { startOpenAiBridge } from './live/openai-bridge';
import { Cast } from './stdb';
import { activeCharter } from './charter/active';
import { charterEvalStatus, charterRoutes } from './charter/routes';
import { bootstrapFile, cfoSeated, readBootstrapSecret } from './cfo-seat';
import { startContinuousBookkeeper } from './continuous/bookkeeper';
import { feedRoutes, startFeeder } from './feed/feeder';
import { footprintRoutes } from './footprint-routes';
import { exportRoutes } from './export-routes';

async function main() {
  console.log('providers:');
  for (const p of providers()) console.log(`  ${p.mode.padEnd(4)} ${p.name}: ${p.detail}`);
  if (agentsLive() && agentProvider() === 'openai') {
    const url = await startOpenAiBridge();
    console.log(`OpenAI bridge on ${url} (Anthropic Messages API for the Claude Agent SDK)`);
  }
  const cast = await Cast.connectAll();
  console.log(`connected: advisor ${cast.advisor.hex}, bookkeeper ${cast.bookkeeper.hex}, revenue ${cast.revenue.hex}, credit ${cast.credit.hex}, redteam ${cast.redteam.hex}, consolidation ${cast.consolidation.hex}, feed ${cast.feed.hex}`);
  let liveClose: ((periodYm: string, onStep: (m: string) => void) => Promise<unknown>) | undefined;
  if (agentsLive()) {
    const { runLiveClose } = await import('./live/orchestrator');
    liveClose = (ym, onStep) => runLiveClose(cast, ym, onStep);
  }
  // The live feed and the continuous Bookkeeper that books what it brings; neither runs a month whose close runs here.
  const closes = new Map<string, CloseState>();
  const feeder = startFeeder(cast, { intervalMs: FEED_INTERVAL_MS });
  const bookkeeper = startContinuousBookkeeper(cast, {
    debounceMs: FEED_DEBOUNCE_MS,
    isClosing: ym => closes.get(ym)?.status === 'running',
    params: () => activeCharter(cast.advisor, 'bookkeeper').params,
  });
  startGateway(cast, liveClose, [...feedRoutes(feeder), ...charterRoutes(cast), ...footprintRoutes(cast), ...exportRoutes(cast)], {
    closes,
    // A close starts only once the continuous Bookkeeper's in-flight batch is done.
    beforeClose: () => bookkeeper.idle(),
    status: () => ({ feed: feeder.status(), charterEval: charterEvalStatus() }),
  });
  // A fresh database: the CFO seat waits for the person with the bootstrap secret. The secret itself never goes to the
  // gateway's log; the seed loader printed the link once at setup.
  if (readBootstrapSecret() && !cfoSeated(cast.advisor)) console.log(`CFO seat unclaimed: open the link in ${bootstrapFile()} to claim it.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
