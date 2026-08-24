import { createEdgeAIProvider } from './edgeProvider';
import { setAIProvider } from './provider';

/**
 * Chooses the AI implementation, once, at startup.
 *
 * The only place in the app where a provider is named. Everything else calls
 * `getAIProvider()`, so a feature cannot reach a model — or a key — by
 * importing something it should not, and a test can swap the whole boundary
 * with one call.
 */
export function registerAIProvider(): void {
  setAIProvider(createEdgeAIProvider());
}
